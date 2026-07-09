# Deploying Antiphon

Antiphon is three deployables: the **web app** (static Vite build → Cloudflare
Pages, needs COOP/COEP headers for SharedArrayBuffer), the **server** (Node 24,
Hono + node-datachannel; signaling over WSS, WebRTC ingest over **real UDP**,
archive in Postgres + blobs), and **Postgres**. The UDP requirement decides the
topology: WebRTC ingest terminates in the server process on wildcard ephemeral
UDP ports, so the server runs on a **plain Linux VM with a public IP bound to
its NIC** (Hetzner et al.), with Docker host networking. Caddy terminates
TLS/WSS for HTTP traffic only — media UDP goes straight to the host. Blobs go
to Cloudflare R2 (free egress). Fly.io is not a viable ingest target (below).

One important repo fact: the web app is **same-origin by design** — it fetches
`/api/*` and opens WebSockets to `location.host`
(`apps/web/src/net/signaling-client.ts`). So the public app origin must serve
both frontend and backend. The Caddyfile does exactly that: backend paths →
`localhost:8787`, everything else → your Pages deployment (or a local copy of
`dist/`, option B in `deploy/Caddyfile`).

---

## 1 · Frontend — Cloudflare Pages

Build settings if you let Pages build it:

| setting          | value           |
| ---------------- | --------------- |
| build command    | `pnpm build`    |
| build output dir | `apps/web/dist` |

**Honest caveat:** `pnpm build` runs the full turbo graph, and
`@antiphon/core-wasm#build` invokes `wasm-pack` against the pinned Rust
toolchain (`rust-toolchain.toml`: 1.96.1 + `wasm32-unknown-unknown`). The Pages
build image is not guaranteed to provide rustup/wasm-pack (or the right
versions). If the Pages build fails on the Rust step, use the reliable path —
build in GitHub Actions and upload with wrangler:

```yaml
# .github/workflows/pages.yml (sketch)
- uses: dtolnay/rust-toolchain@stable   # reads rust-toolchain.toml
- run: cargo install wasm-pack --version 0.13.1 --locked
- run: corepack enable && pnpm install --frozen-lockfile
- run: pnpm build
- run: npx wrangler pages deploy apps/web/dist --project-name=antiphon
```

Headers are handled by `apps/web/public/_headers`, which Vite copies verbatim
into `dist/`. It sets COOP/COEP on `/*` (cross-origin isolation —
SharedArrayBuffer dies without it), immutable caching on hashed `/assets/*`,
and `no-cache` on the HTML shell. Verify after any build:
`ls apps/web/dist/_headers`.

Because of the same-origin constraint, users never browse `*.pages.dev`
directly — the VM's Caddy proxies the frontend from Pages under your real
domain (Pages responds with `_headers` intact and they pass through). Set your
Pages hostname in `deploy/Caddyfile`.

## 2 · Server — VM runbook

### 2.1 Provision

- Any Debian/Ubuntu VM with a **public IP on the interface** (Hetzner default).
  Avoid 1:1-NAT providers (EC2/GCP) — see §5 WEBRTC_PUBLIC_IP.
- Install Docker Engine + compose plugin.
- DNS: `A`/`AAAA` record for your domain → the VM.
- Firewall (e.g. `ufw`):
  - allow `22/tcp` (SSH), `80/tcp` + `443/tcp` (Caddy; 80 is needed for ACME),
  - allow the **ephemeral UDP range** `32768:60999/udp` — WebRTC ICE/DTLS
    lands on kernel-assigned ephemeral ports (`net.ipv4.ip_local_port_range`),
  - do **not** expose `8787/tcp` (Caddy reaches it on localhost) or
    `5432` (Postgres is bound to `127.0.0.1` only).

### 2.2 Configure

```sh
git clone <repo> antiphon && cd antiphon
cp deploy/.env.prod.example .env.prod   # fill in — see checklist
$EDITOR deploy/Caddyfile                # set your domain + Pages hostname
```

`.env.prod` checklist (SECRET = generate per deploy, never commit):

| var | value | secret |
| --- | ----- | ------ |
| `POSTGRES_USER` / `POSTGRES_DB` | `antiphon` | |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` | ✦ |
| `DATABASE_URL` | `postgres://antiphon:<same password>@localhost:5432/antiphon` | ✦ |
| `PORT` | `8787` | |
| `BLOB_DRIVER` | `s3` (R2, §3) — or `fs` + `BLOB_FS_ROOT=/data/blobs` + compose volume | |
| `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` | |
| `S3_BUCKET` | your R2 bucket | |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | R2 API token pair | ✦ |
| `S3_REGION` | `auto` | |
| `LOG_LEVEL` | `info` (JSON lines on stdout) | |
| `CORS_ORIGINS` | `https://your-domain` — unset allows ALL origins | |
| `TRUST_PROXY` | `1` — Caddy fronts all HTTP, rate limits key on `X-Forwarded-For` | |
| `JOIN_RATE_PER_MIN` / `JOIN_RATE_BURST` | `30` / `10` | |
| `SIGNALING_MSG_RATE_PER_SEC` / `SIGNALING_MSG_BURST` | `100` / `200` | |
| `MAX_PEERS_PER_SESSION` / `MAX_ACTIVE_SESSIONS` | `32` / `200` | |
| `SESSION_TTL_HOURS` | `720` (30 days; idle sessions hard-deleted, blobs + rows) | |
| `SESSION_SWEEP_INTERVAL_MS` | `600000` | |
| `COLLAB_IDLE_EVICT_MS` | `900000` (15 min; zero-desk Yjs rooms flushed to Postgres, then dropped from memory — rejoins rebuild transparently) | |

### 2.3 Run

```sh
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
curl -fsS https://your-domain/health   # {"ok":true,"db":true,"blob":true}
curl -fsS https://your-domain/ready    # {"ready":true}
```

Notes:

- **Migrations run automatically at boot** (`createServer → migrateDb`,
  `apps/server/src/db/index.ts`), before the server accepts traffic. There is
  no separate migrate step; deploys are `up -d --build`.
- Graceful deploys: `docker compose ... up -d --build server` sends SIGTERM;
  the server drains WS peers, closes ingest, closes the DB pool, and exits 0
  (hard timeout 10 s).
- The image healthcheck polls `/health`, which round-trips Postgres **and**
  the blob store, so `docker ps` shows `unhealthy` when either dependency is
  actually broken.

## 3 · Blobs — Cloudflare R2

1. Cloudflare dashboard → R2 → **Create bucket** (e.g. `antiphon-blobs`; keep
   it private — the server is the only client).
2. R2 → **Manage API tokens** → create a token scoped to that bucket with
   **Object Read & Write** → gives an Access Key ID + Secret Access Key.
3. Map to env (the server's S3 client reads these directly):

```
BLOB_DRIVER=s3
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_BUCKET=antiphon-blobs
S3_ACCESS_KEY_ID=<token key id>
S3_SECRET_ACCESS_KEY=<token secret>
S3_REGION=auto
```

Keys are `takeId/streamId/seq` wire frames; deletion is handled by the
server's retention sweep and the hard-delete API — don't add an R2 lifecycle
rule that races it (an "abort multipart uploads after 7 days" rule is fine).

At boot the server checks the bucket (`ensureBucket`): it creates a missing
bucket when the token allows, warns-and-continues on AccessDenied (typical
for bucket-scoped R2 tokens — create the bucket in the dashboard first), and
refuses to start if the endpoint is unreachable. Local development can
exercise this exact driver against MinIO (`docker compose up -d minio` +
`S3_FORCE_PATH_STYLE=1`, see the README) — prod stays on R2, where
path-style stays off.

## 4 · Backups

Postgres (nightly `pg_dump`, 14-day rotation) — on the VM:

```sh
cat >/etc/cron.d/antiphon-pgdump <<'EOF'
0 3 * * * root docker compose --env-file /opt/antiphon/.env.prod -f /opt/antiphon/docker-compose.prod.yml exec -T postgres pg_dump -U antiphon antiphon | gzip > /var/backups/antiphon-$(date +\%F).sql.gz; find /var/backups -name 'antiphon-*.sql.gz' -mtime +14 -delete
EOF
```

Ship the dumps off-box (e.g. `rclone` to a second R2 bucket). Blob bytes
already live in R2 (11-nines durability); for belt-and-braces, replicate the
bucket periodically (`rclone sync r2:antiphon-blobs r2:antiphon-blobs-backup`)
— but remember the retention sweep deletes on purpose, so backups of blobs
must be point-in-time copies, not mirrors you prune from.

## 5 · WEBRTC_PUBLIC_IP (read this before picking a provider)

**Verdict (investigated, W5-A): a public IP bound to the NIC is a hard
requirement.** Ingest creates `PeerConnection(..., { iceServers: [] })`
(`apps/server/src/ingest/index.ts`): the only candidates the server offers
are the **host addresses actually bound to its NICs**. On a Hetzner-style VM
the public IP is on the interface, so this just works. Behind 1:1 NAT
(EC2, GCP, most cloud LBs) the server advertises its private address and
phones can never reach it.

`WEBRTC_PUBLIC_IP` **cannot be wired**: the whole stack lacks an
external-address hint. node-datachannel 0.32.x passes exactly its typed
`RtcConfig` fields to libdatachannel; libdatachannel v0.24's
`rtc::Configuration` has no externalAddress / NAT-mapping option; and
libjuice's ICE-agent config (`juice_config_t`) has none either — only its
standalone TURN server takes an `external_address`. The server therefore
treats the var as recognized-but-unsupported: setting it logs a startup
WARN (so a misconfigured EC2 deploy fails loudly, not mysteriously) and
changes nothing else. If upstream ever grows the API (the equivalent of
Pion's `SetNAT1To1IPs` / mediasoup's `announcedIp`), the config plumbing
and tests are already in place. Until then: **pick a public-IP-on-NIC VM.**
An `iceServers` STUN entry *is* exposed today and would yield a
server-reflexive candidate through 1:1 NAT — deliberately not wired: it
adds a third-party runtime dependency plus gathering latency to every
connection, for a topology we do not support.

## 6 · Why not Fly.io

Fly's UDP path requires apps to bind the special `fly-global-services`
address (with a dedicated IPv4 and internal port == external port), but
node-datachannel/libdatachannel binds its ICE sockets to wildcard ephemeral
ports and cannot be pointed at that address — so WebRTC ingest can never
complete a connection on Fly today. Fly remains fine for the HTTPS/WSS
control plane alone, but since audio ingest is the entire point, we don't
ship a fly.toml; deploy to a VM.

## 7 · Production checklist

- [ ] `CORS_ORIGINS` set to the exact app origin(s) — never unset in prod
      (unset = allow all; the server logs a startup warning).
- [ ] `TRUST_PROXY=1` (behind Caddy) so rate limits key on real client IPs.
- [ ] `LOG_LEVEL=info` (or `warn`); logs are JSON on stdout →
      `docker compose logs`.
- [ ] Rate limits / caps sized for the event: `MAX_PEERS_PER_SESSION` ≥ choir
      size, `JOIN_RATE_PER_MIN` ≥ expected joins-per-IP-per-minute (shared
      venue Wi-Fi = one IP for everyone).
- [ ] `SESSION_TTL_HOURS` matches your data-retention promise — the sweep
      **hard-deletes** blobs + rows past the TTL.
- [ ] Secrets (`POSTGRES_PASSWORD`, `DATABASE_URL`, `S3_*` keys) live only in
      `.env.prod` on the VM (gitignored) / your secret manager.
- [ ] Firewall: 80+443/tcp + ephemeral UDP open; 8787 and 5432 closed.
- [ ] `/health` and `/ready` return 200 through the public domain.
- [ ] `apps/web/dist/_headers` deployed; verify in the desk console:
      `crossOriginIsolated === true`.
- [ ] Backups cron installed and a restore actually tested once.
