// Markers/comments take lists. Element identity is the model uuid; an edit
// replaces the same-id element (delete+insert). Concurrent edits of the SAME
// element can duplicate it in the stored array — the accepted bound.

import * as Y from "yjs";

export type ListKind = "markers" | "comments";

/** An element that can live in a doc list: stable uuid identity. */
export interface ListItem {
  id: string;
}

/** Transaction origin for heals. Not the remote marker, so a heal relays
 * to the wire like any local edit; distinguishable in devtools. */
export const HEAL_ORIGIN = "collab-doc:heal";

function listMap<T extends ListItem>(doc: Y.Doc, kind: ListKind): Y.Map<Y.Array<T>> {
  return doc.getMap<Y.Array<T>>(kind);
}

/** id → index of its LAST occurrence: the shared winner rule. */
function lastIndexById<T extends ListItem>(items: readonly T[]): Map<string, number> {
  const last = new Map<string, number>();
  for (const [i, item] of items.entries()) last.set(item.id, i);
  return last;
}

/** Pure same-id collapse: keep each id's LAST occurrence. Yjs converges all
 * replicas to the same array order, so every desk picks the SAME winner. */
export function dedupeById<T extends ListItem>(items: readonly T[]): T[] {
  const last = lastIndexById(items);
  return items.filter((item, i) => last.get(item.id) === i);
}

/** True when the doc carries an entry for this take (even an empty one) —
 * the switch between doc-authoritative and localStorage-fallback display. */
export function hasTakeList(doc: Y.Doc, kind: ListKind, takeId: string): boolean {
  return listMap(doc, kind).has(takeId);
}

/** Materialize a take's list for the UI: same-id duplicates collapse to the
 * deterministic winner, so the UI never sees duplicate ids/React keys. */
export function readTakeList<T extends ListItem>(doc: Y.Doc, kind: ListKind, takeId: string): T[] {
  const arr = listMap<T>(doc, kind).get(takeId);
  return arr ? dedupeById(arr.toArray()) : [];
}

/** Heal stored same-id duplicates: transact a DELETE-ONLY collapse to the
 * read path's winner. Idempotent and insert-free, and the winner is last in
 * every replica's order, so concurrent heals can never ping-pong. */
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
 * remote adds intact (never a wholesale clear). One transaction per call. */
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
 * no-op when the doc already has an entry or another desk's seed flag
 * landed first. Two desks seeding concurrently while offline can still
 * duplicate — accepted. Returns true when this call seeded. */
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
    // Dedupe defensively: a stale localStorage shadow may still carry
    // duplicates — never let a seed re-plant them in the doc.
    arr.push(dedupeById(items));
    listMap<T>(doc, kind).set(takeId, arr);
    seeded.set(flag, true);
  }, origin);
  return true;
}

/** Display rule: the doc rules once it carries an entry for the take; until
 * then the localStorage snapshot shows. Doubles as the heal trigger — Yjs
 * runs transactions opened inside observers after the current one settles,
 * so healing from a refresh observer is safe. */
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
