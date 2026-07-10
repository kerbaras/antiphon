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

## A8. Informative: METER telemetry frame (experimental 0x80)

The reference implementation uses frame type `0x80` (from the §6.1
private/experimental range, exactly as intended) for live capture-level
telemetry: header ++ `take_id` ++ `stream_id` ++ `peak` (f32 LE, 0..1),
sent ~4×/s recorder→sinks, teed server→desk over `antiphon-sync/1`.
Fire-and-forget UI data: never persisted, never acknowledged, never
retransmitted; conformant receivers that don't know it ignore it (verified
— the server's SinkEngine treats it as UnknownType). Documented here so
other implementations don't collide on 0x80 casually; not proposed for the
normative protocol.

## A9. `streams-delete` / `streams-deleted` control messages — addition to §5

Deliberate removal of recorded material is a desk (session authority)
decision the RFC does not cover. Desk→server:
`{ v, type: "streams-delete", streams: [{takeId, streamId}, …] }`.
Ordering rules, chosen so deletion can never race the never-lose-audio
machinery:

- The server MUST refuse deletion of any stream belonging to the active
  take (`error code="take-active"`): inbound chunks would recreate receiver
  state mid-delete and resurrect half a stream.
- The server deletes durably FIRST — receiver state, then metadata rows,
  then blobs — and only then fans out
  `{ v, type: "streams-deleted", streams, deletedTakeIds }` to all peers.
- Sinks drop their local copies (engine state + store) only on that
  confirm; a failed delete therefore never leaves sinks disagreeing with
  the archive.
- Removed streams vanish from ACK/HAVE traffic on every sink, so
  reconciliation cannot re-push (resurrect) them; deletion is idempotent
  (unknown streams delete to nothing). Takes that lose their last stream
  are removed and reported in `deletedTakeIds`.

## A10. `disarmedPeerIds` on `take-start` — extension of §5

Per-lane record-arm: `take-start` MAY carry
`disarmedPeerIds: [peerId, …]`; listed recorders do not arm for that take
(they keep their session running and re-arm normally on the next take).
The session snapshot's active-take object carries the same list so late
(re)joiners honor it. Omitted/empty = everyone records, so old peers are
unaffected. Chosen over a per-peer unicast so the arm decision lives in
exactly one message and the whole room shares one consistent view of who
is rolling.

## A11. Editorial

- §15 says the property suite lives in `rust/core`; the crate lives at
  `packages/core` (Cargo workspace member `antiphon-core`).
- The layout table in the architecture doc's companion scaffolding doc
  should match (crates under `packages/`).

## A12. `deviceId` in `hello.deviceInfo` — peer identity resume, extension of §5

Without a stable device identity, every reconnect (page reload, radio
blip, Safari tab discard) mints a fresh `peerId`: the desk forks a new
lane and the peer's mixer mapping (gain/pan/mute/solo, arm state) is
orphaned. Extension: `deviceInfo` MAY carry `deviceId`, a UUID the
browser generates once and persists locally (localStorage key
`antiphon:device-id`). Optional field, protocol version stays 1; peers
without it behave exactly as before.

Server semantics on a `hello` carrying `deviceId`:

- If a peer of the SAME session and SAME role was previously seen with
  this `deviceId`, the server MUST reuse that `peerId` in `welcome` —
  the peer resumes its lane. The stored nickname survives: a hello with
  a non-empty `label` wins (the device speaks for itself), otherwise the
  previously known label is kept.
- If the previous connection is still open (a zombie — the network lost
  the old socket before the server did), the server MUST send it a
  control-plane `error` (`code="superseded"`, `fatal=true`), close it,
  and adopt the new socket. One socket per identity, newest wins.
- The mapping is persisted with the peer row, so resume survives a
  server restart the same way archive state does (§8 spirit).

Boundary (A6 unchanged): identity resume is PEER-level only. A recorder
that reloads mid-take still arms a fresh `stream_id` — the capture ring
died with the page and the sample domain must not restart inside one
stream. What `deviceId` buys is continuity of everything keyed by
`peerId`: the desk lane, the nickname, and per-peer mixer/arm state.

## A13. `peer-update` control message — addition to §5

Human names for lanes. `{ v, type: "peer-update", peerId, label }`,
peer→server, then server→all after validation. Authority rules:

- A recorder MAY rename ITSELF (`peerId` = its own).
- The desk (session authority, §3) MAY rename ANY peer.
- Anything else is refused with `error code="not-authorized"`; unknown
  `peerId` with `error code="unknown-peer"`. Refusals do not fan out.

The server updates its session state, persists the label on the peer
row, and fans out both the `peer-update` (explicit signal — a renamed
recorder persists a desk-given name locally) and a `peer-status`
snapshot (the existing convergence mechanism). An empty/whitespace
`label` clears the nickname; displays fall back to a device-derived
name. Initial labels ride `hello.deviceInfo.label`; `peer-update` is
only the live-rename path.

## A14. Desk re-asserts its rolling take over an empty snapshot — clarification of §3/§7

Room state (including `activeTake`) is in-memory; a server that crashes
mid-take welcomes the reconnecting desk with `activeTake: null` while
every recorder keeps rolling (§7.1 — capture never gates on the
network). A desk that adopts that null loses control of a take that is
still happening: Stop is dead, the operator cannot end it.

Amendment: on `welcome`, a desk that knows a locally-active take and
receives `activeTake: null` MUST NOT adopt the null; it re-asserts by
re-sending the original `take-start` (same `takeId`, same
`wallClockHint`, same `disarmedPeerIds`). §3 makes the desk the control
authority — its own knowledge of the take it started outranks the empty
snapshot of a reborn room. Safety analysis:

- Re-assertion is idempotent everywhere: recorders treat a `take-start`
  for their CURRENT take as a no-op, the server's take row is
  insert-or-ignore (the archived `wallClockHint` never changes), and the
  A10 disarm list is carried verbatim so sat-out lanes stay sat out.
- A snapshot carrying a DIFFERENT active take wins over local state
  (the room genuinely moved on); a desk with no local take (fresh load
  or reload) adopts the snapshot as before. Only the (local take,
  empty snapshot) cell re-asserts.
- Known bound: with a single control authority, an empty snapshot while
  the desk holds a rolling take can only mean the room died. If v2 adds
  multiple desks, "another desk stopped it while we were away" becomes
  possible and re-assertion could resurrect a stopped take; the fix
  then is a server-side room epoch, not desk-side guessing.

Chosen over persisting `activeTake` in the database: a DB-rebuilt
active take has no authority behind it — if the desk never returns, the
room claims a rolling take forever (blocking session expiry), and a
stale un-stopped row from an earlier crash would resurrect as active on
every boot. The desk re-asserting only what it knows is rolling is
simpler and strictly safer under never-lose-audio.

## A15. Desk authentication rides the hello (`hello.authToken`) — extends §12

Browsers cannot set WebSocket headers, so the desk's Clerk session JWT
is carried IN the hello message (`authToken`, ≤ 8192 chars). A server
running with auth enabled MUST judge a desk hello by it BEFORE any
session state attaches (no room, no ingest init, no peer entry, no
doc); refusal is the fatal `unauthorized` error. Recorder hellos never
carry it — mic join stays a public bearer capability (§12). Absent in
keyless mode; old servers strip the unknown field (zod object schemas
are non-strict), old desks never send it. The collab socket, which has
no message-level handshake (binary Yjs frames from byte 0), carries the
same token as an `auth_token` query parameter judged at the upgrade.

## A16. Account profile picture (`deviceInfo.avatarUrl`) — extends A12/A13

Signed-in endpoints MAY self-report their account's profile picture URL
in `hello.deviceInfo.avatarUrl` (https only, ≤ 512 chars — schema-
enforced; the desk renders it in an `<img>` under COEP `require-corp`,
so hosts without CORP headers degrade to the initials disc). Display-
only denorm with `label`'s exact semantics: a non-empty hello value
wins, a silent reconnect keeps the stored one, and the server persists
it on the peer row so archived lanes keep their face after the peer
disconnects. Deliberately NOT verified against the account system —
like `label` it is self-description, never authority; anything
security-relevant must key off the A15 token, not this. The desk's
embedded room-mic recorder (W2-D) deliberately never sends one: that
lane is hardware, not a person. Old peers/servers strip the field.
