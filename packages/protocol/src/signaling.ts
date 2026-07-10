// Control-plane messages (RFC §5): JSON over WSS. These Zod schemas are the
// normative message shapes — a change here is a compile error in every
// consumer. Unknown `type` MUST be ignored by receivers (forward compat):
// parse with `parseSignalingMessage`, which returns `null` for unknown
// types instead of throwing.
//
// Extensions beyond the RFC's informative table (proposed as amendments):
// - `stream-announce` (recorder→all): maps a stream id to a peer before any
//   data-plane bytes arrive — pure UI affordance.
// - `stream-final` (recorder→all): tells sinks the final seq of a stream so
//   completeness is decidable at the sink (§7 only drives the recorder off
//   ACKs; sinks otherwise cannot distinguish "done" from "disconnected").

import { z } from "zod";
import { DeviceInfo, PeerId, PeerRole, SessionState, StreamId, TakeId } from "./session.ts";

/** Data-plane/protocol versions this implementation speaks. */
export const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;

/** Well-known peer id of the server's ingest sink: recorders and the desk
 * address ICE messages here to open data channels toward the archive. */
export const SERVER_PEER_ID = "00000000-0000-4000-8000-000000000001";

const base = { v: z.literal(1) };

// ---- client → server ------------------------------------------------------

export const HelloMessage = z.object({
  ...base,
  type: z.literal("hello"),
  role: PeerRole,
  deviceInfo: DeviceInfo,
  protocolVersions: z.array(z.number().int().positive()).min(1),
  /**
   * Desk authentication (proposed amendment A15, the RFC §12 "desk-
   * authenticated session creation" v2 step): a Clerk session JWT carried
   * in the hello because browsers cannot set WS headers. Servers running
   * with auth enabled MUST judge a desk hello by it BEFORE attaching any
   * session state; recorder hellos ignore it (mic join stays a public
   * bearer capability). Absent in keyless mode — old servers strip it
   * (zod object schemas are non-strict), old desks never send it.
   */
  authToken: z.string().min(1).max(8_192).optional(),
});
export type HelloMessage = z.infer<typeof HelloMessage>;

export const ByeMessage = z.object({ ...base, type: z.literal("bye") });
export type ByeMessage = z.infer<typeof ByeMessage>;

// ---- peer identity (A13) ---------------------------------------------------

/**
 * Live nickname change (proposed amendment A13). A recorder may rename
 * ITSELF; the desk (session authority) may rename ANY peer. The server
 * validates authority, updates its session state, persists, and fans the
 * same message out to all peers. An empty (or whitespace-only) `label`
 * clears the nickname back to the device-derived fallback.
 */
export const PeerUpdateMessage = z.object({
  ...base,
  type: z.literal("peer-update"),
  peerId: PeerId,
  label: z.string().max(256),
});
export type PeerUpdateMessage = z.infer<typeof PeerUpdateMessage>;

// ---- WebRTC signaling relay (either direction; server addresses/stamps) ---

export const IceOfferMessage = z.object({
  ...base,
  type: z.literal("ice-offer"),
  targetPeerId: PeerId,
  fromPeerId: PeerId.optional(),
  sdp: z.string().max(65_536),
});
export type IceOfferMessage = z.infer<typeof IceOfferMessage>;

export const IceAnswerMessage = z.object({
  ...base,
  type: z.literal("ice-answer"),
  targetPeerId: PeerId,
  fromPeerId: PeerId.optional(),
  sdp: z.string().max(65_536),
});
export type IceAnswerMessage = z.infer<typeof IceAnswerMessage>;

export const IceCandidateMessage = z.object({
  ...base,
  type: z.literal("ice-candidate"),
  targetPeerId: PeerId,
  fromPeerId: PeerId.optional(),
  candidate: z
    .object({
      candidate: z.string().max(2_048),
      sdpMid: z.string().nullable().optional(),
      sdpMLineIndex: z.number().int().nullable().optional(),
    })
    .nullable(),
});
export type IceCandidateMessage = z.infer<typeof IceCandidateMessage>;

// ---- take lifecycle (desk → server → all) ----------------------------------

export const TakeStartMessage = z.object({
  ...base,
  type: z.literal("take-start"),
  takeId: TakeId,
  wallClockHint: z.iso.datetime(),
  /** Per-lane record-arm: listed peers do NOT arm for this take. */
  disarmedPeerIds: z.array(PeerId).max(64).optional(),
});
export type TakeStartMessage = z.infer<typeof TakeStartMessage>;

export const TakeStopMessage = z.object({
  ...base,
  type: z.literal("take-stop"),
  takeId: TakeId,
});
export type TakeStopMessage = z.infer<typeof TakeStopMessage>;

// ---- stream metadata (recorder → server → all) -----------------------------

export const StreamAnnounceMessage = z.object({
  ...base,
  type: z.literal("stream-announce"),
  takeId: TakeId,
  streamId: StreamId,
  fromPeerId: PeerId.optional(),
});
export type StreamAnnounceMessage = z.infer<typeof StreamAnnounceMessage>;

export const StreamFinalMessage = z.object({
  ...base,
  type: z.literal("stream-final"),
  takeId: TakeId,
  streamId: StreamId,
  finalSeq: z.number().int().nonnegative(),
  fromPeerId: PeerId.optional(),
});
export type StreamFinalMessage = z.infer<typeof StreamFinalMessage>;

// ---- stream deletion (desk → server; server → all) --------------------------
// Deletion is a control-plane decision by the desk (the session authority).
// The server is the source of truth: it deletes durably FIRST, then fans out
// `streams-deleted` — desks drop their local copies only on that confirm, so
// a failed delete never leaves sinks disagreeing with the archive.

export const StreamRef = z.object({ takeId: TakeId, streamId: StreamId });
export type StreamRef = z.infer<typeof StreamRef>;

export const StreamsDeleteMessage = z.object({
  ...base,
  type: z.literal("streams-delete"),
  streams: z.array(StreamRef).min(1).max(256),
});
export type StreamsDeleteMessage = z.infer<typeof StreamsDeleteMessage>;

export const StreamsDeletedMessage = z.object({
  ...base,
  type: z.literal("streams-deleted"),
  streams: z.array(StreamRef),
  /** Takes removed entirely because they lost their last stream. */
  deletedTakeIds: z.array(TakeId),
});
export type StreamsDeletedMessage = z.infer<typeof StreamsDeletedMessage>;

// ---- calibration (desk → server → all) -------------------------------------

export const ChirpSpec = z.object({
  kind: z.literal("ess"),
  startHz: z.number().positive(),
  endHz: z.number().positive(),
  durationMs: z.number().positive(),
  gainDbfs: z.number().max(0),
  repeats: z.number().int().positive(),
  gapMs: z.number().nonnegative(),
});
export type ChirpSpec = z.infer<typeof ChirpSpec>;

/** RECOMMENDED spec per RFC §10. */
export const DEFAULT_CHIRP_SPEC: ChirpSpec = {
  kind: "ess",
  startHz: 200,
  endHz: 8_000,
  durationMs: 1_000,
  gainDbfs: -12,
  repeats: 2,
  gapMs: 1_000,
};

export const CalibrationChirpMessage = z.object({
  ...base,
  type: z.literal("calibration-chirp"),
  chirpId: z.uuid(),
  emitTsDeskUs: z.number().nonnegative(),
  spec: ChirpSpec,
});
export type CalibrationChirpMessage = z.infer<typeof CalibrationChirpMessage>;

// ---- server → client --------------------------------------------------------

export const WelcomeMessage = z.object({
  ...base,
  type: z.literal("welcome"),
  peerId: PeerId,
  protocolVersion: z.number().int().positive(),
  session: SessionState,
});
export type WelcomeMessage = z.infer<typeof WelcomeMessage>;

export const PeerStatusMessage = z.object({
  ...base,
  type: z.literal("peer-status"),
  session: SessionState,
});
export type PeerStatusMessage = z.infer<typeof PeerStatusMessage>;

export const ErrorMessage = z.object({
  ...base,
  type: z.literal("error"),
  code: z.string().max(64),
  message: z.string().max(1_024),
  fatal: z.boolean().optional(),
});
export type ErrorMessage = z.infer<typeof ErrorMessage>;

// ---- unions -----------------------------------------------------------------

export const SignalingMessage = z.discriminatedUnion("type", [
  HelloMessage,
  ByeMessage,
  PeerUpdateMessage,
  IceOfferMessage,
  IceAnswerMessage,
  IceCandidateMessage,
  TakeStartMessage,
  TakeStopMessage,
  StreamAnnounceMessage,
  StreamFinalMessage,
  StreamsDeleteMessage,
  StreamsDeletedMessage,
  CalibrationChirpMessage,
  WelcomeMessage,
  PeerStatusMessage,
  ErrorMessage,
]);
export type SignalingMessage = z.infer<typeof SignalingMessage>;

/**
 * Parse a wire string. Returns the message, `null` for messages that must
 * be ignored (unknown type / future version — forward compatibility), or
 * throws on malformed JSON/shape of a KNOWN type.
 */
export function parseSignalingMessage(raw: string): SignalingMessage | null {
  const envelope = z.object({ v: z.number(), type: z.string() }).loose().parse(JSON.parse(raw));
  const known = SignalingMessage.options.some((o) => o.shape.type.value === envelope.type);
  if (!known || envelope.v !== 1) return null;
  return SignalingMessage.parse(envelope);
}

/** Server side of version negotiation (§5): highest common version. */
export function negotiateVersion(peerVersions: readonly number[]): number | null {
  const common = peerVersions.filter((v) =>
    (SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(v),
  );
  return common.length > 0 ? Math.max(...common) : null;
}
