# Building ZerryBit Engine

This document is primarily a
guide to **building and running the add-on from source** — for transparency and for
anyone who wants to inspect, fork, or self-build it.

The add-on lives in the [`zb_engine/`](zb_engine/) subdirectory of this
repository — **all file paths and shell commands below are relative to `zb_engine/`**
(run `cd zb_engine` after cloning). For the design and the rules the code follows,
see:

1. **[ENGINEERING_CONSTRAINTS.md](zb_engine/ENGINEERING_CONSTRAINTS.md)** — Security, architecture, and platform constraints (including the frozen render core).
2. **[ARCHITECTURE.md](zb_engine/ARCHITECTURE.md)** — System design, platform seam, build pipeline, and extension guides.

---

## Development Setup

### Prerequisites & supported platforms

Building works on **Windows, macOS (Intel & Apple Silicon), and Linux (glibc & musl)**. Before installing:

- **Node.js ≥ 20.19** — matches the `engines` field and the version the [local checks](#local-checks) assume. `nvm use 20` (or your version manager's equivalent) is recommended.
- **`sharp` builds on a native binary.** `sharp` (the image/rasterization library) is not pure JavaScript — `npm install` downloads a prebuilt binary matching your OS + CPU (e.g. `@img/sharp-win32-x64`, `@img/sharp-darwin-arm64`, `@img/sharp-linuxmusl-*`). On the platforms above this is automatic and needs no C toolchain.

> **If `npm install` fails on `sharp`** (a `node-gyp` / "prebuild-install failed" error), the prebuilt binary did not download — usually a corporate proxy/firewall blocking the fetch, an unusual platform, or `optionalDependencies` having been skipped. Try, in order:
> ```bash
> npm install --include=optional sharp   # re-fetch the platform binary
> npm install sharp --force              # force a clean re-resolve
> ```
> If you are behind a proxy, run the install off it, or see sharp's [installation docs](https://sharp.pixelplumbing.com/install). Do **not** add `--ignore-scripts` to a `sharp` install — that skips the script that extracts the binary and leaves it non-functional.

```bash
# Server
npm install            # Install server dependencies
npm run build          # Build @zb/expressions + compile TypeScript (src/ → dist/)

# Builder (separate terminal)
cd builder && npm install   # Install builder dependencies
npm run dev                 # Vite dev server on :5173 (proxies API to Express)
```

> **Two install trees.** The repository root has no `package.json`, so an `npm install`
> there installs nothing. Install in `zb_engine/` (server + the `@zb/expressions`
> workspace) and separately in `zb_engine/builder/` (the SPA). The builder consumes
> shared server code via Vite aliases — see [ARCHITECTURE.md](zb_engine/ARCHITECTURE.md).

---

## Running Tests

```bash
# Server tests (from zb_engine/)
npm test

# Builder tests
cd builder && npm test
```

The test suites cover security hardening (SSRF, XXE, header injection, SVG sanitization), operational behavior (RenderGuard, startup recovery), and expression parity between server and builder.

---

## Regenerating Bundled Assets

Some builder assets are generated from upstream packages and committed to the repository so the image builds without fetching those sources.

### Tabler Icons

The icon set in `builder/src/data/tabler-icons.json` is extracted from the `@tabler/icons` devDependency. Regenerate it after bumping that version:

```bash
cd builder
npm install              # ensure @tabler/icons is installed
npm run icons:generate   # rewrites src/data/tabler-icons.json
```

The generated file carries `license`/`copyright`/`source` metadata in its header so attribution travels with the data. Tabler Icons is MIT (Copyright © Paweł Kuna); see [THIRD-PARTY-NOTICES.md](zb_engine/THIRD-PARTY-NOTICES.md).

### Sora fonts

The `fonts/latin/Sora_*.json` files are pre-rasterized bitmap glyphs derived from the Sora typeface (SIL OFL-1.1 — see [fonts/OFL.txt](zb_engine/fonts/OFL.txt) and [THIRD-PARTY-NOTICES.md](zb_engine/THIRD-PARTY-NOTICES.md)). They are committed artifacts with no committed rasterizer yet, so do not hand-edit them.

---

## Local Checks

There is no hosted CI; run these locally before committing or cutting a release. They run on Node.js 20:

```bash
# Server + shared expression package (from zb_engine/)
npm run lint                              # ESLint
npm test                                  # server Vitest suite
npm run test:expressions                  # @zb/expressions suite
npm run build                             # builds expressions + compiles TypeScript
npm audit --omit=dev --audit-level=high   # production-dependency advisories

# Builder (separate tree)
cd builder
npm run lint
npm test
npm run build
```

Run `npm audit` regularly against the security-sensitive dependency surface (`express`, `multer`, `sharp`).

---

## Branching & releases

`origin/main` is the trunk and the source of truth. It is **branch-protected** — no direct pushes, a pull request is required (0 approvals, so a solo maintainer can self-merge), and force-pushes and branch deletion are blocked (admins included). All work lands through a PR:

```bash
git switch -c feat/my-change main    # branch off main
# ...commit your work...
git push origin feat/my-change       # push.default is `nothing` — always name the branch
gh pr create --base main --fill      # open the PR
gh pr merge --merge --delete-branch  # merge, then delete the branch
```

Keep `feat/*` and `fix/*` branches short-lived and delete them on merge.

**Releases** are a single version bump in [`zb_engine/config.yaml`](zb_engine/config.yaml) plus a git tag on `main` (`v0.1.3`, `v0.1.4`, …). Avoid long-lived `release/*` branches unless a shipped version needs a backported hotfix.

---

## Making Changes

See the **Extension Guides** section in [ARCHITECTURE.md](zb_engine/ARCHITECTURE.md) for step-by-step instructions on common tasks:

- Adding an element type
- Adding a source type
- Adding a new platform

---

## Key Architecture Patterns

| Pattern | Location | Purpose |
|---------|----------|---------|
| Platform adapters | `src/core/adapters.ts` | `StorageAdapter` + `PlatformAdapter` interfaces |
| Store selectors | `builder/src/store/docStore.js` | `selectFocused*` naming convention |
| Export pipeline | `builder/src/models/mapper.js` | `exportRuntimeJson()` — single source of truth for payload export |
| Expression parity | Server + Builder | Both implement the same expression language — changes must be mirrored. See ARCHITECTURE.md. |

---

## Security

Security requirements are detailed in ENGINEERING_CONSTRAINTS.md. Key points:

- All request bodies are Zod-validated at the API boundary.
- SSRF protection validates resolved IPs, blocks all private/reserved ranges including decimal and hex representations.
- SVG content is sanitized (no `<script>`, `<foreignObject>`, event handlers).
- Expression evaluation has a recursion depth limit (20) and blocks prototype pollution keys.
- Source fetches have size limits (1 MB), timeouts (10s connect, 30s total), and redirect re-validation.

To report a vulnerability, see [SECURITY.md](SECURITY.md).
