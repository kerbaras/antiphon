# The Antiphon Protocol

**draft-antiphon-core-01 — July 2026**
**Status:** Draft. Normative for `rust/core` and `packages/protocol`.
**Companion docs:** `antiphon-architecture.md` (design rationale), `antiphon-scaffolding-2026.md` (build).

---

## Abstract

Antiphon is a protocol for reliable, lossless, multi-device audio capture over unreliable networks. Recorder devices (typically phones) capture raw PCM, encode it losslessly, and ship it as sequence-numbered, idempotent chunks to one or more sinks (a mixing desk and/or an archive server). The protocol optimizes for **completeness, not latency**: monitoring is acoustic (all participants share a room), so delivery may lag real time by seconds without consequence. Precise inter-device alignment is achieved acoustically (chirp calibration and drift correlation) and is therefore independent of network path; the protocol's role in alignment is limited to coarse clock sync and metadata carriage.

A recording take is complete when every sink holds a contiguous chunk sequence for every stream. The protocol's single design law: **a take that happened once must survive anything short of simultaneous failure of every sink.**

---

## 1. Conventions

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL are to be interpreted as described in RFC 2119.

All multi-byte integers in the data plane are **little-endian**. (Rationale: every deployment target — x86-64, ARM64, WASM — is little-endian; network byte order would buy tradition and cost swaps on every hot path.)

All UUIDs are 16-byte binary UUIDv4 on the wire, lowercase-hyphenated strings in the control plane.

All timestamps are unsigned microseconds unless stated otherwise.

## 2. Terminology

| Term                                  | Definition                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| **Session**                           | A rendezvous identified by a session UUID. Contains zero or more takes.             |
| **Take**                              | One continuous recording, identified by a take UUID. The unit of completeness.      |
| **Recorder**                          | A device capturing audio (phone). Produces exactly one stream per take per input.   |
| **Desk**                              | The operator's device (MacBook). A sink, and the session's control authority.       |
| **Server**                            | The always-reachable sink providing archive and forwarding.                         |
| **Sink**                              | Any receiver that persists chunks: desk or server.                                  |
| **Stream**                            | One recorder input within one take, identified by a stream UUID.                    |
| **Chunk**                             | The atomic unit of audio transfer: a header plus an integral number of FLAC frames. |
| **Chunk key**                         | The tuple `(take_id, stream_id, seq)`. Globally unique, immutable, idempotent.      |
| **Contiguous high-water mark (CHWM)** | Highest `seq` such that a sink holds all chunks `0..=seq` for a stream.             |

## 3. Architecture Overview

```
                     control plane (WSS, JSON)
        ┌────────────────────┬──────────────────────┐
        │                    │                      │
   ┌────┴────┐         ┌─────┴─────┐          ┌─────┴─────┐
   │Recorder │  ICE    │   Desk    │   ICE    │  Server   │
   │ (phone) │◄───────►│  (sink)   │◄────────►│  (sink)   │
   └────┬────┘         └─────▲─────┘          └─────▲─────┘
        │   data plane       │    sink-sync         │
        └────────────────────┴──────────────────────┘
          WebRTC DataChannels, binary frames (§6)
```

- Recorders open data channels toward **every reachable sink** and transmit each chunk to at least one; sinks replicate among themselves (§8).
- ICE determines the path. Recorders MUST NOT assume the desk is reachable; the server SHOULD always be.
- The desk is the control authority: it opens/closes takes and triggers calibration. If the desk is absent, the server MAY act as authority (headless session).

## 4. Transport Bindings

### 4.1 Control plane

JSON messages over WebSocket Secure (WSS) to the server: desk connects via `/session/{uuid}`, recorders via `/join/{uuid}`. The server relays ICE signaling between peers and fans out session events. Message schemas are defined normatively as Zod schemas in `packages/protocol`; §5 lists them informatively.

### 4.2 Data plane

WebRTC DataChannels in **reliable, ordered** mode. Channel label: `antiphon/1`.

- **One data-plane frame per DataChannel message.** Frames are not length-prefixed and MUST NOT be concatenated or fragmented at the protocol layer; message boundaries come from SCTP.
- A frame MUST NOT exceed **65,536 bytes** (`MAX_FRAME_BYTES`). This bound drives nominal chunk duration (§6.3).
- Although the channel is ordered, receivers MUST NOT rely on ordering for correctness: backfill (§8) legitimately interleaves old sequence numbers with live ones. All receiver state is keyed by chunk key.
- Sink↔sink replication uses the identical frame formats over a channel labeled `antiphon-sync/1` (server↔desk), or plain HTTPS batch transfer as a fallback; frames are transport-agnostic bytes.

## 5. Control Plane Messages (informative summary)

All messages: `{ "v": 1, "type": string, ...fields }`. Unknown `type` MUST be ignored.

| Type                                         | Direction   | Purpose / key fields                                                     |
| -------------------------------------------- | ----------- | ------------------------------------------------------------------------ |
| `hello`                                      | peer→server | `role` (`desk`\|`recorder`), `deviceInfo`, `protocolVersions: number[]`  |
| `welcome`                                    | server→peer | Chosen protocol version, session state snapshot, peer list               |
| `ice-offer` / `ice-answer` / `ice-candidate` | relayed     | Standard WebRTC signaling, addressed by peer id                          |
| `take-start`                                 | desk→all    | `takeId`, `wallClockHint` (ISO 8601) — recorders arm and begin streaming |
| `take-stop`                                  | desk→all    | `takeId` — recorders enter DRAINING (§7)                                 |
| `calibration-chirp`                          | desk→all    | `chirpId`, `emitTsDeskUs`, `spec` (see §10)                              |
| `peer-status`                                | server→all  | Join/leave/connection-quality fanout                                     |
| `error`                                      | any         | `code`, `message`, optional `fatal`                                      |
| `bye`                                        | any         | Graceful departure                                                       |

Version negotiation happens exclusively here: the server picks the highest version common to all `protocolVersions` sets. Data-plane frames carrying a different version MUST be rejected with a control-plane `error`.

## 6. Data Plane Wire Format

### 6.1 Common frame header (4 bytes)

```
 0               1               2               3
 +---------------+---------------+---------------+---------------+
 |     0x41 'A'  |    0x4E 'N'   |  version=0x01 |  frame type   |
 +---------------+---------------+---------------+---------------+
```

Frames with bad magic MUST be discarded. Frames with unknown `frame type` MUST be ignored (extensibility). Frame types:

| Code        | Frame                    |
| ----------- | ------------------------ |
| `0x01`      | AUDIO_CHUNK              |
| `0x02`      | ACK_STATUS               |
| `0x03`      | BACKFILL_REQUEST         |
| `0x04`      | GAP_REPORT               |
| `0x05`      | TIME_PING                |
| `0x06`      | TIME_PONG                |
| `0x07`      | HAVE_SUMMARY             |
| `0x08–0x7F` | Reserved                 |
| `0x80–0xFF` | Private/experimental use |

### 6.2 AUDIO_CHUNK (0x01)

```
offset  size  field
 4      16    take_id            (UUID)
20      16    stream_id          (UUID)
36       4    seq                (u32)
40       8    first_sample_index (u64, take sample domain)
48       4    sample_count       (u32)
52       8    capture_ts_us      (u64, recorder monotonic clock)
60       4    crc32c             (u32, over payload only)
64       4    payload_len        (u32)
68       n    payload
```

**Sequence 0 is the stream header, not audio.** Its payload is a self-describing codec configuration: FLAC STREAMINFO, sample rate, bit depth, channel count (MUST be 1 in v1), recorder device description, and the recorder's clock-domain epoch. `first_sample_index` and `sample_count` are 0. Every stream MUST begin with seq 0, and because seq 0 rides the same reconciliation machinery as everything else, a sink can always recover the decode context.

**Audio chunks (seq ≥ 1):**

- Payload MUST contain an integral number of FLAC frames; a FLAC frame MUST NOT span chunks. Together with `first_sample_index`, this makes reconstruction exact concatenation with zero decode-state carryover.
- `first_sample_index` MUST equal the previous chunk's `first_sample_index + sample_count`. Sinks use this as a consistency check; a violation is a fatal stream error (recorder bug), reported via control plane.
- `capture_ts_us` is a hint for coarse placement only. Alignment truth is acoustic (§10).

**Idempotency law:** a chunk key MUST map to exactly one immutable payload for all time. Senders MUST NOT reuse a `seq` with different content. Receivers MUST treat a duplicate key as a no-op (and MAY verify `crc32c` matches; a mismatch is a fatal protocol violation). This law is what makes every other mechanism — retransmission, replication, multi-path send, crash recovery — trivially safe.

### 6.3 Chunk sizing

Nominal chunk duration is **500 ms** (`NOMINAL_CHUNK_MS`). At 48 kHz/24-bit mono FLAC (~600 kbps typical), that is ~38 KB — comfortably under `MAX_FRAME_BYTES` with headroom for incompressible passages. An encoder producing a chunk that would exceed the bound MUST split it early (chunks are variable-duration by design; only `first_sample_index` continuity matters). Recorders SHOULD NOT emit chunks shorter than 100 ms except the final chunk of a take.

### 6.4 ACK_STATUS (0x02) — sink → recorder

```
 4      16    take_id
20      16    stream_id
36       4    chwm               (u32; contiguous high-water mark, 0xFFFFFFFF = nothing yet)
40       2    hole_count         (u16)
42       8×n  holes              (n pairs of u32 start_seq, u32 end_seq, inclusive)
```

Sent every **2 s** (`ACK_INTERVAL_MS`) per active stream, immediately on reconnect, and on take close. Holes above the CHWM tell the sender exactly what to retransmit without waiting for CHWM to advance.

### 6.5 BACKFILL_REQUEST (0x03) — sink → recorder

Same layout as ACK_STATUS minus `chwm`: an explicit list of ranges the sink wants now. Senders satisfy from the ring buffer via ordinary AUDIO_CHUNK frames (idempotency makes duplicate delivery across multiple sinks harmless).

### 6.6 GAP_REPORT (0x04) — recorder → sink

Same range-list layout. Declares ranges **permanently unavailable** (evicted from the ring buffer before any sink acknowledged them). Sinks MUST record the gap in take metadata and stop requesting those ranges. A GAP_REPORT is the protocol admitting defeat; see §9 for why it should be nearly impossible.

### 6.7 TIME_PING (0x05) / TIME_PONG (0x06)

```
PING:  4  4  ping_id (u32)   8  t1 (u64, sender clock)
PONG:  4  4  ping_id         8  t1 (echo)   8  t2 (recv)   8  t3 (send)
```

NTP-style. Initiator computes offset/RTT; over jittery paths it MUST filter by minimum RTT across a sliding window (RECOMMENDED: best of the last 16 samples, pinged every 5 s). Output feeds coarse chunk placement only.

### 6.8 HAVE_SUMMARY (0x07) — sink ↔ sink

Range-list layout (as §6.5) enumerating ranges the sender **holds** for a stream. On session reconnect or take close, sinks exchange HAVE_SUMMARY, compute set differences, and push missing chunks to each other as AUDIO_CHUNK frames. Replication direction is data-driven, not role-driven: whoever has bytes the other lacks, sends.

## 7. Take Lifecycle (recorder stream state machine)

```
IDLE ──take-start──► ARMED ──seq 0 sent──► STREAMING ──take-stop──► DRAINING ──all sinks CHWM=final──► CLOSED
                                              │                        │
                                        (disconnect)             (ring exhausted
                                              │                   w/ unacked data)
                                              ▼                        ▼
                                        STREAMING*                GAP + CLOSED
                                     (capture continues,
                                      ring accumulates)
```

Normative rules:

1. On `take-start`, a recorder MUST begin capture immediately and MUST NOT gate capture on any network connectivity. **Capture never waits for the network.**
2. In STREAMING, each finished chunk is sent to every connected sink (sending to multiple sinks is RECOMMENDED when paths exist; idempotency absorbs the redundancy).
3. On disconnect, capture and encoding continue; chunks accumulate in the ring buffer. On reconnect, the recorder resumes live transmission immediately and services ACK/BACKFILL for the backlog concurrently. Live chunks SHOULD be prioritized over backfill when bandwidth-constrained (freshest audio is at greatest risk).
4. On `take-stop`, the recorder emits the final (possibly short) chunk, then remains in DRAINING until at least one sink reports CHWM = final seq, and SHOULD remain until every configured sink does. The UI MUST NOT tell the user "done" before the first condition holds.
5. A take is **complete at a sink** when it holds seq `0..=final` for every stream. A take is **complete** when at least one sink satisfies that for all streams; **fully replicated** when all sinks do.

## 8. Reconciliation Model

There is exactly one synchronization primitive in Antiphon, used everywhere:

> _Tell me what you have (or lack); I send what's missing; receiving twice is free._

- Recorder→sink recovery: ACK_STATUS holes + BACKFILL_REQUEST (§6.4–6.5).
- Sink↔sink replication: HAVE_SUMMARY diff push (§6.8).
- Crash recovery: a sink restarting from disk recomputes CHWM/holes from stored chunk keys and rejoins as if it had merely been disconnected.

There are no snapshots, no leader election, no distinct "upload" mode. LAN-only, internet-only, and mixed topologies are the same protocol under different ICE outcomes. Implementations MUST NOT special-case topology.

## 9. Ring Buffer Requirements

- Recorders MUST retain at least **30 s** (`RING_MIN_SECONDS`) of encoded audio; 60 s is RECOMMENDED where memory allows.
- Eviction MUST be oldest-first and MUST skip chunks not yet acknowledged by any sink _if_ retaining them stays within the memory budget; only when the budget is exhausted may unacknowledged chunks be evicted — accompanied by an immediate GAP_REPORT.
- Practical note (informative): at ~75 KB/s encoded, 60 s ≈ 4.5 MB. There is no excuse for a small ring.

## 10. Acoustic Calibration (metadata carriage)

The protocol does not perform alignment; it transports the evidence.

- `calibration-chirp` (control plane) announces `chirpId`, the desk's emission timestamp in its own clock, and the chirp `spec`. RECOMMENDED spec: exponential sine sweep, 200 Hz → 8 kHz, 1 s, −12 dBFS, emitted twice with a 1 s gap. Recorders take no protocol action — the chirp lands in their ordinary audio capture; correlation happens offline at the desk.
- Streams SHOULD be armed (capturing) before the chirp; the desk MUST NOT emit the chirp until all joined recorders report ARMED/STREAMING.
- Drift re-correlation (every ~30 s at render/ingest) consumes the archived streams plus the desk's reference stream; it requires nothing from the wire protocol beyond `capture_ts_us` coarse hints.

## 11. Error Handling

| Condition                          | Action                                                         |
| ---------------------------------- | -------------------------------------------------------------- |
| Bad magic / truncated frame        | Discard silently                                               |
| Unknown frame type                 | Ignore (forward compatibility)                                 |
| Version mismatch on data plane     | Reject frame; control-plane `error`                            |
| Duplicate chunk key, matching CRC  | No-op (normal operation)                                       |
| Duplicate chunk key, CRC mismatch  | Fatal: control-plane `error{fatal}`, quarantine stream         |
| `first_sample_index` discontinuity | Fatal stream error; sink preserves received chunks, flags take |
| CRC failure on payload at rest     | Re-request range via BACKFILL_REQUEST / HAVE diff              |

Fatal errors never delete data. Antiphon errs on the side of keeping bytes and flagging them.

## 12. Security Considerations

- All transports are encrypted by construction: DTLS (data plane), TLS (control plane). Plaintext transport MUST NOT be offered.
- Session and join UUIDs are bearer capabilities (~122 bits of entropy). Servers MUST rate-limit join attempts and SHOULD expire sessions. This is adequate for v1's threat model (uninvited joiners); it is not authentication. Desk-authenticated session creation is expected in v2.
- Sinks store recordings of identifiable people. Retention policy, deletion, and access control are deployment concerns but the server MUST support hard deletion of a session's chunks.
- A malicious recorder can only pollute its own streams (chunk keys are namespaced by stream); it cannot overwrite others' data thanks to the idempotency law.

## 13. Protocol Constants

| Constant                   | Value                                                          |
| -------------------------- | -------------------------------------------------------------- |
| `MAX_FRAME_BYTES`          | 65,536                                                         |
| `NOMINAL_CHUNK_MS`         | 500                                                            |
| `MIN_CHUNK_MS` (non-final) | 100                                                            |
| `ACK_INTERVAL_MS`          | 2,000                                                          |
| `RING_MIN_SECONDS`         | 30 (60 RECOMMENDED)                                            |
| `TIME_SYNC_INTERVAL_MS`    | 5,000                                                          |
| `TIME_SYNC_WINDOW`         | best-of-16 min-RTT                                             |
| Channel labels             | `antiphon/1`, `antiphon-sync/1`                                |
| Audio (v1)                 | Mono, FLAC, device-native rate (48 kHz RECOMMENDED), 16/24-bit |

Sinks MUST NOT transcode or resample stored chunks; sample-rate conversion is a render-time operation.

## 14. Non-Goals

- Low-latency delivery, live monitoring through the system, and internet jamming (physics; see architecture doc §10).
- Lossy codecs. If bandwidth cannot carry FLAC, the correct behavior is buffering and lag, never quality loss.
- In-protocol mixing/DSP. The protocol moves and reconciles bytes; interpretation is the DAW's job.

## 15. Conformance

An implementation is conformant if it (a) never violates the idempotency law, (b) never gates capture on connectivity, (c) implements ACK/BACKFILL/GAP semantics as specified, and (d) passes the `rust/core` property-test suite: for any interleaving of chunk loss, reordering, duplication, disconnection, and sink crash — excepting total loss of all sinks and ring eviction — every sink converges to an identical, complete chunk set for every stream.

That property test is the protocol's real specification; this document is its prose shadow.
