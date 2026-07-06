# Proposed amendments to draft-antiphon-core-01

Deviations, extensions, and interpretations the implementation had to make
where the RFC was open or ambiguous. Per the project's hard rule — never
silently drift the protocol — each is listed here for adoption into
draft-antiphon-core-02. Every choice follows one tie-breaker: never lose
audio.

## A1. Seq-0 payload encoding (`StreamHeaderV1`) — new normative section

§6.2 requires seq 0 to carry "a self-describing codec configuration" but
does not define its encoding. The implementation defines `StreamHeaderV1`
(normative code: `packages/core/src/chunk.rs`), little-endian:

| offset | size | field                                            |
| ------ | ---- | ------------------------------------------------ |
| 0      | 4    | magic `"ANS0"`                                   |
| 4      | 1    | header version = 1                               |
| 5      | 1    | codec (1 = FLAC)                                 |
| 6      | 1    | channels (MUST be 1 in v1)                       |
| 7      | 1    | bits per sample (16 or 24)                       |
| 8      | 4    | sample rate (Hz)                                 |
| 12     | 8    | clock epoch µs (recorder monotonic @ sample 0)   |
| 20     | 8    | wall-clock hint, Unix ms (0 = unknown)           |
| 28     | 2+n  | device description (UTF-8, length-prefixed)      |
| 30+n   | 2+m  | codec bootstrap (`fLaC` + STREAMINFO, last-flag) |

Reconstruction = codec bootstrap ++ payloads `1..=final`.

## A2. `stream-final` control message — addition to §5

§7 lets the *recorder* decide completeness from ACKs, but a sink cannot
distinguish "stream done" from "recorder disconnected" — completeness is
undecidable sink-side without the final seq. New recorder→all message:
`{ v, type: "stream-final", takeId, streamId, finalSeq }`, sent when the
final chunk is produced (idempotent; max wins on conflict, never shrinks).

## A3. `stream-announce` control message — addition to §5

`{ v, type: "stream-announce", takeId, streamId }` (recorder→all, server
stamps `fromPeerId`). Pure UI affordance mapping streams to peers before
data-plane bytes arrive. Optional; carries no protocol semantics.

## A4. CHWM treats declared gaps as satisfied — clarification of §6.4/§7

If CHWM counted only held chunks, a declared gap (§6.6) would pin CHWM
below it forever; the recorder could never observe `CHWM = final`, and
DRAINING could never end — though waiting cannot fill a declared gap.
Amendment: ranges the recorder declared permanently lost count as
*satisfied* for CHWM computation and are excluded from ACK holes. True
possession remains observable (held set / take metadata); every non-gap
seq at or below CHWM is genuinely held. (`receiver.rs::chwm`.)

## A5. Ring pinning — addition to §9

Two eviction exemptions beyond the §9 rules, both cheap and lossless:
seq 0 is never evicted (any late-joining or amnesiac sink needs it to
decode anything at all), and the newest chunk is never evicted before it
has had a chance to be transmitted once.

## A6. Recorder mid-take reload starts a NEW stream — clarification of §7

A recorder page reload loses the in-memory ring; resuming the same
`stream_id` would leave an unfillable hole and (worse) restart the sample
domain, violating §6.2 continuity. Implementation: rejoining mid-take arms
a fresh `stream_id`; the truncated stream's bytes are preserved, it simply
never receives a `stream-final` and is flagged incomplete in take metadata.

## A7. Corrupt-frame handling — addition to the §11 table

A frame whose header CRC disagrees with its own payload (impossible over
intact DTLS; indicates a sender bug) is discarded WITHOUT storing: the seq
stays a hole and retransmission re-requests it. Storing known-corrupt bytes
under an immutable chunk key would poison the idempotency law.

## A8. Editorial

- §15 says the property suite lives in `rust/core`; the crate lives at
  `packages/core` (Cargo workspace member `antiphon-core`).
- The layout table in the architecture doc's companion scaffolding doc
  should match (crates under `packages/`).
