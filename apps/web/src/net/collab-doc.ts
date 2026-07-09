// W3-A shared project doc — the doc SHAPE and its pure read/write helpers,
// separated from the transport (collab.ts) so every mutation rule is
// unit-testable with plain Y.Docs.
//
// One Y.Doc per session:
//   getMap('mix')       channelKey (lane peerId | 'master') → MixStripState
//   getMap('arrange')   streamId → clip start seconds on the arrangement
//   getMap('laneOrder') laneKey → display ordinal (W4-E deliberate moves)
//   getMap('markers')   takeId → Y.Array<Marker>       (W2-B plain objects)
//   getMap('comments')  takeId → Y.Array<TakeComment>  (W2-F plain objects)
//   getMap('seeded')    `${kind}:${takeId}` → true      (seed-once guard)
// Transport/playhead state is NOT in the doc (per-desk; presence carries a
// ghost playhead). Lane names stay on the signaling peer-update protocol
// (A13, server-persisted) — never duplicated here. Audio bytes are NEVER in
// the doc: blobs stay content-addressed outside the CRDT (ARCHITECTURE §6).
//
// List semantics (markers/comments): element identity is the model uuid;
// edit/resolve replaces the array element with the same id (delete+insert).
// Concurrent edits of the SAME element can duplicate it IN THE STORED ARRAY
// (both replacements survive the merge) — the accepted convergence bound;
// adds/removes/edits of different elements converge cleanly. Two layers keep
// that bound invisible and short-lived (F16):
//   (a) read path: readTakeList/displayTakeList collapse same-id entries to
//       one deterministic winner (last in array order — Yjs converges every
//       replica to the SAME order, so every desk picks the SAME winner);
//       the UI can never render duplicate rows or duplicate React keys.
//   (b) heal: displayTakeList opportunistically transacts a delete-only
//       collapse to that winner (healTakeListDuplicates) when it sees
//       duplicates, so the stored array shrinks back without waiting for
//       the next user edit. Delete-only + idempotent ⇒ no heal ping-pong:
//       concurrent heals delete the same losers, and the final-order winner
//       is by construction the last occurrence in EVERY replica that holds
//       it, so no heal ever deletes it.
// Y.Map keys (mix/arrange) are last-write-wins per key.

import * as Y from "yjs";

/** One mixer strip as stored in the doc — mirrors player.ts ChannelStrip
 * minus the key (the map key carries it). 'master' uses the same shape
 * (muted/soloed stay false; the master bus has no mute/solo). */
export interface MixStripState {
  gainDb: number;
  pan: number;
  muted: boolean;
  soloed: boolean;
  eq: {
    lowDb: number;
    midDb: number;
    midHz: number;
    highDb: number;
    bypassed: boolean;
  };
}

export const MASTER_KEY = "master";

export function defaultMixStripState(): MixStripState {
  return {
    gainDb: 0,
    pan: 0,
    muted: false,
    soloed: false,
    eq: { lowDb: 0, midDb: 0, midHz: 1_000, highDb: 0, bypassed: false },
  };
}

export type ListKind = "markers" | "comments";

/** An element that can live in a doc list: stable uuid identity. */
export interface ListItem {
  id: string;
}

// ---- mix ---------------------------------------------------------------------

export function readMix(doc: Y.Doc): Map<string, MixStripState> {
  const out = new Map<string, MixStripState>();
  doc.getMap<MixStripState>("mix").forEach((value, key) => {
    out.set(key, value);
  });
  return out;
}

/** Write one strip iff it differs from what the doc holds (or from the
 * defaults when the key is absent — untouched lanes never pollute the doc).
 * Returns true when a write happened. Equality is structural: the caller
 * feeds plain state objects, so JSON compare is exact. */
export function writeMixIfChanged(
  doc: Y.Doc,
  key: string,
  state: MixStripState,
  origin: unknown,
): boolean {
  const map = doc.getMap<MixStripState>("mix");
  const current = map.get(key) ?? defaultMixStripState();
  if (JSON.stringify(current) === JSON.stringify(state)) return false;
  doc.transact(() => {
    map.set(key, state);
  }, origin);
  return true;
}

// ---- arrange / lane order --------------------------------------------------------
// Two flat number maps with identical mutation rules: read the whole map,
// write a FULL replacement (set changed keys, drop keys that left) in one
// transaction. LWW per key under concurrency, like every Y.Map here.

function readNumberMap(doc: Y.Doc, name: string): Record<string, number> {
  const out: Record<string, number> = {};
  doc.getMap<number>(name).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function writeNumberMap(
  doc: Y.Doc,
  name: string,
  next: Record<string, number>,
  origin: unknown,
): boolean {
  const map = doc.getMap<number>(name);
  const stale = [...map.keys()].filter((k) => !(k in next));
  const changed = Object.entries(next).filter(([k, v]) => map.get(k) !== v);
  if (stale.length === 0 && changed.length === 0) return false;
  doc.transact(() => {
    for (const key of stale) map.delete(key);
    for (const [key, value] of changed) map.set(key, value);
  }, origin);
  return true;
}

export function readArrange(doc: Y.Doc): Record<string, number> {
  return readNumberMap(doc, "arrange");
}

/** Apply a full override map: set changed keys, drop keys not in `next`.
 * One transaction so a multi-clip drag fans out as one update. */
export function writeArrange(doc: Y.Doc, next: Record<string, number>, origin: unknown): boolean {
  return writeNumberMap(doc, "arrange", next, origin);
}

// ---- lane order (W4-E) -----------------------------------------------------------
// Deliberate operator lane moves: laneKey (peerId, or the streamId fallback
// for never-attributed lanes) → display ordinal. Written as a FULL map on
// every move — one Move up/down assigns every on-screen lane its position —
// so lanes absent from the map are exactly the ones that joined after the
// last move; they follow F8's append rule (track-model.ts applyLaneMoves).
// This map deliberately does NOT replace the frozen ranks: those stay the
// spontaneous-churn guard, this is the sanctioned operator override.

export function readLaneOrder(doc: Y.Doc): Record<string, number> {
  return readNumberMap(doc, "laneOrder");
}

export function writeLaneOrder(doc: Y.Doc, next: Record<string, number>, origin: unknown): boolean {
  return writeNumberMap(doc, "laneOrder", next, origin);
}

export function deleteArrangeKeys(doc: Y.Doc, keys: string[], origin: unknown): void {
  const map = doc.getMap<number>("arrange");
  const present = keys.filter((k) => map.has(k));
  if (present.length === 0) return;
  doc.transact(() => {
    for (const key of present) map.delete(key);
  }, origin);
}

// ---- markers / comments lists ---------------------------------------------------

function listMap<T extends ListItem>(doc: Y.Doc, kind: ListKind): Y.Map<Y.Array<T>> {
  return doc.getMap<Y.Array<T>>(kind);
}

/** id → index of its LAST occurrence: the shared winner rule (see below). */
function lastIndexById<T extends ListItem>(items: readonly T[]): Map<string, number> {
  const last = new Map<string, number>();
  for (const [i, item] of items.entries()) last.set(item.id, i);
  return last;
}

/** Pure same-id collapse: keep each id's LAST occurrence, drop the rest.
 * "Last in array order" is the one winner rule every layer shares — Yjs
 * converges all replicas to the same array order, so all desks agree.
 * Returns the input untouched (new array) when ids are already unique. */
export function dedupeById<T extends ListItem>(items: readonly T[]): T[] {
  const last = lastIndexById(items);
  return items.filter((item, i) => last.get(item.id) === i);
}

/** True when the doc carries an entry for this take (even an empty one) —
 * the switch between doc-authoritative and localStorage-fallback display. */
export function hasTakeList(doc: Y.Doc, kind: ListKind, takeId: string): boolean {
  return listMap(doc, kind).has(takeId);
}

/** Materialize a take's list for the UI. Same-id duplicates (the F16
 * concurrent-replace bound) collapse to the deterministic winner — the read
 * path NEVER hands the UI duplicate ids. */
export function readTakeList<T extends ListItem>(doc: Y.Doc, kind: ListKind, takeId: string): T[] {
  const arr = listMap<T>(doc, kind).get(takeId);
  return arr ? dedupeById(arr.toArray()) : [];
}

/** Opportunistic F16 heal: when the stored array holds same-id duplicates,
 * transact a DELETE-ONLY collapse to the read path's winner (each id's last
 * occurrence). Returns true when something was deleted.
 *
 * Loop safety, proven in tests: idempotent (a healed array never re-heals),
 * insert-free (the doc can only shrink), and winner-stable — Yjs orders any
 * two elements identically on every replica, so the element that is last in
 * the fully-merged order is also last in every partial view that contains
 * it; no replica's heal ever deletes it, and concurrent heals just issue
 * redundant deletes of the same losers, which merge as no-ops. */
export function healTakeListDuplicates(
  doc: Y.Doc,
  kind: ListKind,
  takeId: string,
  origin: unknown,
): boolean {
  const arr = listMap(doc, kind).get(takeId);
  if (!arr) return false;
  const items = arr.toArray();
  const last = lastIndexById(items);
  if (last.size === items.length) return false;
  doc.transact(() => {
    // Walk backwards so deletions never shift a yet-unvisited index.
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item && last.get(item.id) !== i) arr.delete(i, 1);
    }
  }, origin);
  return true;
}

/** Reconcile the take's Y.Array to `next` by uuid identity: remove ids that
 * left, replace ids whose payload changed, append new ids. Keeps concurrent
 * remote adds intact (never a wholesale clear), converges under Yjs list
 * semantics. One transaction per call. */
export function writeTakeList<T extends ListItem>(
  doc: Y.Doc,
  kind: ListKind,
  takeId: string,
  next: readonly T[],
  origin: unknown,
): void {
  doc.transact(() => {
    const map = listMap<T>(doc, kind);
    let arr = map.get(takeId);
    if (!arr) {
      arr = new Y.Array<T>();
      map.set(takeId, arr);
    }
    const nextById = new Map(next.map((item) => [item.id, item]));
    // Walk backwards so deletions don't shift pending indices.
    for (let i = arr.length - 1; i >= 0; i--) {
      const current = arr.get(i);
      const wanted = nextById.get(current.id);
      if (!wanted) {
        arr.delete(i, 1);
      } else {
        if (JSON.stringify(current) !== JSON.stringify(wanted)) {
          arr.delete(i, 1);
          arr.insert(i, [wanted]);
        }
        nextById.delete(current.id);
      }
    }
    if (nextById.size > 0) arr.push([...nextById.values()]);
  }, origin);
}

/** Seed a take's list from localStorage exactly once per (kind, take):
 * no-op when the doc already has an entry for the take or when another
 * desk's seed flag landed first. "Idempotent-ish": two desks seeding the
 * same take CONCURRENTLY (both offline, then merging) can still duplicate —
 * accepted, documented; the flag closes the common races. Returns true when
 * this call seeded. */
export function seedTakeListOnce<T extends ListItem>(
  doc: Y.Doc,
  kind: ListKind,
  takeId: string,
  items: readonly T[],
  origin: unknown,
): boolean {
  if (items.length === 0) return false;
  const seeded = doc.getMap<boolean>("seeded");
  const flag = `${kind}:${takeId}`;
  if (seeded.get(flag) || hasTakeList(doc, kind, takeId)) return false;
  doc.transact(() => {
    const arr = new Y.Array<T>();
    // Dedupe defensively: a pre-heal-era localStorage shadow may still
    // carry F16 duplicates — never let a seed re-plant them in the doc.
    arr.push(dedupeById(items));
    listMap<T>(doc, kind).set(takeId, arr);
    seeded.set(flag, true);
  }, origin);
  return true;
}

/** Transaction origin for F16 heals. Not the remote marker, so a heal
 * relays to the wire like any local edit; distinguishable in devtools. */
export const HEAL_ORIGIN = "collab-doc:heal";

/** Offline-fallback display rule: the doc rules once it carries an entry
 * for the take; until then the localStorage snapshot shows (single-desk
 * cold start renders instantly, no sync round-trip in the way).
 *
 * This is the UI materialization point (use-desk.ts refresh calls it on
 * every observed doc change), so it doubles as the F16 heal trigger: seeing
 * same-id duplicates here means a concurrent-replace merge just landed, and
 * the stored array is collapsed to the winner the read path returns anyway.
 * Yjs runs transactions opened inside observer callbacks after the current
 * one settles, so healing from the refresh observer is safe. */
export function displayTakeList<T extends ListItem>(
  doc: Y.Doc,
  kind: ListKind,
  takeId: string,
  localFallback: readonly T[],
): T[] {
  if (!hasTakeList(doc, kind, takeId)) return dedupeById(localFallback);
  healTakeListDuplicates(doc, kind, takeId, HEAL_ORIGIN);
  return readTakeList<T>(doc, kind, takeId);
}
