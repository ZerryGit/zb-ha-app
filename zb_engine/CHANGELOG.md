# Changelog

All notable changes to ZerryBit Engine are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.4

### Added

- **The add-on can now load from addresses on your own network, if you allow
  them.** A new `allow_private_hosts` option in the Configuration tab takes a
  list of addresses on your home network. Add one and the add-on can reach it
  for both data sources *and* image/SVG elements — a Pi-hole summary, a NAS
  endpoint, a camera snapshot, a locally rendered Grafana panel. The same entry
  covers both, so an address that works for a JSON fetch also works for a
  picture on the same widget. The option ships empty and only an add-on
  operator can change it, so nothing on your network becomes reachable until
  you add an entry yourself. Everything else is unchanged: with the list empty,
  private addresses are refused exactly as before.

- **Text now lives in a frame you size yourself, and wraps inside it.** Until
  now a text box always hugged its content: a longer live value stretched it
  sideways, ran it off the screen edge, and made centred text drift out of
  place. A new text element starts as a 120×60 frame: type into it and lines
  break at the right edge, like any text field. The box is locked by default —
  text that doesn't fit is cut off at the bottom, and the editor hints at the
  hidden part with a dashed line on the box's bottom edge, so a wild live
  value can never wreck the layout around it. Tick **"Text overflow"** in the
  text inspector and the box grows downward instead: its height becomes a
  minimum (the input is then labelled "Min height") — set it taller than
  today's text to reserve room, and a value that gains a line later fills the
  reserve instead of shifting everything below it; when text outgrows the
  reserve, a dashed line marks where the overrun begins. Dragging any resize
  handle reshapes the frame with the text re-wrapping live as you drag.
  Existing widgets are untouched: every already-saved text element keeps
  hugging its content exactly as before until you touch it — the first
  resize, size edit, or flip of "Text overflow" turns it into a frame at its
  current size.

### Changed

- **Remote images hosted far from the add-on no longer fail to load.** An image
  or SVG element fetched from the web had 0.3 seconds to start replying, which
  is enough for a server in the same country and not enough for one across an
  ocean — the picture simply never appeared. The allowance is now 5 seconds.
  Nearby images are unaffected; they were never waiting. The trade-off is that
  a widget carrying several unreachable images now takes longer to give up on
  them, and one carrying six of them at once can run out the 30-second render
  budget and produce no image at all. One to three remote images is comfortable.

### Fixed

- **The "allowed source domains" list now covers images and SVGs too.** If you
  restricted the add-on to a named list of web addresses, that list was only ever
  applied to data sources — an image or SVG element could still be fetched from
  anywhere on the web. Both now go through the same list. Nothing changes if you
  left the option empty, which is the default and allows every public address. If
  you do use it, check that the addresses your image elements point at are on the
  list: one that is not will stop appearing, and the widget renders without that
  picture and notes it under the Preview tab. The rest of the widget is unaffected.

- **Render warnings are readable again.** When an element failed to draw, the
  warning under the Preview tab printed the internal record as raw JSON —
  `{"elementIndex":1,"elementType":"img","message":"…"}` — instead of the
  sentence inside it. It now shows the sentence.

- **The builder no longer reports "Image load failed" for an image it simply
  cannot preview.** An image or SVG element pointing at a web address is
  blocked by the builder page's own security policy, so it never appears on the
  editor canvas — even though the widget renders it correctly on the device.
  The placeholder used to say the load had failed, which sent people looking
  for a problem that was not there. It now says the preview is unavailable in
  the editor and points you at the rendered widget to check the result.
  Uploaded images and inline SVGs are unaffected: they still preview normally,
  and a genuine failure in one still reports as a failure.

### Known limitations

- **Write the IP address, not a hostname.** `192.168.1.50` works; `nas.local`
  is refused even if it points at that same address. This is deliberate — a
  name can be made to point somewhere else between the safety check and the
  fetch, and an address cannot.
- **IPv4 only.** IPv6 addresses are not accepted in any form.
- **One address, or one subnet at most.** A bare address is the recommended
  form. `192.168.1.0/24` covers a whole subnet and is the widest entry
  accepted; anything broader (`10.0.0.0/8`, `172.16.0.0/12`) is refused,
  because those cover the internal network Home Assistant itself runs on.
- **Some addresses can never be listed**, whatever you write: loopback,
  link-local, and the internal names `supervisor`, `homeassistant`, `hassio`,
  and `localhost`.
- **An image loaded from your network is republished on port 8000.** A widget
  renders to an image, and port 8000 serves that image to anything on your
  network with no password. Pointing an image element at a camera makes that
  camera's picture pollable by every device on your network for as long as the
  widget exists. Prefer `image_port_mode: cache-only` if that matters to you.
- **A bad entry is skipped, not fatal.** An entry that is not a valid address
  is dropped with a warning in the add-on log and grants nothing; the add-on
  starts normally and the rest of the list still works.
- **With "Text overflow" ticked, a text frame grows downward and can overlap
  what sits below it.** In that mode text is never cut off — a value too long
  for its reserve pushes past the frame's minimum height instead. The editor
  marks the overrun with a dashed line at the Min height whenever it happens,
  but the mark reflects the value being previewed: a longer live value on the
  device can overflow further than what you saw while designing. Leave slack
  in the Min height if the layout below the frame must never move — or leave
  "Text overflow" unticked, which locks the box and cuts the text instead.

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
