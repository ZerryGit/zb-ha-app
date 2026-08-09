/**
 * privateHosts.test.ts — operator-allowlisted private hosts (`allow_private_hosts`)
 *
 * Covers the entry parser/normalizer and the never-exemptable range guard.
 * The default (empty allowlist) behavior lives in urlValidator.test.ts and must
 * stay green there unedited — that is the proof this feature is inert by default.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import {
  configurePrivateHosts,
  configureUrlValidator,
  configureBlockedHostnames,
  validateUrl,
  validateUrlWithDns,
} from "../src/data/urlValidator";

const ALLOW = { allowPrivateHosts: true };

beforeEach(() => {
  configurePrivateHosts([]);
  configureUrlValidator([]);
  configureBlockedHostnames(["localhost", "supervisor", "hassio", "homeassistant"]);
});

afterAll(() => {
  configurePrivateHosts([]);
  configureUrlValidator([]);
  configureBlockedHostnames(["localhost", "supervisor", "hassio", "homeassistant"]);
});

/** Accepted entries, normalized. */
function accept(entries: string[]): string[] {
  return configurePrivateHosts(entries).accepted;
}

/**
 * Rejection reasons, keyed by entry. `rejected` reports a 1-based index into
 * the input list rather than the entry text (the logger redacts addresses), so
 * the text is recovered here for readable assertions.
 */
function rejectReasons(entries: string[]): Record<string, string> {
  return Object.fromEntries(
    configurePrivateHosts(entries).rejected.map(({ index, reason }) => [
      entries[index - 1],
      reason,
    ]),
  );
}

describe("allow_private_hosts — accepted entry forms", () => {
  it("accepts a bare dotted-quad, treated as /32", () => {
    expect(accept(["192.168.1.50"])).toEqual(["192.168.1.50"]);
  });

  it("accepts an explicit /32 and normalizes it to the bare address", () => {
    expect(accept(["10.0.0.5/32"])).toEqual(["10.0.0.5"]);
  });

  it("accepts a /24", () => {
    expect(accept(["192.168.1.0/24"])).toEqual(["192.168.1.0/24"]);
  });

  it("accepts all four exemptable ranges", () => {
    expect(
      accept(["10.1.2.3", "100.64.0.1", "172.16.5.0/24", "192.168.0.0/24"]),
    ).toEqual(["10.1.2.3", "100.64.0.1", "172.16.5.0/24", "192.168.0.0/24"]);
  });

  it("trims and lowercases, and drops empty entries without reporting them", () => {
    const result = configurePrivateHosts(["  192.168.1.50  ", "", "   "]);
    expect(result.accepted).toEqual(["192.168.1.50"]);
    expect(result.rejected).toEqual([]);
  });

  it("accepts up to the whole list, keeping order", () => {
    expect(accept(["192.168.1.1", "192.168.1.2"])).toEqual(["192.168.1.1", "192.168.1.2"]);
  });
});

describe("allow_private_hosts — rejected entry forms (D1)", () => {
  it("rejects a prefix broader than /24", () => {
    const reasons = rejectReasons(["192.168.0.0/23", "10.0.0.0/8", "172.16.0.0/12"]);
    expect(Object.keys(reasons)).toEqual(["192.168.0.0/23", "10.0.0.0/8", "172.16.0.0/12"]);
    for (const reason of Object.values(reasons)) {
      expect(reason).toContain("between 24 and 32");
    }
  });

  it("rejects a prefix narrower than /32", () => {
    expect(rejectReasons(["192.168.1.1/33"])["192.168.1.1/33"]).toContain("between 24 and 32");
  });

  it("rejects hostnames", () => {
    expect(Object.keys(rejectReasons(["nas.local", "pihole"]))).toEqual(["nas.local", "pihole"]);
  });

  it("rejects IPv6 in any spelling", () => {
    expect(Object.keys(rejectReasons(["fd00::1", "::1", "fe80::1%eth0"]))).toEqual([
      "fd00::1",
      "::1",
      "fe80::1%eth0",
    ]);
  });

  it("rejects decimal, hex, and octal spellings of an address", () => {
    expect(
      Object.keys(rejectReasons(["3232235826", "0xc0a80132", "0300.0250.1.50", "192.168.001.50"])),
    ).toEqual(["3232235826", "0xc0a80132", "0300.0250.1.50", "192.168.001.50"]);
  });

  it("rejects a trailing dot and short forms", () => {
    expect(Object.keys(rejectReasons(["192.168.1.50.", "192.168.1", "192.168"]))).toEqual([
      "192.168.1.50.",
      "192.168.1",
      "192.168",
    ]);
  });

  it("rejects an out-of-range octet", () => {
    expect(Object.keys(rejectReasons(["192.168.1.256"]))).toEqual(["192.168.1.256"]);
  });

  it("rejects a malformed CIDR", () => {
    expect(Object.keys(rejectReasons(["192.168.1.0/24/8", "192.168.1.0/", "192.168.1.0/ab"])))
      .toEqual(["192.168.1.0/24/8", "192.168.1.0/", "192.168.1.0/ab"]);
  });

  it("rejects a CIDR with host bits set rather than widening it", () => {
    // "the host .5" and "the subnet holding .5" differ by 256 addresses.
    const result = configurePrivateHosts(["192.168.1.5/24"]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toContain("host bits set");
  });

  it("names both unambiguous alternatives without echoing an address", () => {
    const reason = rejectReasons(["192.168.1.5/24"])["192.168.1.5/24"];
    expect(reason).toContain("network address");
    expect(reason).toContain("prefix 32");
  });

  it("accepts the aligned form of the same block", () => {
    expect(accept(["192.168.1.0/24"])).toEqual(["192.168.1.0/24"]);
  });

  it("allows any host address at /32, where there are no host bits to set", () => {
    expect(accept(["192.168.1.5/32"])).toEqual(["192.168.1.5"]);
  });

  it("rejects an entry naming a port", () => {
    expect(Object.keys(rejectReasons(["192.168.1.50:8080"]))).toEqual(["192.168.1.50:8080"]);
  });

  it("keeps the good entries when the list also contains junk (D7)", () => {
    const result = configurePrivateHosts(["nas.local", "192.168.1.50", "10.0.0.0/8"]);
    expect(result.accepted).toEqual(["192.168.1.50"]);
    // 1-based positions in the operator's list — entries 1 and 3.
    expect(result.rejected.map((r) => r.index)).toEqual([1, 3]);
  });

  it("reports the input position even when earlier entries were blank", () => {
    const result = configurePrivateHosts(["", "  ", "nas.local", "192.168.1.50"]);
    expect(result.rejected).toEqual([
      { index: 3, reason: "not a canonical dotted-quad IPv4 address" },
    ]);
    expect(result.accepted).toEqual(["192.168.1.50"]);
  });

  it("drops an over-long junk entry rather than failing the list (D12.1)", () => {
    const result = configurePrivateHosts(["http://192.168.1.50", "192.168.1.50"]);
    expect(result.accepted).toEqual(["192.168.1.50"]);
    expect(result.rejected.map((r) => r.index)).toEqual([1]);
  });

  it("tolerates a non-array without throwing", () => {
    expect(configurePrivateHosts(undefined as unknown as string[])).toEqual({
      accepted: [],
      acceptedIndices: [],
      rejected: [],
    });
  });

  it("reports accepted and dropped rows in the operator's own numbering", () => {
    // Row 1 is junk and row 2 is blank, so the sole survivor is row 3. An index
    // into the compacted accepted array would call it 1 and send the operator
    // to the junk line.
    const result = configurePrivateHosts(["nonsense", "  ", "192.168.1.50"]);

    expect(result.accepted).toEqual(["192.168.1.50"]);
    expect(result.acceptedIndices).toEqual([3]);
    expect(result.rejected.map((r) => r.index)).toEqual([1]);
  });

  it("still permits the address whose row was renumbered by an earlier rejection", () => {
    // Guards the same coordinate bug from the matching side: the permitted log
    // reads its row from the entry's own `index` (stamped here), never from the
    // position in the compacted accepted array.
    configurePrivateHosts(["nonsense", "192.168.1.50"]);

    expect(() =>
      validateUrl("test", "http://192.168.1.50/x", ALLOW),
    ).not.toThrow();
  });
});

describe("allow_private_hosts — the audit trail survives log redaction (D12.2)", () => {
  const everyRejectionForm = [
    "192.168.0.0/23",
    "10.0.0.0/8",
    "192.168.1.5/24",
    "192.168.1.1/33",
    "nas.local",
    "fd00::1",
    "3232235826",
    "0xc0a80132",
    "192.168.1.256",
    "192.168.1.0/24/8",
    "192.168.1.0/ab",
    "192.168.1.50:8080",
    "127.0.0.1",
    "http://192.168.1.50",
  ];

  it("emits no reason containing a dotted quad", () => {
    // core/logger rewrites /\b(?:\d{1,3}\.){3}\d{1,3}\b/ to [redacted-ip], which
    // is what made the original entry-echoing warnings unusable.
    for (const { reason } of configurePrivateHosts(everyRejectionForm).rejected) {
      expect(reason).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    }
  });

  it("emits no reason containing a redactable path token", () => {
    // The same redactor rewrites /(^|[\s"'=:(])\/[A-Za-z0-9._~/-]+/ — so a bare
    // " /24" in prose would come out as [redacted-path].
    for (const { reason } of configurePrivateHosts(everyRejectionForm).rejected) {
      expect(reason).not.toMatch(/(^|[\s"'=:(])\/[A-Za-z0-9._~/-]+/);
    }
  });

  it("reports a rejection as an index and a reason only", () => {
    for (const rejection of configurePrivateHosts(everyRejectionForm).rejected) {
      expect(Object.keys(rejection).sort()).toEqual(["index", "reason"]);
      expect(typeof rejection.index).toBe("number");
    }
  });

  it("still names the exemptable ranges, in a redaction-proof form", () => {
    const reason = rejectReasons(["8.8.8.8"])["8.8.8.8"];
    expect(reason).toContain("10/8");
    expect(reason).toContain("100.64/10");
    expect(reason).toContain("172.16/12");
    expect(reason).toContain("192.168/16");
  });

  it("writes a permitted line the real logger leaves readable", () => {
    configurePrivateHosts(["10.0.0.5", "192.168.1.50"]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      validateUrl("Image source", "http://192.168.1.50/snapshot.jpg", ALLOW);

      const lines = spy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("security.private_hosts.permitted"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain("redacted");

      // "Which widget element, and under which rule" — D8's question, answerable.
      const record = JSON.parse(lines[0]);
      expect(record.label).toBe("Image source");
      expect(record.entry).toBe(2);
      expect(record.of).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("distinguishes a source from an element on the same host", () => {
    configurePrivateHosts(["192.168.1.50"]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      validateUrl("Source nas", "http://192.168.1.50/api", ALLOW);
      validateUrl("Image source", "http://192.168.1.50/cam.jpg", ALLOW);

      const labels = spy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("security.private_hosts.permitted"))
        .map((line) => JSON.parse(line).label);
      expect(labels).toEqual(["Source nas", "Image source"]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("allow_private_hosts — never-exemptable ranges (D3)", () => {
  const neverExemptable = [
    "127.0.0.1",
    "127.0.0.0/24",
    "169.254.169.254",
    "169.254.0.0/24",
    "0.0.0.0/24",
    "192.0.0.1",
    "192.0.2.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "8.8.8.8",
  ];

  it.each(neverExemptable)("refuses %s at load time", (entry) => {
    const result = configurePrivateHosts([entry]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toContain("outside the private ranges");
  });

  it("refuses a block that straddles out of an exemptable range", () => {
    // 100.63.255.0/24 sits just below 100.64.0.0/10.
    expect(accept(["100.63.255.0/24"])).toEqual([]);
  });
});

describe("the exemption requires BOTH the flag and a matching entry (D2)", () => {
  it("permits a listed address only when the caller opts in", () => {
    configurePrivateHosts(["192.168.1.50"]);
    expect(() => validateUrl("Source s", "http://192.168.1.50/api", ALLOW)).not.toThrow();
  });

  it("still blocks a listed address when the flag is absent", () => {
    configurePrivateHosts(["192.168.1.50"]);
    expect(() => validateUrl("Source s", "http://192.168.1.50/api")).toThrow(/private\/internal/);
  });

  it("still blocks when the flag is false", () => {
    configurePrivateHosts(["192.168.1.50"]);
    expect(() =>
      validateUrl("Source s", "http://192.168.1.50/api", { allowPrivateHosts: false }),
    ).toThrow(/private\/internal/);
  });

  it("still blocks with the flag set but an empty allowlist", () => {
    expect(() => validateUrl("Source s", "http://192.168.1.50/api", ALLOW)).toThrow(
      /private\/internal/,
    );
  });

  it("blocks a sibling address in the same /24 that was not listed", () => {
    configurePrivateHosts(["192.168.1.50"]);
    expect(() => validateUrl("Source s", "http://192.168.1.51/api", ALLOW)).toThrow(
      /private\/internal/,
    );
  });

  it("admits the whole subnet for a /24 entry", () => {
    configurePrivateHosts(["192.168.1.0/24"]);
    for (const host of ["192.168.1.0", "192.168.1.1", "192.168.1.200", "192.168.1.255"]) {
      expect(() => validateUrl("Source s", `http://${host}/api`, ALLOW)).not.toThrow();
    }
    expect(() => validateUrl("Source s", "http://192.168.2.1/api", ALLOW)).toThrow(
      /private\/internal/,
    );
  });

  it("permits an https URL and a non-default port on a listed address", () => {
    configurePrivateHosts(["10.0.0.5"]);
    expect(() => validateUrl("Source s", "https://10.0.0.5:8443/x", ALLOW)).not.toThrow();
  });

  it("keeps the same error message as an unlisted private address", () => {
    expect(() => validateUrl("Source s", "http://192.168.1.50/api", ALLOW)).toThrow(
      'Source s: blocked — "192.168.1.50" is a private/internal address. ' +
        "Only public external URLs are allowed.",
    );
  });
});

describe("never-exemptable targets, whatever the operator listed (D3)", () => {
  it("blocks loopback even if a loopback entry was attempted", () => {
    configurePrivateHosts(["127.0.0.1", "192.168.1.50"]);
    expect(() => validateUrl("Image source", "http://127.0.0.1:8000/img", ALLOW)).toThrow(
      /private\/internal/,
    );
  });

  it("blocks the cloud metadata endpoint", () => {
    configurePrivateHosts(["169.254.169.254", "169.254.0.0/24"]);
    expect(() => validateUrl("Image source", "http://169.254.169.254/latest", ALLOW)).toThrow(
      /private\/internal/,
    );
  });

  it("keeps the internal hostname blocklist strict", () => {
    configurePrivateHosts(["192.168.1.0/24"]);
    for (const host of ["localhost", "supervisor", "hassio", "homeassistant"]) {
      expect(() => validateUrl("Source s", `http://${host}/api`, ALLOW)).toThrow(
        /private\/internal/,
      );
    }
  });

  it("keeps IPv6 literals blocked", () => {
    configurePrivateHosts(["192.168.1.0/24"]);
    expect(() => validateUrl("Source s", "http://[::1]/api", ALLOW)).toThrow(/private\/internal/);
    expect(() => validateUrl("Source s", "http://[fd00::1]/api", ALLOW)).toThrow(
      /private\/internal/,
    );
  });
});

describe("hostnames are never exempted (D5)", () => {
  it("blocks a hostname that resolves to a listed address", async () => {
    configurePrivateHosts(["127.0.0.1", "192.168.1.50"]);
    // `localhost.` resolves to 127.0.0.1 on every platform; the entry above is
    // refused at load, but even a well-formed one could not rescue a hostname.
    await expect(validateUrlWithDns("Source s", "http://localhost./api", ALLOW)).rejects.toThrow(
      /private\/internal|resolves to private IP/,
    );
  });

  it("leaves the fail-closed DNS path untouched for an unresolvable hostname", async () => {
    configurePrivateHosts(["192.168.1.0/24"]);
    await expect(
      validateUrlWithDns("Source s", "http://no-such-host.invalid/api", ALLOW),
    ).rejects.toThrow(/could not resolve hostname/);
  });

  it("skips DNS for a listed IP literal, as it does for any literal", async () => {
    configurePrivateHosts(["192.168.1.50"]);
    await expect(
      validateUrlWithDns("Source s", "http://192.168.1.50/api", ALLOW),
    ).resolves.toBeUndefined();
  });
});

describe("relationship to allowed_source_domains (D6)", () => {
  it("a listed private IP satisfies a non-empty domain allowlist", () => {
    configureUrlValidator(["api.example.com"]);
    configurePrivateHosts(["192.168.1.50"]);
    expect(() => validateUrl("Source s", "http://192.168.1.50/api", ALLOW)).not.toThrow();
  });

  it("does not widen the domain allowlist for public hosts", () => {
    configureUrlValidator(["api.example.com"]);
    configurePrivateHosts(["192.168.1.50"]);
    expect(() => validateUrl("Source s", "https://evil.example.net/api", ALLOW)).toThrow(
      /not in the allowed_source_domains list/,
    );
  });

  it("still enforces the domain allowlist for an unlisted private IP", () => {
    configureUrlValidator(["api.example.com"]);
    configurePrivateHosts(["192.168.1.50"]);
    expect(() => validateUrl("Source s", "http://192.168.9.9/api", ALLOW)).toThrow(
      /private\/internal/,
    );
  });
});

describe("protocol and spelling handling under the exemption", () => {
  it("still blocks non-HTTP protocols on a listed address", () => {
    configurePrivateHosts(["192.168.1.50"]);
    expect(() => validateUrl("Source s", "file://192.168.1.50/etc/passwd", ALLOW)).toThrow(
      /only http: and https: protocols/,
    );
  });

  it("treats alternate spellings of a listed address as that address", () => {
    // WHATWG URL canonicalizes these to 192.168.1.50 before validation. D1
    // restricts what the OPERATOR writes, not how the URL is spelled.
    configurePrivateHosts(["192.168.1.50"]);
    for (const url of ["http://0xc0a80132/x", "http://3232235826/x", "http://0300.0250.1.50/x"]) {
      expect(() => validateUrl("Source s", url, ALLOW)).not.toThrow();
    }
  });

  it("does not exempt those spellings when they resolve elsewhere", () => {
    configurePrivateHosts(["192.168.1.50"]);
    expect(() => validateUrl("Source s", "http://0x7f000001/x", ALLOW)).toThrow(
      /private\/internal/,
    );
  });
});
