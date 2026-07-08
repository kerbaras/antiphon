import { describe, expect, it } from "vitest";
import {
  DEVICE_ID_KEY,
  getDeviceId,
  getNickname,
  NICKNAME_KEY,
  NICKNAME_MAX_LENGTH,
  normalizeNickname,
  setNickname,
} from "./device-identity";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fakeStore(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("getDeviceId (A12)", () => {
  it("survives a throwing storage (private mode): stable within the page", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const id = getDeviceId(throwing);
    expect(id).toMatch(UUID_RE);
    expect(getDeviceId(throwing)).toBe(id);
  });

  it("generates a UUID once and persists it", () => {
    const store = fakeStore();
    const id = getDeviceId(store);
    expect(id).toMatch(UUID_RE);
    expect(store.map.get(DEVICE_ID_KEY)).toBe(id);
    expect(getDeviceId(store)).toBe(id);
  });

  it("returns a previously stored id", () => {
    const existing = "0b54d4e8-7c1a-4f7e-9f3a-1a2b3c4d5e6f";
    expect(getDeviceId(fakeStore({ [DEVICE_ID_KEY]: existing }))).toBe(existing);
  });

  it("regenerates when the stored value is corrupt", () => {
    const store = fakeStore({ [DEVICE_ID_KEY]: "not-a-uuid" });
    const id = getDeviceId(store);
    expect(id).toMatch(UUID_RE);
    expect(store.map.get(DEVICE_ID_KEY)).toBe(id);
  });
});

describe("nickname persistence (A13)", () => {
  it("stores trimmed names and prefills return visits", () => {
    const store = fakeStore();
    setNickname("  Alto — Maria  ", store);
    expect(store.map.get(NICKNAME_KEY)).toBe("Alto — Maria");
    expect(getNickname(store)).toBe("Alto — Maria");
  });

  it("clears on empty/whitespace", () => {
    const store = fakeStore({ [NICKNAME_KEY]: "Maria" });
    setNickname("   ", store);
    expect(getNickname(store)).toBeNull();
  });
});

// QA LOW: "nickname 48-char cap bypassable on commit" — the cap lived only
// on the input's maxLength attribute; paste and programmatic writes walked
// straight past it. Enforced here, in the model, at commit time.
describe("nickname 48-char cap at commit", () => {
  it("exposes the cap the inputs mirror via maxLength", () => {
    expect(NICKNAME_MAX_LENGTH).toBe(48);
  });

  it("caps a 300-char paste at 48 UTF-16 units, after trimming", () => {
    const store = fakeStore();
    setNickname(`  ${"x".repeat(300)}  `, store);
    expect(getNickname(store)).toBe("x".repeat(48));
  });

  it("never splits a surrogate pair at the cap boundary (no U+FFFD)", () => {
    // 47 ASCII + an emoji: the pair straddles units 48/49 — the cut must
    // drop the whole emoji, not leave a lone high surrogate behind.
    const name = normalizeNickname(`${"a".repeat(47)}🎤 tail`);
    expect(name).toBe("a".repeat(47));
    expect(/[\uD800-\uDFFF]/u.test(name)).toBe(false);
  });

  it("keeps a pair that fits exactly inside the cap", () => {
    const name = normalizeNickname(`${"a".repeat(46)}🎤 tail`);
    expect(name).toBe(`${"a".repeat(46)}🎤`);
    expect(name).toHaveLength(48);
  });

  it("re-trims whitespace exposed by the cut", () => {
    expect(normalizeNickname(`${"a".repeat(47)} b`)).toBe("a".repeat(47));
  });

  it("heals an overlong previously-persisted value on read", () => {
    const store = fakeStore({ [NICKNAME_KEY]: "y".repeat(200) });
    expect(getNickname(store)).toBe("y".repeat(48));
  });
});
