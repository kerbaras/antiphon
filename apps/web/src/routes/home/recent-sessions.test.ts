import { describe, expect, it } from "vitest";
import {
  listRecentSessions,
  RECENT_SESSIONS_KEY,
  recordRecentSession,
  relativeTime,
} from "./recent-sessions";

/** Minimal Storage double (vitest runs in node — no localStorage). */
function memStore(): Pick<Storage, "getItem" | "setItem"> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("recent sessions", () => {
  it("starts empty", () => {
    expect(listRecentSessions(memStore())).toEqual([]);
    expect(listRecentSessions(null)).toEqual([]);
  });

  it("records visits newest first and dedupes by id", () => {
    const store = memStore();
    recordRecentSession("a", 1_000, store);
    recordRecentSession("b", 2_000, store);
    recordRecentSession("a", 3_000, store);
    expect(listRecentSessions(store)).toEqual([
      { id: "a", at: 3_000 },
      { id: "b", at: 2_000 },
    ]);
  });

  it("caps the list at six entries", () => {
    const store = memStore();
    for (let i = 0; i < 9; i++) recordRecentSession(`s${i}`, i, store);
    const list = listRecentSessions(store);
    expect(list).toHaveLength(6);
    expect(list[0]).toEqual({ id: "s8", at: 8 });
  });

  it("survives corrupt storage", () => {
    const store = memStore();
    store.map.set(RECENT_SESSIONS_KEY, "{not json");
    expect(listRecentSessions(store)).toEqual([]);
    store.map.set(RECENT_SESSIONS_KEY, JSON.stringify([{ id: 7 }, { id: "ok", at: 5 }, "x"]));
    expect(listRecentSessions(store)).toEqual([{ id: "ok", at: 5 }]);
  });
});

describe("relativeTime", () => {
  const now = 10 * 24 * 3_600_000;
  it("buckets coarsely", () => {
    expect(relativeTime(now - 5_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(relativeTime(now - 2 * 24 * 3_600_000, now)).toBe("2 d ago");
  });

  it("never goes negative on clock skew", () => {
    expect(relativeTime(now + 60_000, now)).toBe("just now");
  });
});
