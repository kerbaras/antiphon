# Antiphon server image.
#
# Build context is the REPO ROOT (the workspace lockfile + Rust crates are
# needed), so build from the repo root:
#
#   docker build -f apps/server/Dockerfile -t antiphon-server .
#
# Why the runtime keeps the pnpm workspace layout instead of `pnpm deploy`:
# the server runs TypeScript directly on Node 24 (type stripping), and Node
# refuses to strip types for files physically under node_modules
# (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). `pnpm deploy` COPIES
# @antiphon/core-wasm and @antiphon/protocol (both shipped as .ts) into
# node_modules — verified broken — and its pack rules also drop the
# .gitignored core-wasm/pkg wasm artifacts. A normal pnpm install keeps
# workspace packages as symlinks into packages/*, which Node resolves to
# their real paths outside node_modules, exactly like dev. So: install the
# workspace, build, prune to production deps with a filtered install, and
# copy the pruned workspace (symlinks intact) into the runtime image.

# ---------- builder ---------------------------------------------------------
FROM node:24-bookworm AS builder

# Rust toolchain: rust-toolchain.toml pins 1.96.1 + wasm32-unknown-unknown;
# install the same pin so rustup does not re-download at build time.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
      --default-toolchain 1.96.1 --target wasm32-unknown-unknown

# wasm-pack (pinned): prebuilt musl binary, works on both amd64 and arm64.
RUN set -eux; \
    arch="$(uname -m)"; \
    curl -sSfL "https://github.com/rustwasm/wasm-pack/releases/download/v0.13.1/wasm-pack-v0.13.1-${arch}-unknown-linux-musl.tar.gz" \
      | tar -xz -C /usr/local/bin --strip-components=1 --wildcards "*/wasm-pack"; \
    wasm-pack --version

# pnpm 11.10.0 via corepack (pinned by "packageManager" in package.json).
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable

WORKDIR /app
COPY . .

# Full workspace install (node-datachannel + esbuild builds are allowlisted
# in pnpm-workspace.yaml; node-datachannel fetches its glibc prebuild here —
# this is why the image is Debian, not Alpine).
RUN pnpm install --frozen-lockfile

# Build everything the server needs: @antiphon/core-wasm#build runs
# wasm-pack (Rust -> pkg/); protocol and server have no build step.
RUN pnpm turbo run build --filter=@antiphon/server...

# Prune node_modules to the production deps of the server graph only
# (drops turbo, biome, vite, drizzle-kit, vitest, the web app's deps, ...).
# The wipe is required: pnpm treats the existing full install as up to date
# and would otherwise skip the narrowing --prod --filter install entirely.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules e2e/node_modules \
 && pnpm install --frozen-lockfile --prod --filter=@antiphon/server...

# ---------- runtime ---------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Pruned workspace: root manifests + store, the server, and its two
# workspace deps. COPY preserves the relative symlinks pnpm created.
COPY --from=builder --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/apps/server ./apps/server
COPY --from=builder --chown=node:node /app/packages/core-wasm ./packages/core-wasm
COPY --from=builder --chown=node:node /app/packages/protocol ./packages/protocol

# Writable blob root for BLOB_DRIVER=fs (mount a volume over it in prod).
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8787

# /health round-trips Postgres and the blob store (see src/index.ts).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Migrations run automatically at boot (createServer -> migrateDb) from
# apps/server/drizzle; no separate migrate step exists or is needed.
CMD ["node", "apps/server/src/index.ts"]
