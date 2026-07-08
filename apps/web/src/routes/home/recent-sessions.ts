// Desk sessions visited on this browser, newest first — feeds the home
// page's "recent sessions" list. localStorage, best-effort: private mode
// or disabled storage just means an empty list.

export interface RecentSession {
  id: string;
  /** Last visit, epoch ms. */
  at: number;
}

export const RECENT_SESSIONS_KEY = "antiphon:recent-sessions";
const MAX_RECENT = 6;

type KVStore = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): KVStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // private mode / storage disabled: no recents
  }
}

/** Load the visit trail. Malformed JSON and invalid entries degrade to
 * "no recents" — never a throw. */
export function listRecentSessions(store: KVStore | null = defaultStore()): RecentSession[] {
  let raw: string | null = null;
  try {
    raw = store?.getItem(RECENT_SESSIONS_KEY) ?? null;
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is RecentSession =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as { id?: unknown }).id === "string" &&
          typeof (e as { at?: unknown }).at === "number" &&
          Number.isFinite((e as { at: number }).at),
      )
      .map((e) => ({ id: e.id, at: e.at }))
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/** Record a desk visit (called by the desk route). Newest first, deduped. */
export function recordRecentSession(
  id: string,
  at = Date.now(),
  store: KVStore | null = defaultStore(),
): void {
  const next = [{ id, at }, ...listRecentSessions(store).filter((s) => s.id !== id)].slice(
    0,
    MAX_RECENT,
  );
  try {
    store?.setItem(RECENT_SESSIONS_KEY, JSON.stringify(next));
  } catch {
    // quota / private mode: the list just won't persist
  }
}

/** Coarse relative time for the recent list ("just now", "5 min ago"). */
export function relativeTime(at: number, now = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - at) / 1_000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}
