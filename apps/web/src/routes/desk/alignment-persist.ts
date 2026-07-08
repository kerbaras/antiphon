// F7b — per-take alignment persistence. Chirp/drift verdicts are
// TAKE-DERIVED state (a pure measurement of the recorded audio), so the
// source of truth is the shared project doc: every desk plays the same
// take and needs the same schedule offsets, and reapplying a stored
// verdict beats re-measuring (re-running needs the decoded audio plus
// ~100 ms of correlation per track). localStorage keeps a SHADOW copy per
// the markers/comments pattern (use-desk.ts W3-A boundary): it seeds the
// doc after offline/server-restart gaps and gives a lone desk reload
// parity with zero round-trips. Restored values land on player track
// state only — the SAME fields align() writes, consumed through the same
// timing()/planSource math as the offline render — so playback parity is
// by construction and stored audio is never touched (RFC §13).
//
// Doc shape: getMap('alignment')  takeId → { at, entries: Record<streamId, …> }
// Whole-take verdicts write at most once per align() run; the Y.Map key is
// last-write-wins per takeId. Two desks measuring the same take
// concurrently converge to one desk's verdict — both are honest
// measurements of the same audio, the accepted bound (mirrors
// collab-doc.ts's documented Y.Map semantics). Equal-content writes are
// skipped, so doc echoes can never ping-pong.
//
// FRESHNESS (`at`, measurement wall-clock): the collab client coalesces
// outgoing updates (~33 ms), so a verdict measured moments before a reload
// may never reach the server — after the reload the doc then syncs an
// OLDER verdict than the localStorage shadow holds. Restore and the sync
// observer therefore both run newest-wins between the two layers, and the
// fresher side is written back to the other — the newest measurement
// always survives, on every desk.

import type * as Y from "yjs";
import type { PlayerSnapshot, StoredTrackAlignment } from "./player";

/** The slice of CollabClient this module needs (unit-testable with a bare
 * Y.Doc — same shape collab.ts provides). */
export interface CollabDocHandle {
  doc: Y.Doc;
  origin: unknown;
}

/** The slice of TakePlayer this module needs. */
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

const SCHEMA_VERSION = 1;

interface AlignmentStorePayload {
  v: number;
  at: number;
  entries: TakeAlignment;
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

function validAlignment(v: unknown): v is StoredTrackAlignment["alignment"] {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    isFiniteNumber(a.lagSamples) && isFiniteNumber(a.confidence) && typeof a.applied === "boolean"
  );
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
    const alignment = entry.alignment;
    if (!validAlignment(alignment)) continue;
    const drift = entry.drift ?? null;
    if (drift !== null && !validDrift(drift)) continue;
    // Rebuild exact shapes — never let unknown extra keys ride along.
    out[streamId] = {
      alignment: {
        lagSamples: alignment.lagSamples,
        confidence: alignment.confidence,
        applied: alignment.applied,
      },
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
  const payload: AlignmentStorePayload = { v: SCHEMA_VERSION, ...record };
  try {
    store?.setItem(alignmentKey(sessionId, takeId), JSON.stringify(payload));
  } catch {
    // quota / private mode: the shared doc still carries the verdict
  }
}

// ---- shared doc ------------------------------------------------------------------

function alignmentMap(doc: Y.Doc): Y.Map<TakeAlignmentRecord> {
  return doc.getMap<TakeAlignmentRecord>("alignment");
}

export function readDocAlignment(doc: Y.Doc, takeId: string): TakeAlignmentRecord | null {
  return parseTakeAlignmentRecord(alignmentMap(doc).get(takeId));
}

/** Write a take's verdict iff it differs from what the doc holds (LWW per
 * takeId key; equal-content writes skipped — no echo loops). */
export function writeDocAlignmentIfChanged(
  doc: Y.Doc,
  takeId: string,
  record: TakeAlignmentRecord,
  origin: unknown,
): boolean {
  const map = alignmentMap(doc);
  if (JSON.stringify(map.get(takeId) ?? null) === JSON.stringify(record)) return false;
  doc.transact(() => {
    map.set(takeId, record);
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

/** Newest-wins between the two layers (ties → the doc, the shared source
 * of truth), then write the winner back to the losing layer: a verdict
 * measured moments before a reload (shadow fresher than the unsynced doc)
 * survives AND propagates; a doc verdict from another desk refreshes the
 * shadow. */
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

/** Two-way binding, mirroring use-collab.ts bindMixToCollab: settled
 * align() runs persist (player → doc/shadow); remote doc updates reconcile
 * newest-wins and reapply to the loaded take (doc → player). Loop-safe by
 * construction: local writes carry `collab.origin` (observer skips them),
 * restores never fire onAlignmentSettled, equal-content writes/restores
 * are no-ops, and a fresher-shadow push-back strictly increases the doc's
 * `at` (so it can happen at most once per stale remote write). */
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
  const observer = (event: Y.YMapEvent<TakeAlignmentRecord>, txn: Y.Transaction): void => {
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
