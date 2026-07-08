// Stable device identity (A12) + nickname (A13), persisted in localStorage
// so a reloading/reconnecting phone resumes its peer instead of forking a
// new anonymous lane. Storage is injectable for tests and guarded against
// environments where localStorage throws (private mode): identity then
// degrades to per-page-load, exactly the pre-A12 behavior.

export const DEVICE_ID_KEY = "antiphon:device-id";
export const NICKNAME_KEY = "antiphon:nickname";

type KVStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStore(): KVStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** In-memory fallback when storage is unavailable or throwing, scoped per
 * store so distinct stores (tests) never leak into each other. */
const volatileByStore = new WeakMap<KVStore, Map<string, string>>();
const nullStoreVolatile = new Map<string, string>();

function volatileFor(store: KVStore | null): Map<string, string> {
  if (!store) return nullStoreVolatile;
  let map = volatileByStore.get(store);
  if (!map) {
    map = new Map();
    volatileByStore.set(store, map);
  }
  return map;
}

function read(key: string, store: KVStore | null): string | null {
  try {
    return store?.getItem(key) ?? volatileFor(store).get(key) ?? null;
  } catch {
    return volatileFor(store).get(key) ?? null;
  }
}

function write(key: string, value: string, store: KVStore | null): void {
  volatileFor(store).set(key, value);
  try {
    store?.setItem(key, value);
  } catch {
    // quota / private mode: volatile copy still serves this page load
  }
}

function remove(key: string, store: KVStore | null): void {
  volatileFor(store).delete(key);
  try {
    store?.removeItem(key);
  } catch {
    // already best-effort
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** UI-wide nickname cap. The wire bound is 256 (A13, packages/protocol);
 * 48 is the product norm every nickname input advertises via maxLength —
 * and maxLength alone is decorative: paste and programmatic writes walk
 * straight past it, so the cap is enforced HERE, at commit time. */
export const NICKNAME_MAX_LENGTH = 48;

/** Commit-time normalization: trim, then hard-cap at NICKNAME_MAX_LENGTH
 * UTF-16 units. A cut that would split a surrogate pair drops the whole
 * pair instead (a lone surrogate renders as U+FFFD — QA #14's failure
 * mode), and whitespace exposed by the cut is re-trimmed. */
export function normalizeNickname(raw: string): string {
  let name = raw.trim().slice(0, NICKNAME_MAX_LENGTH);
  const last = name.charCodeAt(name.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) name = name.slice(0, -1);
  return name.trim();
}

/** UUID generated once per browser and persisted (A12). */
export function getDeviceId(store: KVStore | null = defaultStore()): string {
  const existing = read(DEVICE_ID_KEY, store);
  if (existing && UUID_RE.test(existing)) return existing;
  const fresh = crypto.randomUUID();
  write(DEVICE_ID_KEY, fresh, store);
  return fresh;
}

/** Last nickname the user set on this device (prefills the join page).
 * Normalized on read too, healing overlong values persisted pre-cap. */
export function getNickname(store: KVStore | null = defaultStore()): string | null {
  const value = read(NICKNAME_KEY, store);
  const normalized = value ? normalizeNickname(value) : "";
  return normalized ? normalized : null;
}

/** Persist (or clear, for empty/whitespace) the nickname. */
export function setNickname(name: string, store: KVStore | null = defaultStore()): void {
  const normalized = normalizeNickname(name);
  if (normalized) write(NICKNAME_KEY, normalized, store);
  else remove(NICKNAME_KEY, store);
}
