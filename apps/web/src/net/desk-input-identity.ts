// Identity + preferences for the desk's embedded recorder (W2-D). The desk
// input joins the session as an ordinary recorder peer, so it needs its own
// stable deviceId (A12) — derived deterministically from the desk's browser
// deviceId rather than stored separately, so the pair can never diverge.
// Input preferences (which device, lane nickname) persist alongside it for
// one-click resume after a reload.

export const DESK_INPUT_PREFS_KEY = "antiphon:desk-input";

type KVStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStore(): KVStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Fixed 16-byte pad ("antiphon-input.1") XORed into the desk deviceId. */
const DERIVE_PAD = new TextEncoder().encode("antiphon-input.1");

/**
 * The embedded recorder's deviceId (A12): the desk's browser deviceId XORed
 * with a fixed pad, re-stamped as UUIDv4. Deterministic (the same desk always
 * resumes the same input lane), a valid UUID (the protocol schema requires
 * one), and guaranteed distinct from the desk's own id (byte 0 always flips).
 */
export function deriveDeskInputDeviceId(deskDeviceId: string): string {
  const hex = deskDeviceId.replaceAll("-", "").toLowerCase();
  if (hex.length !== 32 || /[^0-9a-f]/.test(hex)) {
    throw new Error(`bad device id: ${deskDeviceId}`);
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16) ^ (DERIVE_PAD[i] as number);
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // RFC 4122 variant
  const out = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}

/** Default lane nickname for a freshly picked input. */
export function defaultDeskInputLabel(inputLabel: string): string {
  const trimmed = inputLabel.trim();
  return trimmed ? `Room mic (${trimmed})` : "Room mic";
}

export interface DeskInputPrefs {
  /** MediaDeviceInfo.deviceId of the chosen input. */
  inputId: string;
  /** Human name of the input at selection time (resume display + matching). */
  inputLabel: string;
  /** Lane nickname override (null = derive from the input label). */
  label: string | null;
}

/** Last-used desk input, or null when never enabled / storage unreadable. */
export function loadDeskInputPrefs(store: KVStore | null = defaultStore()): DeskInputPrefs | null {
  try {
    const raw = store?.getItem(DESK_INPUT_PREFS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p.inputId !== "string" || typeof p.inputLabel !== "string") return null;
    return {
      inputId: p.inputId,
      inputLabel: p.inputLabel,
      label: typeof p.label === "string" && p.label.trim() ? p.label : null,
    };
  } catch {
    return null;
  }
}

/** Persist (or clear, with null) the desk input preferences. Best-effort. */
export function saveDeskInputPrefs(
  prefs: DeskInputPrefs | null,
  store: KVStore | null = defaultStore(),
): void {
  try {
    if (prefs) store?.setItem(DESK_INPUT_PREFS_KEY, JSON.stringify(prefs));
    else store?.removeItem(DESK_INPUT_PREFS_KEY);
  } catch {
    // quota / private mode: prefs then live for this page load only
  }
}
