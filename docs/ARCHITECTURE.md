# Antiphon — Architecture & Design Document

**Working concept:** A web-based DAW for recording group sessions (e.g., an amateur choir) where phones act as microphones, a MacBook acts as the mixing desk, and a server provides transport reliability and archival. Monitoring is acoustic — everyone is in the same room hearing each other through air. When the session ends, all tracks are already on disk, aligned, and ready for editing and rendering.

**The name:** _Antiphony_ is call-and-response in choral music — one voice calls, the others answer. The system's chirp calibration is literally an antiphon: the desk calls through its speakers, every phone answers with what it heard, and that response is how the system knows where everyone stands. The name describes the core mechanism, not just the vibe. (Optional future split: **Tutti** as a consumer-facing name over the Antiphon protocol/engine.)

---

## 1. Core Design Principles

These decisions drive everything else. Do not relitigate them casually.

1. **Reliable delivery, not low-latency delivery.** Nobody monitors through the system — monitoring is acoustic. Audio arriving 200ms or 2s late is irrelevant. This means: reliable/ordered transport, generous buffering, and completeness as the only success metric. This single decision is what makes LAN and internet modes share one architecture.
2. **Lossless capture end to end.** No WebRTC media channels for recording — they run Opus tuned for voice and apply processing that destroys music. Raw PCM captured on-device, losslessly compressed, shipped as data.
3. **Alignment is math, not clocks.** Device timestamps are only coarse hints. Precision alignment comes from acoustic cross-correlation (chirp calibration + drift tracking) — which works identically regardless of network path.
4. **Server-first transport, LAN as the bonus path.** The phone→server connection is the reliable one (public IP, no NAT roulette). Phone→desk P2P is the flaky one (venue WiFi client isolation, NAT). Let ICE find the short path when it exists; never depend on it.
5. **One protocol, three topologies.** Sequence-numbered, idempotent chunks + "send me what I'm missing" reconciliation handles: pure LAN, pure internet, and mixed — plus mid-take dropouts. No special cases.
6. **This is a one-shot recording system.** A choir's good take happens once. Every design trade favors never losing audio over elegance, cost, or purity.
7. **Two languages, hard boundary.** TypeScript for everything that talks to humans (UI, signaling, session CRUD); Rust for everything that touches samples (protocol, codec, DSP). No third language, ever, without a written justification. See §7.

---

## 2. System Components

### 2.1 Phone (recorder client)

- Browser web app (mobile Safari is the hostile baseline — build for it first).
- **Capture:** `getUserMedia` with `echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`. Raw PCM via **AudioWorklet** (never MediaRecorder, never WebRTC media tracks).
- **Thread topology (settled):** the AudioWorklet stays ~50 lines of TS — copy input frames into a SharedArrayBuffer ring, bump an atomic index, nothing else. The **FLAC WASM encoder lives in a Web Worker** that reads the ring. WASM never runs inside the worklet: this keeps the audio thread allocation-free (a stalled encoder can't drop samples) and sidesteps the worklet-bundling swamp.
- **Encode:** FLAC via `flacenc` (pure Rust, no C toolchain) compiled to WASM. Lossless, ~50% size cut. 48kHz/24-bit mono raw is ~1.2 Mbps per phone / ~4GB per 10-phone 45-min session — FLAC matters for metered cellular.
- **Ring buffer:** last ~30–60s of encoded audio kept in memory. Not the full take — just enough to backfill after a network dropout. A few MB of RAM buys the entire resilience story.
- **Ship:** chunks with sequence numbers + capture timestamps over WebRTC **DataChannels** (reliable/ordered mode), continuously.

### 2.2 MacBook (mixing desk)

- Browser web app: React UI + audio engine.
- **Audio engine:** Web Audio API + AudioWorklets first. WASM (Rust) only for profiled hot paths: cross-correlation/alignment, time-stretch, pitch shift, offline render. The critical boundary is main-thread ↔ audio-thread, not React ↔ WASM.
- Same topology rule as the phone: worklets stay thin; WASM compute lives in workers connected via **SharedArrayBuffer ring buffers** — which requires COOP/COEP headers and cross-origin isolation **from day one** (retrofitting breaks lazily-loaded third-party scripts).
- **Ingest:** receives chunks (directly from phones over LAN when ICE allows, otherwise forwarded by server), appends to disk immediately. At take end, files are ~1–2s behind real time and already complete.
- **Session-start chirp:** plays a calibration chirp through its speakers (see §4).
- Ideally also records a **room reference mic** (its own input) — the drift-correction reference.

### 2.3 Server

- **Runtime (settled):** Node 24 LTS. Not Bun for the server process — node-datachannel's native bindings are the one dependency not worth gambling on (Bun stays fine for scripts).
- **Signaling:** Hono for HTTP + WebSocket — session routes `example.com/session/{uuid}` (desk) and `example.com/join/{uuid}` (phones), ICE relay.
- **Ingest (settled):** **node-datachannel** (wraps libdatachannel — battle-tested C++ doing DTLS/SCTP; JS only orchestrates). Phones connect here essentially always (public IP → no TURN needed for this leg). Ingest module kept architecturally isolated: it is the one piece designated for extraction to Axum + webrtc-rs _if_ hosted-product scale ever demands it — the idempotent protocol makes that swap boring.
- **Raw archive:** every chunk persisted. Source of truth. Metadata in **Postgres (Drizzle ORM)**; blobs in **Cloudflare R2** (free egress — the desk pulls gigabyte sessions back down; that's the bill S3 would love to send).
- **Forwarding:** relays chunks to the desk live. If desk received chunks directly over LAN, desk trickles them up afterward. Reconciliation = idempotent chunk sync in either direction.
- Cost reality: a hobby-scale deployment is a ~$10 VM + storage. The trade accepted: this is real infrastructure, not "server is only signaling." Worth it — the failure modes it kills are exactly the ones that destroy an unrepeatable take.

---

## 3. Transport

- **WebRTC DataChannels for all audio movement.** Chosen not for latency but because: (a) DTLS is built in, dodging the HTTPS-page-can't-open-`ws://`-to-LAN-IP mixed-content trap and the impossibility of TLS certs for `192.168.1.x` on iOS Safari; (b) ICE gives "shortest path possible" for free.
- **ICE does the routing — don't rebuild it.** Offer phone→desk alongside phone→server. Candidate preference (host > server-reflexive > relay) means true-LAN sessions get direct P2P automatically; hostile networks fall back to the server without anyone noticing.
- **Reliable/ordered DataChannel mode.** WiFi hiccup → chunks queue and catch up. Disconnect → reconnect, desk/server reports highest contiguous sequence, phone backfills from ring buffer.
- **WebRTC media channels: never for recording.** Acceptable only for optional convenience monitoring of the host mix, which is a nice-to-have, not the product.

---

## 4. Alignment (the actual hard problem, layered)

Mobile input latency is unknown, dishonestly reported (especially iOS), and varies per device. Solve in three layers:

1. **Clock sync (coarse).** NTP-style ping over the DataChannel. Over the internet, jitter increases — use minimum-RTT samples. Gets timestamps within a few ms; used only for coarse chunk placement on ingest.
2. **Chirp calibration (precise).** At session start the desk plays a chirp through its speakers; every phone captures it acoustically; cross-correlation nails each device's total offset _including_ its unknown input latency. Because the chirp travels through air, this works identically whether the phone's data routes over LAN or through a server on another continent. (This is the antiphon the project is named for.)
3. **Drift correction (non-negotiable).** Every phone's ADC clock runs at a slightly different rate. Over a 45-minute session, uncorrected drift reaches tens of ms — audible smear on a choir. Re-correlate a short window every ~30s against the reference (desk's room mic ideally), fit a per-phone resample ratio, apply at render. This is a legitimate WASM workload.

**Physics footnote:** chirp alignment aligns phones to _the room_. Sound travels ~34cm/ms. Phones near their singers is fine — arguably correct. Do not chase sample-accurate phase coherence between mics meters apart; that's air, not a bug.

---

## 5. DAW Engine & Editing

- **Start pure Web Audio API** for mixing, effects, timeline playback. It goes shockingly far. Profile before porting anything.
- **WASM (Rust) hot paths, in priority order:** FLAC encode (phone side — the first _justified_ WASM component, and it landed on the phone, not the desk), cross-correlation/alignment engine, time-stretch/pitch-shift, offline analysis and final render.
- **React UI** talking to the engine — fine, but remember the UI thread is never the audio thread.

---

## 6. Project State & Collaboration

- Clips, edits, mixer moves = **CRDT problem**. Use **Yjs** over WebSocket or a DataChannel.
- Audio blobs are **content-addressed assets** referenced from the CRDT doc — never inside it.

---

## 7. Technology Stack (settled)

**The rule: two languages, hard boundary.** TypeScript talks to humans; Rust touches samples. Every layer below falls out of that rule.

| Layer     | Pick                                                                                                                                          | Rationale (short)                                                                                                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust core | Cargo workspace `antiphon-core`: `core` (chunk protocol, framing, ring buffer), `codec` (flacenc), `dsp` (realfft, rubato)                    | One codebase compiling to: WASM (browser + Node), later native iOS/Android via UniFFI, later napi-rs server bindings. Protocol logic written once, never reimplemented in TS.                                              |
| Frontend  | Vite 7 + React 19 (compiler on) + TS strict, Zustand, Yjs, Tailwind                                                                           | React Compiler kills memo hand-tuning; Redux is ceremony. One web app serves desk + phone as routes.                                                                                                                       |
| Server    | Node 24 LTS + Hono + node-datachannel, Drizzle + Postgres                                                                                     | I/O-bound control plane; the perf-critical DTLS/SCTP is libdatachannel (C++) underneath. TS server shares `packages/protocol` Zod schemas with the frontend — a message-shape change is a compile error in every consumer. |
| Storage   | Postgres (metadata) + Cloudflare R2 (blobs)                                                                                                   | R2's free egress is the point — sessions are gigabytes and the desk re-downloads them.                                                                                                                                     |
| Deploy    | Frontend: Cloudflare Pages (with COOP/COEP `_headers`). Server: Fly.io or Hetzner VM — **real UDP required for WebRTC; serverless is a trap** | Long-lived stateful UDP ≠ Lambda.                                                                                                                                                                                          |
| Monorepo  | pnpm 10 + Turborepo 2 + Biome; wasm-pack builds `rust/wasm` → `packages/core-wasm` npm package                                                | Full layout, build pipeline, and dev-loop details live in the companion scaffolding doc.                                                                                                                                   |
| Dev loop  | `cloudflared tunnel` for real-iPhone HTTPS testing                                                                                            | Solves getUserMedia-needs-HTTPS + no-certs-for-LAN-IPs in one command; exercises the internet ICE path as a side effect.                                                                                                   |

**Why the encoder is Rust, not Go:** Go ships its runtime (GC, scheduler) inside every WASM binary — 2MB+ before one line of encoder, downloaded on cellular before recording can start; TinyGo limps. Rust emits runtime-free WASM in the tens of KB with **no GC pauses** — and a GC pause one hop from a real-time pipeline means a dropped chunk in a one-shot recording. Determinism is the requirement, not a taste. Plus: the audio DSP ecosystem lives in Rust; the same crates go native on mobile via UniFFI, where gomobile is a permanent fight.

**Why the server is TS, not Go/Pion:** honesty first — Pion is the most mature WebRTC stack available and wins that round outright. It loses the match on: (a) a third language in a two-language project is a permanent tax; (b) Go shares code with nothing here — no Zod/type sharing with the frontend, no clean Rust-core reuse (cgo is misery); (c) if the server ever needs real compute, `antiphon-core` binds into Node via napi-rs — the Rust investment already covers the server's future, a move Go can't make. Escape hatch on record: at hosted-product scale, extract the (deliberately isolated) ingest module to Axum + webrtc-rs.

**Future mobile app:** the web app on mobile Safari _is_ the mobile product until backgrounding forces a native shell. Then: React Native (Expo) as a thin capture driver + UI, with `antiphon-core` compiled natively via UniFFI — encoder, chunker, ring buffer, protocol all identical and already tested. A capture driver, not a rewrite.

---

## 8. Session Model

- `antiphon.com/session/{uuid}` — desk creates/hosts a session.
- `antiphon.com/join/{uuid}` — phones join (QR code from the desk screen is the obvious UX).
- App + signaling hosted publicly (tiny traffic). Audio flows over whatever path ICE negotiates.

---

## 9. Failure Modes & Answers

| Failure                                | Answer                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| WiFi hiccup mid-take                   | Reliable/ordered channel queues; chunks catch up seconds later                           |
| Full disconnect mid-take               | Phone ring buffer + backfill on reconnect ("I have up to chunk N")                       |
| Venue WiFi client isolation blocks P2P | Server path always available; ICE falls back silently                                    |
| Phone on cellular, desk behind NAT     | Same — server leg connects without TURN                                                  |
| Desk offline / crashes                 | Server archive is source of truth; session recoverable                                   |
| Metered cellular data cost             | FLAC halves it; mono capture                                                             |
| iOS lies about input latency           | Chirp calibration measures it acoustically                                               |
| Clock drift over long takes            | Periodic re-correlation + per-phone resample ratio                                       |
| Encoder stall / GC-style pause         | Impossible by construction: thin worklet + SAB ring + runtime-free Rust WASM in a worker |
| Backgrounded Safari tab kills capture  | **Open risk** — needs wake-lock + screen-on UX guidance; test early                      |

---

## 10. What Was Rejected (and why)

- **WebRTC media streams for recording** — Opus voice tuning + AEC/AGC = phone call, not a recorder.
- **Record-locally-then-upload** — user requirement: recording is complete at session end. Continuous chunk streaming with a small ring buffer achieves it with better resilience than either extreme.
- **Zero on-phone storage** — one dropout would put a permanent hole in a take. 30–60s ring buffer is the compromise.
- **Pure P2P with server-as-signaling-only** — traded away deliberately for reliability. Client isolation and NAT make phone→desk the flaky leg.
- **Timestamp-only alignment** — device latencies are unknown/dishonest. Acoustic correlation is the ground truth.
- **WASM-first engine build** — pre-optimizing CPU while the real dragons are mobile Safari audio APIs, capture flags, and drift.
- **Go/Pion for the server** — best WebRTC stack, wrong project shape: third-language tax, zero code sharing with frontend or Rust core. Escape hatch documented in §7.
- **Go/TinyGo for the WASM encoder** — runtime-in-binary bloat + GC pauses next to a real-time pipeline. Not close.
- **Bun as the server runtime** — node-datachannel native-addon compatibility is not a place to be adventurous. Bun allowed for tooling/scripts.
- **WASM inside the AudioWorklet** — bundling swamp + allocation risk on the audio thread. Thin worklet → SAB ring → WASM worker instead.
- **Serverless for the ingest/signaling server** — WebRTC needs long-lived stateful UDP; Lambda-shaped platforms structurally can't.
- **Live jamming over the internet** — physics. <15ms needed, internet gives 30–100ms+. Out of scope permanently.

---

## 11. Validation Roadmap (build ugliest-first)

1. **Milestone 0 — capture truth:** record raw PCM on an iPhone in Safari (all processing flags off) via AudioWorklet. Verify quality and that flags are honored. (Dev loop: cloudflared tunnel.)
2. **Milestone 1 — the killer demo:** two iPhones streaming FLAC chunks to the Mac over DataChannels, chirp alignment, then **kill WiFi on one phone mid-take and watch it backfill.** If this works, the DAW is the easy 80%.
3. **Milestone 2 — internet leg:** same demo with one phone on cellular routing through the server; verify chirp alignment is unaffected by path.
4. **Milestone 3 — drift:** 45-minute two-phone take; measure raw drift, then verify correction holds a choir-grade alignment tolerance.
5. **Milestone 4 — desk MVP:** multitrack timeline, gain/pan/basic EQ in Web Audio, offline render.
6. **Milestone 5 — collaboration:** Yjs project doc, multi-editor session, content-addressed audio assets.

Pre-milestone foundation (from the scaffolding doc's bootstrap order): the chunk protocol in `rust/core` gets a **proptest suite** — random drops, reorders, and duplicates must always reconcile — _before_ any network code exists. That suite is what makes Milestone 1 a demo instead of a prayer.

---

## 12. Open Questions

- iOS Safari backgrounding / screen-lock behavior during long captures — mitigation UX needed.
- Server storage lifecycle and retention (sessions are gigabytes; who pays, how long).
- Whether the desk's room-reference mic is required or optional for drift correction (fallback: correlate phones against each other).
- Max practical phone count per session (router + server ingest ceiling) — likely fine to ~10–20, verify.
- SharedArrayBuffer isolation constraints vs. any third-party embeds planned for the app shell.
- Trademark/domain search for "Antiphon" before public commitment.

---

_Companion document: `antiphon-scaffolding-2026.md` — monorepo layout, toolchain versions, build pipeline, and first-week bootstrap order._
