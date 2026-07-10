// Shared project doc: the doc SHAPE (per-session Y.Doc maps: mix, arrange,
// regions, laneOrder, markers/comments lists, seed flags — LWW per key) and
// pure read/write helpers, transport-free (transport lives in collab.ts).

import * as Y from "yjs";

export {
  dedupeById,
  displayTakeList,
  HEAL_ORIGIN,
  hasTakeList,
  healTakeListDuplicates,
  type ListItem,
  type ListKind,
  readTakeList,
  seedTakeListOnce,
  writeTakeList,
} from "./collab-doc-lists";

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
 * Returns true when a write happened. */
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

/** Lane moves write the FULL map (every on-screen lane gets its position);
 * lanes absent from the map joined after the last move and follow the
 * track-model append rule. Does not replace the frozen ranks. */
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

// ---- clip regions ----------------------------------------------------------
// streamId → whole region list per key (LWW per stream; a lost concurrent
// split is one re-click, audio untouched). Compat: ABSENT entry = never-split
// (readers derive an implicit region from `arrange`, drags keep writing
// `arrange`); EMPTY list = every clip deleted from the arrangement (valid);
// old builds ignore this map and read `arrange` — stale view, never torn.

/** One split piece of a stream, placed on the arrangement. Regions of one
 * stream are ordered and non-overlapping in the SOURCE domain (enforced by
 * the desk's split math); `startSec` shares the `arrange` axis. */
export interface ClipRegion {
  /** Stable region identity. The first (seeded) region KEEPS the streamId
   * as its id, so "region id == streamId for unsplit streams" survives the
   * first split unchanged. */
  id: string;
  /** Arrangement position of the region (audio domain, ≥ 0). */
  startSec: number;
  /** Where in the stream's source audio this region begins (raw buffer
   * seconds from sample 0 — alignment head-trims stay schedule-time). */
  sourceOffsetSec: number;
  /** Region length in source seconds. */
  durationSec: number;
}

/** Hostile-data boundary: the doc is writable by any desk build, and a
 * garbage region would reach source.start(NaN). Whole-list-or-nothing: any
 * invalid piece invalidates the LIST, and an invalid list reads as ABSENT
 * (the never-split view) — a partial subset would silently lose audio. */
function validRegionList(value: unknown): ClipRegion[] | null {
  if (!Array.isArray(value)) return null;
  for (const region of value) {
    if (typeof region !== "object" || region === null) return null;
    const { id, startSec, sourceOffsetSec, durationSec } = region as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0) return null;
    if (
      !Number.isFinite(startSec) ||
      !Number.isFinite(sourceOffsetSec) ||
      !Number.isFinite(durationSec)
    ) {
      return null;
    }
    if ((startSec as number) < 0 || (sourceOffsetSec as number) < 0) return null;
    if ((durationSec as number) <= 0) return null;
  }
  return value as ClipRegion[];
}

/** Read every stream's region list — validated: every list this returns is
 * well-formed, so no consumer needs its own defensive checks. */
export function readRegions(doc: Y.Doc): Record<string, ClipRegion[]> {
  const out: Record<string, ClipRegion[]> = {};
  doc.getMap<unknown>("regions").forEach((value, key) => {
    const regions = validRegionList(value);
    if (regions) out[key] = regions;
  });
  return out;
}

/** Replace one stream's whole region list (split, region drag). Equal
 * content is a no-op — doc echoes and re-derived writes never churn the
 * wire. Returns true when a write happened. */
export function writeStreamRegions(
  doc: Y.Doc,
  streamId: string,
  regions: ClipRegion[],
  origin: unknown,
): boolean {
  const map = doc.getMap<ClipRegion[]>("regions");
  if (JSON.stringify(map.get(streamId)) === JSON.stringify(regions)) return false;
  doc.transact(() => {
    map.set(streamId, regions);
  }, origin);
  return true;
}

/** Drop deleted streams' region lists (the deleteArrangeKeys twin — both
 * run on the server-confirmed streams-deleted fanout). */
export function deleteRegionKeys(doc: Y.Doc, keys: string[], origin: unknown): void {
  const map = doc.getMap<ClipRegion[]>("regions");
  const present = keys.filter((k) => map.has(k));
  if (present.length === 0) return;
  doc.transact(() => {
    for (const key of present) map.delete(key);
  }, origin);
}

// ---- arrangement undo ledger -----------------------------------------------

/** How long consecutive tracked writes merge into ONE undo step: covers a
 * drag/trim gesture's per-pointermove writes; distinct gestures also seal
 * explicitly (CollabClient.sealUndo at gesture start). */
export const UNDO_CAPTURE_MS = 500;

/** The clip-arrangement undo ledger over the `regions` + `arrange` maps,
 * tracking ONLY transactions carrying `origin` — this desk's own edits.
 * Remote and system writes never enter the stack, so undo can never revert
 * someone else's work or resurrect keys for durably deleted streams. */
export function createArrangementUndo(doc: Y.Doc, origin: unknown): Y.UndoManager {
  return new Y.UndoManager([doc.getMap("regions"), doc.getMap("arrange")], {
    trackedOrigins: new Set([origin]),
    captureTimeout: UNDO_CAPTURE_MS,
  });
}
