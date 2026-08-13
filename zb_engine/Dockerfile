# ── Stage 1: Build builder SPA ──────────────────────────────────
FROM node:20-alpine AS builder-build

WORKDIR /app/builder
COPY builder/package.json builder/package-lock.json* ./
RUN npm ci
COPY builder/ .
# Shared graph modules consumed by the builder via @shared/graph Vite alias
COPY src/data/graph/ /app/src/data/graph/
COPY src/data/dataFieldExtractor.ts /app/src/data/dataFieldExtractor.ts
COPY src/data/downsampling.ts /app/src/data/downsampling.ts
# Shared text measurement + wrapping, consumed via the @shared/textLayout alias
COPY src/data/textLayout.ts /app/src/data/textLayout.ts
# Imported by textLayout.ts (MAX_WRAPPED_LINES) and the graph modules above
COPY src/limits.ts /app/src/limits.ts
# Shared expression engine consumed via the @zb/expressions Vite alias
# (resolved to packages/zb-expressions/src/index.ts).
COPY packages/zb-expressions/ /app/packages/zb-expressions/
RUN npm run build

# ── Stage 2: Build server ──────────────────────────────────────
FROM node:20-alpine AS server-build

WORKDIR /app

# Install dependencies first (layer caching).
# Workspace members must be present so `npm ci` can resolve their
# package.json. We copy only manifests at this stage to maximize cache
# hits when sources change but deps don't.
COPY package.json package-lock.json* ./
COPY packages/zb-expressions/package.json ./packages/zb-expressions/
RUN npm ci --ignore-scripts

# Build the shared @zb/expressions package first so its dist/ exists when
# the server's `tsc` resolves the workspace symlink at node_modules/@zb/expressions.
COPY packages/zb-expressions/ ./packages/zb-expressions/
RUN npm -w @zb/expressions run build

# Copy TypeScript source & config, compile
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# ── Stage 3: Runtime ───────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /usr/src/app

# Production deps only — do NOT use --ignore-scripts here.
# sharp's platform packages (@img/sharp-linuxmusl-*) have install scripts that
# extract the prebuilt binary. Skipping them leaves sharp non-functional.
# Workspace members must be present for `npm ci` to resolve them.
COPY package.json package-lock.json* ./
COPY packages/zb-expressions/package.json ./packages/zb-expressions/
RUN npm ci --omit=dev

# Create non-root user and install su-exec for privilege drop
RUN addgroup -S app && adduser -S app -G app \
    && apk add --no-cache su-exec

# Compiled server output
COPY --from=server-build /app/dist/ ./dist/

# Shared package's compiled dist/ — the runtime server requires
# @zb/expressions through the workspace symlink, which points at
# packages/zb-expressions/. Without dist/, the require() would fail.
COPY --from=server-build /app/packages/zb-expressions/dist/ ./packages/zb-expressions/dist/

# Compiled builder SPA
COPY --from=builder-build /app/builder/dist/ ./builder/dist/

# Static assets: fonts, UI files, default payload
COPY fonts/ ./fonts/
COPY public/ ./public/
COPY payload.json ./
COPY config.yaml ./

# License & third-party attribution texts — required to ship with the image,
# which bundles OFL (Sora; the verbatim OFL-1.1 ships at fonts/OFL.txt via the
# fonts COPY above), MIT (Tabler Icons), and LGPL/Apache (libvips/sharp) assets.
COPY LICENSE ./
COPY THIRD-PARTY-NOTICES.md ./

# Entrypoint script: fixes /data ownership at runtime, then drops to 'app'.
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh \
    && chown -R app:app /usr/src/app

# Ensure the persistent data directory exists.
# At runtime, HA Supervisor mounts its own root-owned /data volume over this,
# so the entrypoint script must chown /data at container start.
RUN mkdir -p /data/widgets

# Ingress on 8099, static ESP32 on 8000
EXPOSE 8099 8000

ENTRYPOINT ["./entrypoint.sh"]