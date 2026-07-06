// Session model shared by web + server. Sessions live at /session/{uuid}
// (desk) and /join/{uuid} (phones); both ids are bearer capabilities
// (RFC §12).

import { z } from "zod";

export const SessionId = z.uuid();
export type SessionId = z.infer<typeof SessionId>;

export const PeerId = z.uuid();
export type PeerId = z.infer<typeof PeerId>;

export const TakeId = z.uuid();
export type TakeId = z.infer<typeof TakeId>;

export const StreamId = z.uuid();
export type StreamId = z.infer<typeof StreamId>;

export const PeerRole = z.enum(["desk", "recorder"]);
export type PeerRole = z.infer<typeof PeerRole>;

export const DeviceInfo = z.object({
  userAgent: z.string().max(512),
  label: z.string().max(256).optional(),
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

export const PeerInfo = z.object({
  peerId: PeerId,
  role: PeerRole,
  deviceInfo: DeviceInfo,
  joinedAt: z.iso.datetime(),
});
export type PeerInfo = z.infer<typeof PeerInfo>;

export const TakeInfo = z.object({
  takeId: TakeId,
  startedAt: z.iso.datetime(),
  stoppedAt: z.iso.datetime().nullable(),
});
export type TakeInfo = z.infer<typeof TakeInfo>;

/** Snapshot fanned out in `welcome` and `peer-status`. */
export const SessionState = z.object({
  sessionId: SessionId,
  peers: z.array(PeerInfo),
  activeTake: TakeInfo.nullable(),
});
export type SessionState = z.infer<typeof SessionState>;
