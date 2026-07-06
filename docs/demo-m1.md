# Milestone 1 — the killer demo

Two recorders stream FLAC chunks to two sinks over real WebRTC, the desk
chirps, one recorder loses its network mid-take, reconnects, backfills, and
every sink converges to an identical, complete chunk set. This demo is the
project's heartbeat: if it works, the DAW is the easy 80%.

## Automated (runs in CI)

```sh
docker compose up -d postgres
pnpm build
pnpm --filter @antiphon/e2e exec playwright test m1-demo --project=chromium
```

The spec (`e2e/tests/m1-demo.spec.ts`) drives a desk page and two phone
pages with fake mics, kills phone B's transports for 5 s mid-take (capture
provably continues — the sample counter keeps climbing), stops the take,
then asserts:

- desk OPFS and the server archive hold **complete** sets (`0..=final`,
  zero holes, zero gaps, zero flags) for both streams;
- the sha256 digest over `(seq, crc32c)` pairs is **identical** at both
  sinks — byte-identical chunk sets, not just equal counts;
- the archive serves structurally valid `.flac` for every stream.

## Manual (two iPhones + a Mac)

1. Infrastructure (one terminal each):

   ```sh
   docker compose up -d postgres
   pnpm dev                                   # web :5173 + server :8787
   cloudflared tunnel --url http://localhost:5173
   ```

2. On the Mac, open `https://<tunnel>/` → **Create session**. The desk page
   shows the QR invite.
3. Scan the QR with both iPhones (Safari). Tap **Enable microphone** on
   each; watch them appear in the desk's Performers rail, and confirm the
   capture-flag badges read OFF (see `docs/ios-capture-runbook.md`).
4. Desk: **♫ Chirp** — everyone stays quiet for the two sweeps (this is
   the alignment ground truth landing inside every stream).
5. Desk: **● Record take**. Sing/clap around the room. The stream rows show
   per-sink CHWM/held climbing, status RECONCILING.
6. **The moment**: put phone B in airplane mode (or walk it off WiFi) for
   ~10 seconds. Its screen shows the outage; its seq counter KEEPS
   CLIMBING — capture never gates on the network. Re-enable the network and
   watch the desk row's server/desk held counts sprint to catch up
   (live-first, backfill behind).
7. Desk: **■ Stop take**. Rows flip to **⇥ CONVERGED** (digest-equal at
   both sinks) with FINAL badges and a `.flac` download per stream.
8. Play the downloads. That dropout is inaudible, because it never touched
   the audio — only the transport.

Anything that doesn't match this script is a bug in the heartbeat: file it
before building anything else.
