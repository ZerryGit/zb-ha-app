# Changelog

All notable changes to ZerryBit Engine are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.4

### Added

- **The add-on can now load from addresses on your own network, if you allow
  them.** A new `allow_private_hosts` option in the Configuration tab takes a
  list of addresses on your home network — a Pi-hole summary, a NAS endpoint, a
  camera snapshot, a locally rendered Grafana panel. One entry covers both data
  sources *and* image/SVG elements. The option ships empty and only an add-on
  operator can change it, so nothing on your network becomes reachable until you
  add an entry yourself; with the list empty, private addresses are refused
  exactly as before.

- **Text now lives in a frame you size yourself, and wraps inside it.** Until now
  a text box always hugged its content, so a longer live value stretched it
  sideways and pushed centred text out of place. A new text element starts as a
  120×60 frame: type into it and lines break at the right edge. The box is locked
  by default — text that doesn't fit is cut off, and the editor marks the hidden
  part with a dashed line — so a wild live value can never wreck the layout
  around it. Tick **"Text overflow"** in the text inspector and the box grows
  downward instead: its height becomes a minimum (the input is then labelled
  "Min height"), so a value that gains a line fills the reserve rather than
  shifting everything below it. Resize handles re-wrap the text live as you drag.
  Existing widgets are untouched: every already-saved text element keeps hugging
  its content exactly as before until you touch it — the first resize, size edit,
  or flip of "Text overflow" turns it into a frame at its current size.

- **Preview, Refresh data and Deploy now show that they are working.** A greyed
  out button was the only sign anything was happening, which is hard to tell
  apart from a frozen page. A spinner now names the action, and past a second and
  a half it counts the seconds, so a slow image fetch looks like a slow image
  fetch instead of a hang. An action that finishes promptly never shows it, and
  it never blocks the editor while it is up.

### Changed

- **Remote images hosted far from the add-on no longer fail to load.** An image
  or SVG element had 0.3 seconds to start replying — enough for a server in the
  same country, not for one across an ocean, so the picture simply never
  appeared. The allowance is now 5 seconds. Nearby images are unaffected; they
  were never waiting. The trade-off: a widget carrying six unreachable images can
  run out the 30-second render budget and produce no image at all. One to three
  remote images is comfortable.

### Fixed

- **The "allowed source domains" list now covers images and SVGs too.** That list
  was only ever applied to data sources — an image or SVG element could still be
  fetched from anywhere on the web. Both now go through it. Nothing changes if
  you left the option empty, which is the default. If you do use it, check that
  the addresses your image elements point at are on the list: one that is not
  will stop appearing, and the widget renders without that picture and notes it
  under the Preview tab. The rest of the widget is unaffected.

- **Render warnings are readable again.** When an element failed to draw, the
  warning under the Preview tab printed the internal record as raw JSON —
  `{"elementIndex":1,"elementType":"img","message":"…"}` — instead of the
  sentence inside it. It now shows the sentence.

- **The builder no longer reports "Image load failed" for an image it simply
  cannot preview.** An image or SVG element pointing at a web address is blocked
  by the builder page's own security policy, so it never appears on the editor
  canvas — even though the widget renders it correctly on the device. It now says
  the preview is unavailable in the editor instead of claiming a failure.
  Uploaded images and inline SVGs still preview normally, and a genuine failure
  in one still reports as a failure.

### Security

- **Image-handling dependencies updated.** `sharp` 0.33.5 → 0.35.3 closes four
  inherited libvips advisories (CVE-2026-33327 / 33328 / 35590 / 35591, all
  HIGH) on the path that rasterizes uploaded images and SVG, and `body-parser`
  → 1.20.6 closes an invalid-limit denial-of-service advisory reached through
  Express. No configuration change is needed. Rendered images are unaffected in
  content, though the new library compresses PNGs slightly differently, so a
  device or cache that compares raw image bytes will see one extra refresh
  after the update.

### Known limitations

- **`allow_private_hosts` takes an IPv4 address, not a hostname.**
  `192.168.1.50` works; `nas.local` is refused even if it points at that same
  address — a name can be made to point somewhere else between the safety check
  and the fetch, and an address cannot. A bare address is the recommended form;
  `192.168.1.0/24` covers a subnet and is the widest entry accepted, since
  anything broader would cover the internal network Home Assistant itself runs
  on. Loopback, link-local, and the internal names `supervisor`,
  `homeassistant`, `hassio` and `localhost` can never be listed. An entry that
  isn't a valid address is skipped with a warning in the add-on log rather than
  stopping the add-on, and grants nothing.
- **An image loaded from your network is republished on port 8000.** A widget
  renders to an image, and port 8000 serves that image to anything on your
  network with no password. Pointing an image element at a camera makes that
  camera's picture pollable by every device on your network for as long as the
  widget exists. Prefer `image_port_mode: cache-only` if that matters to you.
- **With "Text overflow" ticked, a text frame can overlap what sits below it.**
  Text is never cut off in that mode — a value too long for its reserve pushes
  past the Min height instead. The editor marks the overrun with a dashed line,
  but that mark reflects the value being previewed: a longer live value on the
  device can overflow further than what you saw while designing. Leave slack in
  the Min height if the layout below must never move, or untick "Text overflow"
  to lock the box and cut the text instead.

## 0.1.3

### Added

- **Up to 500 data sources per widget** (previously 50). The server payload
  limit and the builder now agree on the higher cap, so a large dashboard can
  pull from many more endpoints or Home Assistant entities without being split
  across several widgets.
- **A one-time notice when a widget passes 50 data sources.** The builder
  explains once, per widget, that fetching and refreshing a pool this large can
  slow down saves and cause stuttering or delayed screen updates on low-power
  hardware like a Raspberry Pi. It is advisory only — the source is added either
  way, and the message does not come back for that widget.
- **`schemaVersion` on the stored widget envelope.** Saved widgets now record
  the document format version (currently `1`), stamped at the single write
  point, and loads route through a version-keyed migration chain. This is
  groundwork: a future format change can migrate older documents instead of
  breaking them. Existing widgets are unaffected — a file without the field is
  treated as the pre-versioning baseline, and migration runs in memory only, so
  opening an old widget never rewrites it on disk.

### Known limitations

- **500 sources is reachable with fast local sources, not slow remote ones.**
  Sources resolve four at a time inside a 30-second render budget, so several
  hundred Home Assistant entity reads fit comfortably, while a widget built on
  external HTTP APIs averaging a few hundred milliseconds each will hit the
  render timeout well before the cap.
- **Reaching the 500-source cap gives no on-screen feedback.** The builder
  refuses the add and logs to the browser console; nothing is surfaced in the UI.

## 0.1.2

### Added

- **Guided self-host setup.** Creating a new widget now opens a "How do you
  want to set up?" chooser — *Using the mobile application* (recommended) or
  *Self-host* (advanced). The self-host path provides a Postman-style form:
  enter your ESP32's LAN IP, press **Send**, and the add-on pushes the device
  `/config` for you, so the browser never has to talk to the device directly.
  Re-openable later from the Settings tab.
- **Server-side `/config` push proxy.** A new authenticated
  `POST /api/device/config` endpoint (HA Ingress only — never the
  unauthenticated image port) forwards a fixed-shape self-host configuration to
  an ESP32 on the LAN. The target is restricted to private-LAN (RFC1918)
  addresses with loopback, link-local, Docker, and HA-Supervisor ranges
  blocked; the address is canonicalized before it is dialed; the device port is
  fixed at `:80`; and the request is Zod-validated and capped at 1024 bytes,
  rate-limited, timeout-bounded (10s), redirect-refusing, and response-size
  capped.

### Changed

- **HA sidebar panel renamed to "ZerryBit Engine".**
- **Self-host setup UX polish** — the image URL auto-fills with this add-on's
  own endpoint, required fields surface clear errors on **Send**, tile
  selection is explicit, the image-URL help text sits next to its input, and
  the form spacing no longer shifts as you type.
- **Send → Continue on a successful push.** Once the device accepts the config,
  the **Send** button becomes **Continue** and the form locks; Continue (or the
  header ✕) goes straight to the builder. In the new-widget flow the canvas is
  sized to the full device screen from the sidebar toggle — 720×480 with the
  sidebar column reserved, 800×480 without.

### Fixed

- **Auto-save no longer wedges after a skipped save.** An internal "saving"
  flag could stay stuck on when a save was skipped mid-flight, silently
  disabling auto-save until the page was reloaded; it now clears correctly.

### Documentation

- Brought the ESP32 `.bin` endpoint documentation in line with the
  `POST`/framed-reply contract shipped in 0.1.1 (it was previously still
  documented as `GET /image.bin`).

## 0.1.1

### Changed

- **The ESP32-facing `.bin` endpoint is now `POST`, not `GET`.** It returns
  the self-host framed reply: a 25-byte header — width, height, refresh
  flags, next-wake, sidebar clock — followed by the 1-bit image, with bit
  polarity corrected to match the ESP32 wire format (`1` = white). The
  request body is never read. Existing self-host device configurations
  pointing at the old `GET /image.bin` will need to be reconfigured to
  `POST`.

## 0.1.0

Initial public release of ZerryBit Engine — a self-contained, fully local Home
Assistant add-on that renders 1-bit (e-ink) images from a declarative JSON
payload, with a built-in visual widget builder. No cloud dependency.

### Added

- **1-bit rendering engine.** A 7-phase render pipeline (Parse → Features →
  Sources → Context → Bindings → Draw → Encode) that outputs both a packed
  1-bit binary (`GET /image.bin`) for direct ESP32 consumption and a PNG
  (`GET /image.png`) for preview, with per-element error isolation and a global
  render timeout.
- **Drawing primitives.** Rectangle, circle/arc/ring, polyline, bitmap text,
  raster image, inline/fetched SVG, and recursive groups — with affine
  transforms (rotation, scale, pivot) and Bayer ordered dithering.
- **Bitmap font system.** Pre-rasterized Sora font set with nearest-variant
  size/weight snapping and family fallback.
- **Declarative data pipeline.** Parallel HTTP source fetching (JSON/XML/CSV/
  text), Home Assistant entity-state and history sources via the Supervisor
  API, dot-path field extraction, and a sandboxed binding/expression engine
  (`@zb/expressions`) shared by the server renderer and the builder preview.
- **Visual widget builder.** A local single-page builder served over Home
  Assistant Ingress for composing widgets, previewing server-rendered output,
  and saving or deploying payloads.
- **Dual-port architecture.** Port 8099 (HA Ingress, session-authenticated) for
  the builder and management APIs; port 8000 (unauthenticated, read-only) for
  ESP32 image polling. Renders are written with hash-before-write to protect
  SD cards.

### Security

- **SSRF protection.** All user-supplied URLs are validated against private and
  reserved IP ranges (including alternate IPv4/IPv6 encodings), with an optional
  domain allowlist and re-validation of redirect targets.
- **SVG sanitization.** Fetched and inline SVG is sanitized through an
  allowlist XML parser before rasterization; raw asset responses carry a
  locked-down `Content-Security-Policy`, `nosniff`, and force-download.
- **Input validation & quotas.** Zod schema validation at every API boundary,
  widget ID sanitization, request size limits, an expression evaluation budget,
  and per-host storage/asset quotas sized for a Raspberry Pi.
- **Container hardening.** The add-on drops Linux capabilities and ships an
  AppArmor profile.
- **Credential handling.** Source authentication secrets are masked on the read
  APIs and redacted from container logs.

### Known limitations

- **Open egress by default.** With an empty `allowed_source_domains`, the add-on
  can fetch any public host (private/reserved ranges are always blocked). Set
  the allowlist to restrict egress. See [SECURITY.md](../SECURITY.md).
- **DNS-rebinding TOCTOU.** A residual window remains between URL validation and
  fetch; documented and accepted for the local HA add-on.
- **In-memory rate limits.** Rate limits reset on add-on/container restart.
