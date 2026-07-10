// Per-take alignment persistence: verdicts live in the shared doc
// (getMap('alignment'), LWW per takeId) with a localStorage shadow;
// restore/sync run newest-wins by `at` and write the winner back.

import type * as Y from "yjs";
import type { PlayerSnapshot, StoredTrackAlignment } from "./player";

/** The slice of CollabClient this module needs (unit-testable with a bare
 * Y.Doc — same shape collab.ts provides). */
export interface CollabDocHandle {
  doc: Y.Doc;
  origin: unknown;
}

/** The slice of SessionPlayer this module needs. */
export interface AlignmentPlayerPort {
  snapshot(): PlayerSnapshot;
  restoreAlignment(takeId: string, entries: Record<string, StoredTrackAlignment>): boolean;
  onAlignmentSettled(listener: (takeId: string) => void): () => void;
}

export type TakeAlignment = Record<string, StoredTrackAlignment>;

/** A take's persisted verdict: the per-stream results plus the measurement
 * wall-clock that arbitrates doc-vs-shadow freshness (see header). */
export interface TakeAlignmentRecord {
  at: number;
  entries: TakeAlignment;
}

/** Wire shape. WIRE COMPAT: chirp lags travel as `lagSamples` (v1 shape),
 * content lags as `contentLagSamples` and OMIT `lagSamples`, so legacy
 * desks drop the whole entry (honest "no verdict") instead of wrapping a
 * content lag modulo the chirp sweep interval and tearing the timeline. */
interface WireTrackAlignment {
  alignment: {
    lagSamples?: number;
    contentLagSamples?: number;
    confidence: number;
    applied: boolean;
    method?: "chirp" | "content";
  };
  drift: StoredTrackAlignment["drift"];
}

interface WireTakeAlignmentRecord {
  at: number;
  entries: Record<string, WireTrackAlignment>;
}

/** In-memory verdict → wire shape (pure; deterministic key order so the
 * equal-content write skip compares bytes meaningfully). */
function encodeEntry(entry: StoredTrackAlignment): WireTrackAlignment {
  const { lagSamples, confidence, applied } = entry.alignment;
  const method = entry.alignment.method ?? "chirp";
  return {
    alignment:
      method === "content"
        ? { contentLagSamples: lagSamples, confidence, applied, method }
        : { lagSamples, confidence, applied, method },
    drift: entry.drift ? { ...entry.drift } : null,
  };
}

function encodeRecord(record: TakeAlignmentRecord): WireTakeAlignmentRecord {
  return {
    at: record.at,
    entries: Object.fromEntries(
      Object.entries(record.entries).map(([streamId, entry]) => [streamId, encodeEntry(entry)]),
    ),
  };
}

const SCHEMA_VERSION = 1;

interface AlignmentStorePayload {
  v: number;
  at: number;
  entries: Record<string, WireTrackAlignment>;
}

type KVStore = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): KVStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // private mode / storage disabled: doc-only persistence
  }
}

export function alignmentKey(sessionId: string, takeId: string): string {
  return `antiphon:alignment:${sessionId}:${takeId}`;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Validate one wire alignment and decode it to the in-memory shape (null =
 * malformed, drop the entry). Absent method = legacy chirp; chirp needs
 * `lagSamples`, content needs `contentLagSamples`; anything else is junk. */
function decodeAlignment(v: unknown): StoredTrackAlignment["alignment"] | null {
  if (typeof v !== "object" || v === null) return null;
  const a = v as Record<string, unknown>;
  if (!isFiniteNumber(a.confidence) || typeof a.applied !== "boolean") return null;
  const method = a.method ?? "chirp";
  if (method === "chirp" && isFiniteNumber(a.lagSamples)) {
    return {
      lagSamples: a.lagSamples,
      confidence: a.confidence,
      applied: a.applied,
      method: "chirp",
    };
  }
  if (method === "content" && isFiniteNumber(a.contentLagSamples)) {
    return {
      lagSamples: a.contentLagSamples,
      confidence: a.confidence,
      applied: a.applied,
      method: "content",
    };
  }
  return null;
}

function validDrift(v: unknown): v is NonNullable<StoredTrackAlignment["drift"]> {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    isFiniteNumber(d.ratio) &&
    isFiniteNumber(d.ppm) &&
    isFiniteNumber(d.initialOffsetSamples) &&
    isFiniteNumber(d.confidence) &&
    isFiniteNumber(d.windowsUsed) &&
    typeof d.applied === "boolean" &&
    typeof d.isReference === "boolean"
  );
}

/** Validate an untrusted value (doc payloads arrive over the wire; local
 * snapshots may be stale-schema) into a TakeAlignment, entry by entry —
 * one malformed stream entry drops alone, never the whole verdict. Null
 * when nothing valid remains: persistence must degrade to "not stored",
 * never take the desk down. */
export function parseTakeAlignment(raw: unknown): TakeAlignment | null {
  if (typeof raw !== "object" || raw === null) return null;
  const out: TakeAlignment = {};
  for (const [streamId, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    // Rebuild exact shapes — never let unknown extra keys ride along;
    // decodeAlignment normalizes to one canonical in-memory shape.
    const alignment = decodeAlignment(entry.alignment);
    if (!alignment) continue;
    const drift = entry.drift ?? null;
    if (drift !== null && !validDrift(drift)) continue;
    out[streamId] = {
      alignment,
      drift:
        drift === null
          ? null
          : {
              ratio: drift.ratio,
              ppm: drift.ppm,
              initialOffsetSamples: drift.initialOffsetSamples,
              confidence: drift.confidence,
              windowsUsed: drift.windowsUsed,
              applied: drift.applied,
              isReference: drift.isReference,
            },
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Validate an untrusted record wrapper: finite `at` + valid entries. */
export function parseTakeAlignmentRecord(raw: unknown): TakeAlignmentRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (!isFiniteNumber(record.at)) return null;
  const entries = parseTakeAlignment(record.entries);
  return entries ? { at: record.at, entries } : null;
}

// ---- localStorage shadow -------------------------------------------------------

export function loadLocalAlignment(
  sessionId: string,
  takeId: string,
  store: KVStore | null = defaultStore(),
): TakeAlignmentRecord | null {
  let raw: string | null = null;
  try {
    raw = store?.getItem(alignmentKey(sessionId, takeId)) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as Partial<AlignmentStorePayload> | null;
    if (payload?.v !== SCHEMA_VERSION) return null;
    return parseTakeAlignmentRecord({ at: payload.at, entries: payload.entries });
  } catch {
    return null;
  }
}

export function saveLocalAlignment(
  sessionId: string,
  takeId: string,
  record: TakeAlignmentRecord,
  store: KVStore | null = defaultStore(),
): void {
  const payload: AlignmentStorePayload = { v: SCHEMA_VERSION, ...encodeRecord(record) };
  try {
    store?.setItem(alignmentKey(sessionId, takeId), JSON.stringify(payload));
  } catch {
    // quota / private mode: the shared doc still carries the verdict
  }
}

// ---- shared doc ------------------------------------------------------------------

function alignmentMap(doc: Y.Doc): Y.Map<WireTakeAlignmentRecord> {
  return doc.getMap<WireTakeAlignmentRecord>("alignment");
}

export function readDocAlignment(doc: Y.Doc, takeId: string): TakeAlignmentRecord | null {
  return parseTakeAlignmentRecord(alignmentMap(doc).get(takeId));
}

/** Write a take's verdict iff it differs from what the doc holds (LWW per
 * takeId; equal-content writes skipped — no echo loops). A legacy record
 * re-encoding differently causes one converging rewrite, never a loop. */
export function writeDocAlignmentIfChanged(
  doc: Y.Doc,
  takeId: string,
  record: TakeAlignmentRecord,
  origin: unknown,
): boolean {
  const map = alignmentMap(doc);
  const wire = encodeRecord(record);
  if (JSON.stringify(map.get(takeId) ?? null) === JSON.stringify(wire)) return false;
  doc.transact(() => {
    map.set(takeId, wire);
  }, origin);
  return true;
}

// ---- player integration ------------------------------------------------------------

/** Extract the loaded take's persistable verdict from a player snapshot:
 * every measured track (declined ones included — the verdict IS the
 * state), or null when nothing is measured / another take is loaded. */
export function alignmentEntriesOf(snap: PlayerSnapshot, takeId: string): TakeAlignment | null {
  if (snap.loadedTakeId !== takeId) return null;
  const out: TakeAlignment = {};
  for (const track of snap.tracks) {
    if (!track.alignment) continue;
    out[track.streamId] = {
      alignment: { ...track.alignment },
      drift: track.drift ? { ...track.drift } : null,
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Persist a take's verdict to both layers (doc + localStorage shadow). */
export function persistTakeAlignment(
  collab: CollabDocHandle,
  sessionId: string,
  takeId: string,
  entries: TakeAlignment,
  at: number = Date.now(),
): void {
  const record: TakeAlignmentRecord = { at, entries };
  writeDocAlignmentIfChanged(collab.doc, takeId, record, collab.origin);
  saveLocalAlignment(sessionId, takeId, record);
}

/** Newest-wins between the two layers (ties → the doc), then write the
 * winner back to the losing layer: a verdict measured moments before a
 * reload survives AND propagates; a remote doc verdict refreshes the shadow. */
function reconcile(
  collab: CollabDocHandle,
  sessionId: string,
  takeId: string,
): TakeAlignmentRecord | null {
  const fromDoc = readDocAlignment(collab.doc, takeId);
  const local = loadLocalAlignment(sessionId, takeId);
  const winner = local && (!fromDoc || local.at > fromDoc.at) ? local : fromDoc;
  if (!winner) return null;
  if (winner !== fromDoc) writeDocAlignmentIfChanged(collab.doc, takeId, winner, collab.origin);
  if (winner !== local) saveLocalAlignment(sessionId, takeId, winner);
  return winner;
}

/** Read a take's persisted verdict without a player in the loop (look-ahead
 * mounts, session render). Runs the same newest-wins reconcile as a
 * restore, so both layers converge as a side effect. */
export function readTakeAlignment(
  collab: CollabDocHandle,
  sessionId: string,
  takeId: string,
): TakeAlignment | null {
  return reconcile(collab, sessionId, takeId)?.entries ?? null;
}

/** Reapply a persisted verdict to a freshly loaded take. Returns true when
 * the player state changed. */
export function restoreTakeAlignment(
  collab: CollabDocHandle,
  player: AlignmentPlayerPort,
  sessionId: string,
  takeId: string,
): boolean {
  const winner = reconcile(collab, sessionId, takeId);
  return winner ? player.restoreAlignment(takeId, winner.entries) : false;
}

/** Two-way binding: settled align() runs persist (player → doc/shadow);
 * remote doc updates reconcile newest-wins and reapply (doc → player).
 * Loop-safe: local writes carry `collab.origin`, restores never fire
 * onAlignmentSettled, and equal-content writes/restores are no-ops. */
export function bindAlignmentToCollab(
  collab: CollabDocHandle,
  player: AlignmentPlayerPort,
  sessionId: string,
): () => void {
  const unsubscribe = player.onAlignmentSettled((takeId) => {
    const entries = alignmentEntriesOf(player.snapshot(), takeId);
    if (entries) persistTakeAlignment(collab, sessionId, takeId, entries);
  });
  const map = alignmentMap(collab.doc);
  const observer = (event: Y.YMapEvent<WireTakeAlignmentRecord>, txn: Y.Transaction): void => {
    if (txn.origin === collab.origin) return;
    for (const takeId of event.keysChanged) {
      const winner = reconcile(collab, sessionId, takeId);
      if (winner) player.restoreAlignment(takeId, winner.entries);
    }
  };
  map.observe(observer);
  return () => {
    map.unobserve(observer);
    unsubscribe();
  };
}
