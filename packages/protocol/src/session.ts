// Session model: session/take/participant types.
// Sessions live at /session/{uuid} (desk) and /join/{uuid} (phones).

import { z } from "zod";

export const SessionId = z.uuid();
export type SessionId = z.infer<typeof SessionId>;
