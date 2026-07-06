// Signaling messages: room join/leave, SDP offer/answer relay, ICE candidate
// relay, and reconciliation control messages ("I have up to chunk N").

import { z } from "zod";

// Placeholder discriminated union — every signaling message gets a schema here.
export const SignalingMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
]);
export type SignalingMessage = z.infer<typeof SignalingMessage>;
