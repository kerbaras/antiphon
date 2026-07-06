# iOS Safari capture verification (Milestone 0 gate)

Real-iPhone verification of the capture path. Chromium CI proves the
pipeline; this runbook proves the **hostile baseline**: mobile Safari with
its dishonest flags, screen locking, and audio-session quirks.

## Setup

```sh
pnpm dev                     # terminal 1 — vite on :5173 (COOP/COEP on)
cloudflared tunnel --url http://localhost:5173   # terminal 2
```

`cloudflared` prints an `https://<random>.trycloudflare.com` URL — HTTPS is
mandatory for `getUserMedia`, and LAN IPs can't get certificates on iOS.
Open `https://<tunnel>/join/test` on the iPhone in Safari.

## Checks (in order)

1. **Isolation**: footer must read `cross-origin isolated: true`. If false,
   the tunnel/proxy stripped COOP/COEP — capture cannot start.
2. **Enable microphone** → permission prompt → grant.
3. **Capture flags panel**: all three badges (ECHO CANCEL / NOISE SUPP /
   AUTO GAIN) must read **OFF** in green. iOS is known to misreport;
   any `ON!`/`N/A` here goes in the issue log with the iOS version.
4. **Sample rate** shows the context rate (expect 48000 Hz; 44100 on some
   hardware is fine — the stream header carries it).
5. **Record** a ~30 s local take while speaking/clapping at varying
   distance. Watch diagnostics:
   - `dropped samples` stays **0** (non-zero = encoder stall — file a bug),
   - `next seq` advances ~2/s,
   - `capture ring` stays under ~10%.
6. **Stop** → status pill flips to TAKE SAVED (local sink acks make
   DRAINING → CLOSED immediate).
7. **↓ FLAC** → share/download → play on the Mac. Listen for:
   - no gating/pumping (AGC off for real),
   - natural room noise (noise suppression off for real),
   - clean transients on claps (no echo-canceller smearing).
8. **Screen-lock probe** (known risk, architecture §9): start a take, let
   the screen dim/lock, unlock. Note whether `next seq` kept advancing
   while locked and whether `dropped samples`/`empty quanta` jumped.
   Record findings below — the wake lock keeps the screen on, but user
   behavior (pocketing the phone) is the open UX question.

## Findings log

| Date | Device / iOS | Flags honored? | Locked-screen behavior | Notes |
| ---- | ------------ | -------------- | ---------------------- | ----- |
|      |              |                |                        |       |
