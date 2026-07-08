import { describe, expect, it } from "vitest";
import {
  DESK_INPUT_PREFS_KEY,
  defaultDeskInputLabel,
  deriveDeskInputDeviceId,
  loadDeskInputPrefs,
  saveDeskInputPrefs,
} from "./desk-input-identity";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fakeStore(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("deriveDeskInputDeviceId (A12, W2-D)", () => {
  const deskId = "0b54d4e8-7c1a-4f7e-9f3a-1a2b3c4d5e6f";

  it("yields a valid UUIDv4 the protocol schema accepts", () => {
    expect(deriveDeskInputDeviceId(deskId)).toMatch(UUID_RE);
  });

  it("is deterministic — the same desk always resumes the same lane", () => {
    expect(deriveDeskInputDeviceId(deskId)).toBe(deriveDeskInputDeviceId(deskId));
  });

  it("never collides with the desk's own id", () => {
    expect(deriveDeskInputDeviceId(deskId)).not.toBe(deskId);
  });

  it("distinct desks derive distinct input ids", () => {
    const other = "c0ffee00-1234-4abc-8def-000000000001";
    expect(deriveDeskInputDeviceId(deskId)).not.toBe(deriveDeskInputDeviceId(other));
  });

  it("accepts uppercase input and rejects garbage", () => {
    expect(deriveDeskInputDeviceId(deskId.toUpperCase())).toBe(deriveDeskInputDeviceId(deskId));
    expect(() => deriveDeskInputDeviceId("not-a-uuid")).toThrow(/bad device id/);
  });
});

describe("defaultDeskInputLabel", () => {
  it("wraps the device name", () => {
    expect(defaultDeskInputLabel("MOTU M2")).toBe("Room mic (MOTU M2)");
  });

  it("falls back when the device label is blank (pre-permission)", () => {
    expect(defaultDeskInputLabel("  ")).toBe("Room mic");
  });
});

describe("desk input prefs persistence", () => {
  it("round-trips", () => {
    const store = fakeStore();
    saveDeskInputPrefs({ inputId: "default", inputLabel: "MOTU M2", label: null }, store);
    expect(loadDeskInputPrefs(store)).toEqual({
      inputId: "default",
      inputLabel: "MOTU M2",
      label: null,
    });
  });

  it("keeps a lane nickname override", () => {
    const store = fakeStore();
    saveDeskInputPrefs({ inputId: "abc", inputLabel: "MOTU M2", label: "Room ref" }, store);
    expect(loadDeskInputPrefs(store)?.label).toBe("Room ref");
  });

  it("clears with null", () => {
    const store = fakeStore({ [DESK_INPUT_PREFS_KEY]: '{"inputId":"x","inputLabel":"y"}' });
    saveDeskInputPrefs(null, store);
    expect(loadDeskInputPrefs(store)).toBeNull();
  });

  it("tolerates corrupt or foreign JSON", () => {
    expect(loadDeskInputPrefs(fakeStore({ [DESK_INPUT_PREFS_KEY]: "{oops" }))).toBeNull();
    expect(loadDeskInputPrefs(fakeStore({ [DESK_INPUT_PREFS_KEY]: '{"inputId":7}' }))).toBeNull();
    expect(loadDeskInputPrefs(fakeStore({ [DESK_INPUT_PREFS_KEY]: '"str"' }))).toBeNull();
  });

  it("survives a throwing store (private mode)", () => {
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
    expect(loadDeskInputPrefs(throwing)).toBeNull();
    expect(() =>
      saveDeskInputPrefs({ inputId: "a", inputLabel: "b", label: null }, throwing),
    ).not.toThrow();
  });
});
