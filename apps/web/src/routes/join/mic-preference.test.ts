import { describe, expect, it } from "vitest";
import {
  loadMicPreference,
  MIC_PREF_KEY,
  matchMicPreference,
  saveMicPreference,
} from "./mic-preference";

function fakeStore(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const throwingStore = {
  getItem: (): string | null => {
    throw new Error("denied");
  },
  setItem: (): void => {
    throw new Error("denied");
  },
  removeItem: (): void => {
    throw new Error("denied");
  },
};

describe("mic preference persistence", () => {
  it("round-trips a preference", () => {
    const store = fakeStore();
    saveMicPreference({ deviceId: "abc123", label: "Headset Mic" }, store);
    expect(loadMicPreference(store)).toEqual({ deviceId: "abc123", label: "Headset Mic" });
  });

  it("re-persisting overwrites a dead preference", () => {
    const store = fakeStore();
    saveMicPreference({ deviceId: "rotated-away", label: "Ghost Mic" }, store);
    saveMicPreference({ deviceId: "live-default", label: "Built-in Microphone" }, store);
    expect(loadMicPreference(store)).toEqual({
      deviceId: "live-default",
      label: "Built-in Microphone",
    });
  });

  it("clears with null", () => {
    const store = fakeStore();
    saveMicPreference({ deviceId: "abc123", label: "Headset Mic" }, store);
    saveMicPreference(null, store);
    expect(store.map.has(MIC_PREF_KEY)).toBe(false);
    expect(loadMicPreference(store)).toBeNull();
  });

  it("reads null for corrupt / malformed / empty-id payloads", () => {
    expect(loadMicPreference(fakeStore({ [MIC_PREF_KEY]: "not json" }))).toBeNull();
    expect(loadMicPreference(fakeStore({ [MIC_PREF_KEY]: '"just a string"' }))).toBeNull();
    expect(loadMicPreference(fakeStore({ [MIC_PREF_KEY]: '{"label":"x"}' }))).toBeNull();
    expect(
      loadMicPreference(fakeStore({ [MIC_PREF_KEY]: '{"deviceId":"","label":"x"}' })),
    ).toBeNull();
  });

  it("never throws on a hostile store (private mode)", () => {
    expect(loadMicPreference(throwingStore)).toBeNull();
    expect(() => saveMicPreference({ deviceId: "a", label: "b" }, throwingStore)).not.toThrow();
    expect(loadMicPreference(null)).toBeNull();
  });
});

describe("matchMicPreference — stale-id fallback (iOS rotation)", () => {
  const devices = [
    { id: "id-a", label: "Built-in Microphone" },
    { id: "id-b", label: "AirPods Pro" },
  ];

  it("prefers an exact deviceId match", () => {
    expect(matchMicPreference({ deviceId: "id-b", label: "stale label" }, devices)?.id).toBe(
      "id-b",
    );
  });

  it("heals a rotated id via the label", () => {
    expect(matchMicPreference({ deviceId: "rotated", label: "AirPods Pro" }, devices)?.id).toBe(
      "id-b",
    );
  });

  it("returns null when the device is gone (caller falls back to default)", () => {
    expect(matchMicPreference({ deviceId: "rotated", label: "Lost Mic" }, devices)).toBeNull();
  });

  it("never label-matches an empty label, and handles null pref", () => {
    expect(matchMicPreference({ deviceId: "rotated", label: "" }, devices)).toBeNull();
    expect(matchMicPreference(null, devices)).toBeNull();
  });
});
