# Antiphon

A web-based DAW for recording group sessions: phones act as microphones, a
laptop acts as the mixing desk, a server provides transport reliability and
archival. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Layout

```
packages/              Rust crates (Cargo workspace) + shared TS packages
  core/                antiphon-core: chunk protocol, frames, reconciliation, ring buffer
  codec/               antiphon-codec: FLAC via flacenc (pure Rust)
  dsp/                 antiphon-dsp: correlation (realfft), drift (rubato)
  wasm/                antiphon-wasm: thin wasm-bindgen facade over core/codec/dsp
  protocol/            Zod schemas for all signaling messages (web + server)
  core-wasm/           npm wrapper around the built wasm — the ONLY way TS consumes Rust
apps/
  web/                 Vite + React 19 — desk (/session/:uuid) and phone (/join/:uuid)
  server/              Hono + node-datachannel on Node 24 — signaling, ingest, archive, db
e2e/                   Playwright
docs/                  architecture doc + protocol RFC + design references
```

## Prerequisites

- Node 24 LTS, pnpm 11 (`corepack enable`) — nvm users: `nvm use` (reads
  `.nvmrc`); Node < 24 fails fast (the server runs TS via built-in type
  stripping, so v20 dies with `ERR_UNKNOWN_FILE_EXTENSION` otherwise)
- Rust (pinned by `rust-toolchain.toml`, includes `wasm32-unknown-unknown`)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/)
- Docker (Postgres for the server: `docker compose up -d postgres`)

## Commands

```sh
pnpm install
pnpm build          # turbo: wasm → packages, apps
pnpm dev            # turbo: web + server dev servers
pnpm lint           # biome (lint + format)
pnpm typecheck
pnpm test           # vitest (TS)
pnpm test:rust      # cargo test --workspace
pnpm test:e2e       # playwright
pnpm check          # all of the above
```

Real-iPhone testing needs HTTPS: `cloudflared tunnel --url http://localhost:5173`.

## Key documents

- [docs/rfcs/0001-protocol.md](docs/rfcs/0001-protocol.md) — the wire format (normative)
- [docs/rfcs/0001-amendments-proposed.md](docs/rfcs/0001-amendments-proposed.md) — implementation-driven amendments
- [docs/demo-m1.md](docs/demo-m1.md) — the Milestone 1 demo (automated + two-iPhone runbook)
- [docs/ios-capture-runbook.md](docs/ios-capture-runbook.md) — real-device capture verification
- [docs/design-system.md](docs/design-system.md) — UI tokens, kit, and binding references
