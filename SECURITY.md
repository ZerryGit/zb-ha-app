# Security Policy

## Supported versions

ZerryBit Engine is shipped as a Home Assistant add-on. Security fixes are
applied to the latest released version only. Please reproduce any issue on the
current release before reporting.

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public
GitHub issue for a suspected vulnerability.

- **Email (primary):** `contact@zerrybit.com`.
- **GitHub private vulnerability reporting:** use "Report a vulnerability" under
  the repository's **Security** tab (see GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).

Please include enough detail to reproduce: affected version, configuration, a
proof-of-concept or steps, and the impact you observed.

**Response targets:** we aim to acknowledge a report within **5 business days**
and to provide an initial assessment within **10 business days**. Coordinated
disclosure is appreciated — please give us a reasonable window to ship a fix
before any public disclosure.

## Scope and trust model

This add-on is designed to run on a **trusted Home Assistant host on a trusted
LAN**. Some behaviors are intentional given that model and are documented rather
than treated as vulnerabilities — see the README
"[Security & data handling](README.md#security--data-handling)" section. In
particular:

- **Port 8000 (ESP32 endpoint) is unauthenticated by design.** It must stay on a
  trusted LAN and must not be port-forwarded or exposed to the internet.
- **Source credentials are stored at rest in plaintext** under `/data` so the
  add-on can replay the fetch at render time. They are masked on the read API
  but not encrypted on disk; the HA host is the trust boundary.
- **Outbound fetches can reach any public host out of the box.** Private and
  reserved IP ranges are blocked (SSRF protection with redirect re-validation)
  unless the operator has explicitly listed them, and an optional
  `allowed_source_domains` allowlist can restrict egress to specific hosts —
  it governs data sources and `img`/`svg` element sources alike. A residual
  DNS-rebinding window exists between validation and the actual fetch.
- **`allow_private_hosts` is an operator opt-in to reach specific private
  addresses.** It ships empty. An operator may list IPv4 literals or `/24`–`/32`
  CIDRs within `10/8`, `172.16/12`, `192.168/16`, or `100.64/10`; those become
  reachable for both data sources and `img`/`svg` elements. Loopback,
  link-local (including `169.254.169.254`), every other special-use range, and
  the internal hostnames `supervisor` / `hassio` / `homeassistant` /
  `localhost` are never exemptable. The exemption never applies to a redirect
  target, and never to a hostname — only to a bare IP literal, so the
  DNS-rebinding guarantee is unchanged. Note that an `img` element loading from
  a listed address republishes that content through the unauthenticated port
  8000, for as long as the widget exists.

Reports that rely on having root/volume access to the HA host, or on exposing
the unauthenticated ESP32 port to an untrusted network, fall outside this trust
model. Reports of issues exploitable **within** the documented model (e.g. a
panel user reading another user's stored credentials, an SSRF bypass reaching a
private host not listed in `allow_private_hosts`, a sanitizer bypass, or a
remote crash/DoS) are in scope and welcome. A defect in the `allow_private_hosts`
matcher itself — an entry granting more than it names, a never-exemptable range
becoming reachable, or the exemption leaking to a redirect target or a hostname
— is an SSRF bypass and is in scope.
