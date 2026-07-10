// Persisted mic choice, stored as {deviceId, label}: deviceIds are NOT
// durable (iOS Safari re-mints them), so the label is the recovery key.
// Storage never throws — degrade to "no preference" (the default mic).

export const MIC_PREF_KEY = "antiphon:mic-input";

type KVStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStore(): KVStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export interface MicPreference {
  /** MediaDeviceInfo.deviceId at selection time (may rotate — see above). */
  deviceId: string;
  /** Human name at selection time; the fallback matching key. */
  label: string;
}

export interface MicDeviceOption {
  id: string;
  label: string;
}

/** Last mic the performer picked, or null when never chosen / unreadable. */
export function loadMicPreference(store: KVStore | null = defaultStore()): MicPreference | null {
  try {
    const raw = store?.getItem(MIC_PREF_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p.deviceId !== "string" || p.deviceId === "" || typeof p.label !== "string") {
      return null;
    }
    return { deviceId: p.deviceId, label: p.label };
  } catch {
    return null;
  }
}

/** Persist (or clear, with null) the mic preference. Best-effort. */
export function saveMicPreference(
  pref: MicPreference | null,
  store: KVStore | null = defaultStore(),
): void {
  try {
    if (pref) store?.setItem(MIC_PREF_KEY, JSON.stringify(pref));
    else store?.removeItem(MIC_PREF_KEY);
  } catch {
    // quota / private mode: the preference then lives for this visit only
  }
}

/**
 * Which enumerated device the preference points at: exact deviceId first,
 * then label (heals rotated ids — iOS), else null (device is gone; the
 * caller stays on the default mic and never hard-fails).
 */
export function matchMicPreference(
  pref: MicPreference | null,
  devices: MicDeviceOption[],
): MicDeviceOption | null {
  if (!pref) return null;
  return (
    devices.find((d) => d.id === pref.deviceId) ??
    (pref.label !== "" ? (devices.find((d) => d.label === pref.label) ?? null) : null)
  );
}
