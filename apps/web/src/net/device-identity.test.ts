import { describe, expect, it } from "vitest";
import {
  DEVICE_ID_KEY,
  getDeviceId,
  getNickname,
  NICKNAME_KEY,
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
