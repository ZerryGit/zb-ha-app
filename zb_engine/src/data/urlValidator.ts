/**
 * urlValidator.ts — Shared RFC1918 + domain allowlist URL validation
 *
 * Used by both sourceFetcher.ts (for HTTP sources) and
 * assetLimits.ts (for img/svg element URLs) to prevent SSRF attacks.
 *
 * Covers ALL private/reserved IP representations:
 *   - Standard dotted-decimal private and special-use IPv4 ranges
 *   - Decimal notation (http://2130706433 = 127.0.0.1)
 *   - Hexadecimal (http://0x7f000001)
 *   - Octal (http://0177.0.0.1)
 *   - IPv6 unspecified (::), loopback (::1), link-local, ULA, multicast
 *   - IPv6-mapped IPv4 (::ffff:127.0.0.1)
 *   - DNS rebinding (best-effort): hostname resolved at validation time and the
 *     resolved IP checked. The fetch re-resolves independently, so a residual
 *     TOCTOU window remains (see SECURITY.md) — this is not a complete fix.
 *
 * OPERATOR EXEMPTION (`allow_private_hosts`): an add-on operator — never a panel
 * user — may list specific LAN addresses the add-on is permitted to fetch from.
 * A caller opts in per call site via `{ allowPrivateHosts: true }`; without it the
 * behavior above is unchanged. The exemption deliberately does NOT cover:
 *   - redirect targets (a Location header is authored by the remote host)
 *   - hostnames — only bare IPv4 literals, so there is no name left to rebind
 *   - loopback, link-local, and every other special-use range outside the four
 *     listed in EXEMPTABLE_PRIVATE_IPV4_RANGES, whatever the operator writes
 */

import * as dns from "dns";
import { DNS_LOOKUP_TIMEOUT_MS } from "../limits";
import { logInfo } from "../core/logger";

/** Opt-in, per call site, to the operator's `allow_private_hosts` allowlist. */
export interface UrlValidationOptions {
  allowPrivateHosts?: boolean;
}

// ── Special-use IP helpers ─────────────────────────────────────

const SPECIAL_USE_IPV4_RANGES = [
  { base: 0x00000000, mask: 0xff000000 }, // 0.0.0.0/8
  { base: 0x0a000000, mask: 0xff000000 }, // 10.0.0.0/8
  { base: 0x64400000, mask: 0xffc00000 }, // 100.64.0.0/10
  { base: 0x7f000000, mask: 0xff000000 }, // 127.0.0.0/8
  { base: 0xa9fe0000, mask: 0xffff0000 }, // 169.254.0.0/16
  { base: 0xac100000, mask: 0xfff00000 }, // 172.16.0.0/12
  { base: 0xc0000000, mask: 0xffffff00 }, // 192.0.0.0/24
  { base: 0xc0000200, mask: 0xffffff00 }, // 192.0.2.0/24
  { base: 0xc0586300, mask: 0xffffff00 }, // 192.88.99.0/24
  { base: 0xc0a80000, mask: 0xffff0000 }, // 192.168.0.0/16
  { base: 0xc6120000, mask: 0xfffe0000 }, // 198.18.0.0/15
  { base: 0xc6336400, mask: 0xffffff00 }, // 198.51.100.0/24
  { base: 0xcb007100, mask: 0xffffff00 }, // 203.0.113.0/24
  { base: 0xe0000000, mask: 0xf0000000 }, // 224.0.0.0/4
  { base: 0xf0000000, mask: 0xf0000000 }, // 240.0.0.0/4
  { base: 0xffffffff, mask: 0xffffffff }, // 255.255.255.255/32
] as const;

/**
 * The only ranges `allow_private_hosts` may ever exempt. Everything else in
 * SPECIAL_USE_IPV4_RANGES stays blocked no matter what the operator lists —
 * loopback because port 8000 is local (a render that triggers a render), and
 * link-local because it carries the cloud metadata endpoint.
 */
const EXEMPTABLE_PRIVATE_IPV4_RANGES = [
  { base: 0x0a000000, mask: 0xff000000 }, // 10.0.0.0/8
  { base: 0x64400000, mask: 0xffc00000 }, // 100.64.0.0/10 (CGNAT — Tailscale)
  { base: 0xac100000, mask: 0xfff00000 }, // 172.16.0.0/12
  { base: 0xc0a80000, mask: 0xffff0000 }, // 192.168.0.0/16
] as const;

/**
 * Broadest block an entry may declare. A `/12` would hand over the whole Docker
 * bridge range — which is how the add-on reaches the Supervisor and every
 * sibling add-on by IP — so the operator must name their actual subnet.
 */
const PRIVATE_HOST_MIN_PREFIX = 24;

let blockedHostnames = ["localhost"];

// ── Shared security config ─────────────────────────────────────

let allowedDomains: string[] = [];

interface PrivateHostEntry {
  base: number;
  mask: number;
  /** Normalized text, as reported back to the operator in `accepted`. */
  text: string;
  /**
   * 1-based position in the operator's CONFIGURED list — not in this array.
   * Accepted entries are compacted here, so the two diverge as soon as one
   * entry is rejected or blank; logging the array position would make the
   * "permitted" and "dropped" records point at different rows.
   */
  index: number;
}

let privateHostEntries: PrivateHostEntry[] = [];

/**
 * The operator's list verbatim, kept so `getUrlValidatorConfig()` can hand the
 * render worker the same input the main thread parsed. Snapshotting the
 * ACCEPTED texts instead would renumber every entry in the worker, because the
 * rejected rows would be gone — see getUrlValidatorConfig.
 */
let privateHostRawEntries: string[] = [];

/** Every allowlist this module holds, in the form the `configure*` functions take. */
export interface UrlValidatorConfig {
  allowedDomains: string[];
  privateHosts: string[];
  blockedHostnames: string[];
}

/**
 * Outcome of the `allow_private_hosts` list, for the caller to log (D7/D8).
 *
 * A rejection carries the entry's 1-based position in the operator's list, not
 * its text: `core/logger` rewrites every dotted quad to `[redacted-ip]`, so an
 * echoed entry reaches the log as advice nobody can act on. Reason strings are
 * written to survive that redaction for the same reason.
 */
export interface PrivateHostConfigResult {
  accepted: string[];
  /**
   * Configured-list positions of the `accepted` entries, same order. Lets the
   * startup record name the rows that survived, so it reconciles with both the
   * `dropped` warnings and the per-fetch `permitted` lines — all three speak
   * the operator's list, never an internal array position.
   */
  acceptedIndices: number[];
  rejected: { index: number; reason: string }[];
}

/**
 * Configure the shared URL validator.
 * Called once from index.ts on startup after loading add-on options.
 *
 * Entries are normalized — lowercased, trimmed, and stripped of leading/
 * trailing dots — and empties are dropped. This prevents malformed entries
 * (e.g. `".Example.com."`, `""`) from silently widening or breaking the
 * allowlist match. NOTE: an empty resulting list means **allow-all** (no
 * allowlist enforcement); callers should surface that prominently.
 */
export function configureUrlValidator(domains: string[]): void {
  allowedDomains = (Array.isArray(domains) ? domains : [])
    .map((d) => d.toLowerCase().trim().replace(/^\.+/, "").replace(/\.+$/, ""))
    .filter((d) => d.length > 0);
}

/**
 * Configure the operator's `allow_private_hosts` allowlist.
 * Called once from index.ts on startup, alongside configureUrlValidator().
 *
 * Entries are normalized the same way — trimmed, lowercased, empties dropped —
 * then parsed as a canonical dotted-quad IPv4 address (treated as /32) or an
 * IPv4 CIDR with a /24–/32 prefix. An unparseable entry, or one naming a range
 * that may never be exempted, is DISCARDED rather than fatal: one bad line must
 * not stop the add-on, and a dropped entry grants nothing. The caller logs the
 * returned outcome.
 */
export function configurePrivateHosts(entries: string[]): PrivateHostConfigResult {
  const result: PrivateHostConfigResult = { accepted: [], acceptedIndices: [], rejected: [] };
  const parsed: PrivateHostEntry[] = [];
  const list = Array.isArray(entries) ? entries : [];

  for (let i = 0; i < list.length; i++) {
    const text = String(list[i]).toLowerCase().trim();
    if (text.length === 0) continue;

    const outcome = parsePrivateHostEntry(text);
    if ("reason" in outcome) {
      // 1-based position in the operator's configured list, so the warning
      // points at a line they can find.
      result.rejected.push({ index: i + 1, reason: outcome.reason });
      continue;
    }
    // Same coordinate system as the rejections above: the operator's own list.
    parsed.push({ ...outcome.entry, index: i + 1 });
    result.accepted.push(outcome.entry.text);
    result.acceptedIndices.push(i + 1);
  }

  privateHostEntries = parsed;
  privateHostRawEntries = list.map((raw) => String(raw));
  return result;
}

/**
 * Configure platform-specific blocked hostnames.
 * Merges the adapter-provided list with the core defaults, normalizes to
 * lowercase, and deduplicates.
 */
export function configureBlockedHostnames(hostnames: string[]): void {
  const merged = new Set([
    "localhost",
    ...(Array.isArray(hostnames) ? hostnames : []).map((h) => h.toLowerCase()),
  ]);
  blockedHostnames = [...merged];
}

/**
 * Snapshot every configured allowlist, in the form the `configure*` functions
 * accept. A `worker_thread` gets its own module registry, so the render
 * worker's copy of this module starts empty and has to be configured from the
 * main thread's snapshot at spawn — see renderWorker.ts.
 *
 * Returns copies: mutating the result must not reach the validator.
 */
export function getUrlValidatorConfig(): UrlValidatorConfig {
  return {
    allowedDomains: [...allowedDomains],
    // The operator's list VERBATIM, rejected rows included — not the accepted
    // texts. The worker re-parses this, and an entry's audit index is its
    // position in the list it was parsed from: hand over the filtered list and
    // the worker renumbers from 1, so the same address is reported as a
    // different rule on the main thread and in the worker. Passing the raw list
    // makes the worker's state provably identical to this one's; re-parsing the
    // rejects is cheap and their outcome is discarded there.
    privateHosts: [...privateHostRawEntries],
    blockedHostnames: [...blockedHostnames],
  };
}

function isSpecialUseIpv4Numeric(ip: number): boolean {
  if (!Number.isInteger(ip) || ip < 0 || ip > 0xffffffff) return false;
  return SPECIAL_USE_IPV4_RANGES.some(
    ({ base, mask }) => ((ip & mask) >>> 0) === base,
  );
}

function dottedIpv4ToNumeric(hostname: string): number | null {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return null;
  const octets = hostname.split(".").map((part) => Number(part));
  if (!octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    return null;
  }
  return (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);
}

function dottedIpv4WithOctalToNumeric(hostname: string): number | null {
  if (!/^\d+(\.\d+){0,3}$/.test(hostname) || !/^0\d/.test(hostname)) return null;
  const octets = hostname.split(".").map((part) => (
    part.startsWith("0") && part.length > 1 ? parseInt(part, 8) : parseInt(part, 10)
  ));
  if (octets.length !== 4) return null;
  if (!octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    return null;
  }
  return (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);
}

function isExemptablePrivateIpv4(ip: number): boolean {
  return EXEMPTABLE_PRIVATE_IPV4_RANGES.some(
    ({ base, mask }) => ((ip & mask) >>> 0) === base,
  );
}

/**
 * Reject alternate spellings of an address (decimal, hex, octal, short forms,
 * trailing dot) in what the OPERATOR writes, so an entry means exactly one
 * thing. Incoming URLs are still checked in every spelling.
 */
function isCanonicalDottedQuad(text: string): boolean {
  const parts = text.split(".");
  if (parts.length !== 4) return false;
  return parts.every(
    (part) => /^\d{1,3}$/.test(part) && String(Number(part)) === part && Number(part) <= 255,
  );
}

/**
 * Parse one entry. Returns the entry WITHOUT its `index` — the parser sees only
 * the text, so the caller stamps the operator's list position on it.
 */
function parsePrivateHostEntry(
  text: string,
): { entry: Omit<PrivateHostEntry, "index"> } | { reason: string } {
  const [address, prefixText, ...extra] = text.split("/");
  if (extra.length > 0) return { reason: "malformed CIDR" };
  if (!isCanonicalDottedQuad(address)) {
    return { reason: "not a canonical dotted-quad IPv4 address" };
  }

  let prefix = 32;
  if (prefixText !== undefined) {
    if (!/^\d{1,2}$/.test(prefixText)) return { reason: "malformed CIDR prefix" };
    prefix = Number(prefixText);
    if (prefix < PRIVATE_HOST_MIN_PREFIX || prefix > 32) {
      // Reason strings avoid dotted quads and " /nn" tokens — the logger
      // rewrites both, and a mangled reason helps nobody.
      return { reason: `prefix must be between ${PRIVATE_HOST_MIN_PREFIX} and 32` };
    }
  }

  const ip = dottedIpv4ToNumeric(address);
  if (ip === null) return { reason: "not a canonical dotted-quad IPv4 address" };

  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const base = (ip & mask) >>> 0;
  const broadcast = (base | (~mask >>> 0)) >>> 0;

  // A CIDR with host bits set is ambiguous — "the host .5" or "the subnet
  // holding .5"? Those differ by 256 addresses, so make the operator say which
  // rather than guessing the wider one.
  if (base !== ip) {
    return {
      reason: "host bits set — use the network address, or prefix 32 for a single host",
    };
  }

  // Both ends, so a block can never straddle out of an exemptable range.
  if (!isExemptablePrivateIpv4(base) || !isExemptablePrivateIpv4(broadcast)) {
    return {
      // Ranges written without a fourth octet so the logger leaves them intact.
      reason:
        "outside the private ranges that may be exempted (10/8, 100.64/10, 172.16/12, 192.168/16)",
    };
  }

  const dotted = numericToDottedIpv4(base);
  return { entry: { base, mask, text: prefix === 32 ? dotted : `${dotted}/${prefix}` } };
}

function numericToDottedIpv4(ip: number): string {
  return [(ip >>> 24) & 0xff, (ip >>> 16) & 0xff, (ip >>> 8) & 0xff, ip & 0xff].join(".");
}

/**
 * Return the permitting entry's 1-based position in the operator's CONFIGURED
 * list, or null. An index rather than the entry text because the logger redacts
 * every dotted quad — see PrivateHostConfigResult.
 *
 * Uses the entry's own `index`, never its position in `privateHostEntries`:
 * that array holds only accepted entries, so the array position would disagree
 * with the "dropped" warnings and send the operator to the wrong row.
 *
 * The exemptable-range check runs again here on the ADDRESS itself,
 * independently of entry parsing, so a parsing bug cannot become a bypass.
 */
function matchPrivateHostEntry(ip: number): number | null {
  if (!isExemptablePrivateIpv4(ip)) return null;
  const hit = privateHostEntries.find(({ base, mask }) => ((ip & mask) >>> 0) === base);
  return hit ? hit.index : null;
}

function isBlockedIpv6Literal(hostname: string): boolean {
  if (!hostname.includes(":")) return false;

  const ip = hostname.toLowerCase();
  if (ip === "::" || ip === "0:0:0:0:0:0:0:0") return true;
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  if (/^fe[89ab][0-9a-f]?:/i.test(ip)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true; // fc00::/7 unique local
  if (/^ff[0-9a-f]{2}:/i.test(ip)) return true; // ff00::/8 multicast
  if (/^::ffff:/i.test(ip)) return true; // IPv4-mapped, compressed
  if (/^0:0:0:0:0:ffff:/i.test(ip)) return true; // IPv4-mapped, uncompressed

  return false;
}

/**
 * Validate a URL against the RFC1918 blocklist and domain allowlist.
 * Throws an Error if the URL is blocked.
 *
 * @param label - Human-readable label for error messages (e.g. "Image source", "Source myApi")
 * @param rawUrl - The URL to validate
 * @param opts - `allowPrivateHosts` consults the operator's `allow_private_hosts`
 *   allowlist. Absent or false ⇒ behavior is bit-for-bit what it is without it.
 */
export function validateUrl(
  label: string,
  rawUrl: string,
  opts?: UrlValidationOptions,
): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${label}: invalid URL "${rawUrl}"`);
  }

  // Block non-HTTP(S) protocols (e.g. file://, ftp://, data:)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `${label}: blocked — only http: and https: protocols are allowed, got "${parsed.protocol}"`,
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  // Strip square brackets from IPv6 literals and any trailing FQDN-root
  // dot(s). A trailing dot (e.g. "example.com." or "127.0.0.1.") resolves
  // identically but would otherwise dodge the IPv4-literal pattern checks
  // and the allowlist suffix match.
  const cleanHostname = hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "");

  // Check blocked hostnames
  if (blockedHostnames.includes(cleanHostname)) {
    throw new Error(
      `${label}: blocked — "${cleanHostname}" is a private/internal address. ` +
        `Only public external URLs are allowed.`,
    );
  }

  if (isBlockedIpv6Literal(cleanHostname)) {
    throw new Error(
      `${label}: blocked — "${cleanHostname}" is a private/internal address. ` +
        `Only public external URLs are allowed.`,
    );
  }

  // The operator's allowlist can only ever exempt a bare IPv4 literal. A
  // hostname keeps the strict path — including the DNS check below — because
  // matching a *resolved* address would leave a rebind free to land anywhere
  // private while validation saw an allowed one.
  let exemptedBy: number | null = null;

  const dottedIp = dottedIpv4ToNumeric(cleanHostname);
  if (dottedIp !== null && isSpecialUseIpv4Numeric(dottedIp)) {
    exemptedBy = opts?.allowPrivateHosts ? matchPrivateHostEntry(dottedIp) : null;
    if (exemptedBy === null) {
      throw new Error(
        `${label}: blocked — "${cleanHostname}" is a private/internal address. ` +
          `Only public external URLs are allowed.`,
      );
    }
    // An exemption nobody can audit is one the operator forgets they granted.
    // The label says which widget element; the index says which rule. Neither
    // is an address, so the logger's redaction leaves the record readable.
    logInfo("security.private_hosts.permitted", {
      label,
      entry: exemptedBy,
      of: privateHostEntries.length,
    });
  }

  // Detect decimal IP notation (e.g. http://2130706433 = 127.0.0.1)
  if (/^\d+$/.test(cleanHostname)) {
    const decimalIp = parseInt(cleanHostname, 10);
    if (isSpecialUseIpv4Numeric(decimalIp)) {
      throw new Error(
        `${label}: blocked — decimal IP "${cleanHostname}" resolves to a private address.`,
      );
    }
  }

  // Detect hex IP notation (e.g. http://0x7f000001)
  if (/^0x[0-9a-f]+$/i.test(cleanHostname)) {
    const hexIp = parseInt(cleanHostname, 16);
    if (isSpecialUseIpv4Numeric(hexIp)) {
      throw new Error(
        `${label}: blocked — hex IP "${cleanHostname}" resolves to a private address.`,
      );
    }
  }

  // Detect octal notation in dotted-decimal (e.g. 0177.0.0.1 = 127.0.0.1)
  const octalIp = dottedIpv4WithOctalToNumeric(cleanHostname);
  if (octalIp !== null) {
    if (isSpecialUseIpv4Numeric(octalIp)) {
      throw new Error(
        `${label}: blocked — octal IP "${cleanHostname}" resolves to a private address.`,
      );
    }
  }

  // Domain allowlist enforcement. An allowlisted private host satisfies it —
  // the two options answer different questions, and an operator who locked
  // egress down should not have to invent a domain entry for a bare IP.
  if (exemptedBy === null && allowedDomains.length > 0) {
    const allowed = allowedDomains.some((domain) => {
      const d = domain.toLowerCase();
      return cleanHostname === d || cleanHostname.endsWith(`.${d}`);
    });
    if (!allowed) {
      throw new Error(
        `${label}: blocked — "${cleanHostname}" is not in the allowed_source_domains list.`,
      );
    }
  }
}

// ── DNS rebinding protection ───────────────────────────────────

/**
 * Check if a resolved IP address string falls within private/reserved ranges.
 * Handles both IPv4 dotted-decimal and IPv6 text representations.
 */
function isPrivateIpString(ip: string): boolean {
  const cleanIp = ip.replace(/^\[|\]$/g, "").toLowerCase();
  if (isBlockedIpv6Literal(cleanIp)) return true;

  const numericIp = dottedIpv4ToNumeric(cleanIp);
  return numericIp !== null && isSpecialUseIpv4Numeric(numericIp);
}

/**
 * Validate a URL with DNS resolution — best-effort DNS-rebinding mitigation.
 *
 * Performs all the same synchronous checks as `validateUrl()`, then resolves
 * the hostname via DNS and validates the resolved IP is not private/reserved.
 *
 * NOTE: the subsequent fetch re-resolves the hostname independently, so a
 * residual DNS-rebinding (TOCTOU) window remains between this check and the
 * request. This narrows — but does not close — the attack; see SECURITY.md.
 *
 * @param label - Human-readable label for error messages
 * @param rawUrl - The URL to validate
 * @param opts - See validateUrl(). An exempted host is an IP literal, so the
 *   DNS step below is skipped for it exactly as it is for any other literal.
 */
export async function validateUrlWithDns(
  label: string,
  rawUrl: string,
  opts?: UrlValidationOptions,
): Promise<void> {
  // Run all synchronous checks first (protocol, patterns, allowlist, etc.)
  validateUrl(label, rawUrl, opts);

  const parsed = new URL(rawUrl);
  const hostname = parsed.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();

  // Skip DNS resolution for IP literals — already checked by validateUrl()
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return;
  if (hostname.includes(":")) return; // IPv6 literal

  // Resolve the hostname and validate the resolved IP
  try {
    const result = await Promise.race([
      dns.promises.lookup(hostname),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`DNS lookup timed out for "${hostname}"`)), DNS_LOOKUP_TIMEOUT_MS),
      ),
    ]);
    const address = (result as { address: string }).address;
    if (isPrivateIpString(address)) {
      throw new Error(
        `${label}: blocked — "${hostname}" resolves to private IP "${address}". ` +
          `DNS rebinding attack suspected.`,
      );
    }
  } catch (err) {
    // Re-throw our own validation errors
    if (err instanceof Error && err.message.includes("blocked")) throw err;
    // DNS resolution failure — block the request (fail-closed)
    throw new Error(
      `${label}: blocked — could not resolve hostname "${hostname}".`,
    );
  }
}
