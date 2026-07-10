// W8-A landing lists: GET /api/me/sessions → "Your sessions" + "Shared
// with me". Hostile-data boundary for the landing (same stance as
// readRegions): a malformed payload reads as empty lists, never a crash —
// the landing must render even against a confused server.

import { authFetch } from "../../net/auth-token";

export interface MeSession {
  sessionId: string;
  createdAt: string;
  lastActivityAt: string;
  takeCount: number;
  /** Owner attribution for the shared bucket (denormalized server-side). */
  ownerEmail: string | null;
}

export interface MeSessions {
  own: MeSession[];
  shared: MeSession[];
}

function readEntry(raw: unknown): MeSession | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.sessionId !== "string" || typeof r.createdAt !== "string") return null;
  return {
    sessionId: r.sessionId,
    createdAt: r.createdAt,
    lastActivityAt: typeof r.lastActivityAt === "string" ? r.lastActivityAt : r.createdAt,
    takeCount: typeof r.takeCount === "number" && Number.isFinite(r.takeCount) ? r.takeCount : 0,
    ownerEmail: typeof r.ownerEmail === "string" ? r.ownerEmail : null,
  };
}

function readList(raw: unknown): MeSession[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(readEntry).filter((e): e is MeSession => e !== null);
}

/** null = fetch failed / not authorized — the landing shows a quiet
 * "couldn't load" note instead of empty-but-confident lists. */
export async function fetchMeSessions(): Promise<MeSessions | null> {
  try {
    const res = await authFetch("/api/me/sessions");
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    return { own: readList(body.own), shared: readList(body.shared) };
  } catch {
    return null;
  }
}
