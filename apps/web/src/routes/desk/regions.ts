// Clip-region domain math — the pure half of the Split tool: seeding the
// implicit region of a never-split stream, cutting a region in two, and
// the invariants every stored list must satisfy (wire shape: collab-doc).

import type { ClipRegion } from "../../net/collab-doc";

/** No region may be shorter than this — a sub-100 ms sliver is inaudible
 * as material and un-grabbable as a box, so closer splits are rejected
 * (silent no-op at the tool, never an error strip). */
export const MIN_REGION_SEC = 0.1;

/** The implicit single region of a never-split stream: the whole source at
 * its arrangement position. Its id IS the streamId — the first split keeps
 * it on the left piece so nothing re-keys under the operator. */
export function seedRegion(streamId: string, startSec: number, durationSec: number): ClipRegion {
  return { id: streamId, startSec, sourceOffsetSec: 0, durationSec };
}

/** Split one region at `atSourceSec` (SOURCE seconds). The left piece keeps
 * the original id; pieces ABUT in both domains, so a fresh split plays like
 * the uncut region. Null = rejected (unknown id, or a piece would fall
 * under MIN_REGION_SEC). */
export function splitRegion(
  regions: readonly ClipRegion[],
  regionId: string,
  atSourceSec: number,
  newId: string = crypto.randomUUID(),
): ClipRegion[] | null {
  const target = regions.find((r) => r.id === regionId);
  if (!target) return null;
  const leftSec = atSourceSec - target.sourceOffsetSec;
  const rightSec = target.sourceOffsetSec + target.durationSec - atSourceSec;
  if (leftSec < MIN_REGION_SEC || rightSec < MIN_REGION_SEC) return null;
  const left: ClipRegion = { ...target, durationSec: leftSec };
  const right: ClipRegion = {
    id: newId,
    startSec: target.startSec + leftSec,
    sourceOffsetSec: atSourceSec,
    durationSec: rightSec,
  };
  return sortRegions([...regions.filter((r) => r.id !== regionId), left, right]);
}

/** Source-domain order — the stored canonical order (collab-doc contract). */
export function sortRegions(regions: readonly ClipRegion[]): ClipRegion[] {
  return [...regions].sort((a, b) => a.sourceOffsetSec - b.sourceOffsetSec);
}

/** Resolve selected REGION ids to their owning streamIds (deduped, selection
 * order). A never-split region's id IS its streamId; split pieces resolve
 * through the doc map. Any piece selects the whole STREAM for stream-scoped
 * actions (delete, align scope) — both are per-stream by construction. */
export function selectionStreamIds(
  selection: readonly string[],
  docRegions: Readonly<Record<string, ClipRegion[]>>,
): string[] {
  const out: string[] = [];
  for (const id of selection) {
    let streamId = id;
    for (const [candidate, regions] of Object.entries(docRegions)) {
      if (regions.some((r) => r.id === id)) {
        streamId = candidate;
        break;
      }
    }
    if (!out.includes(streamId)) out.push(streamId);
  }
  return out;
}

/** Which end of a clip a trim gesture grabs. */
export type TrimEdge = "head" | "tail";

/** Trim/extend one region's edge by `deltaSec` SOURCE seconds; an edge drag
 * can re-open hidden material. Clamped, never rejected: ≥ MIN_REGION_SEC,
 * source window in-bounds and sibling-disjoint, startSec ≥ 0; a head trim
 * moves startSec WITH sourceOffsetSec so untrimmed material holds position.
 * Returns the new list, or null for an unknown region id. */
export function trimRegion(
  regions: readonly ClipRegion[],
  regionId: string,
  edge: TrimEdge,
  deltaSec: number,
  streamDurationSec: number,
): ClipRegion[] | null {
  const target = regions.find((r) => r.id === regionId);
  if (!target) return null;
  const sourceEnd = target.sourceOffsetSec + target.durationSec;
  if (edge === "head") {
    // Nearest sibling window END at or before our start caps extension.
    const prevEnd = regions.reduce(
      (acc, r) =>
        r.id !== regionId && r.sourceOffsetSec + r.durationSec <= target.sourceOffsetSec + 1e-9
          ? Math.max(acc, r.sourceOffsetSec + r.durationSec)
          : acc,
      0,
    );
    const d = Math.min(
      Math.max(deltaSec, prevEnd - target.sourceOffsetSec, -target.startSec),
      target.durationSec - MIN_REGION_SEC,
    );
    if (Math.abs(d) < 1e-9) return [...regions];
    return sortRegions(
      regions.map((r) =>
        r.id === regionId
          ? {
              ...r,
              startSec: r.startSec + d,
              sourceOffsetSec: r.sourceOffsetSec + d,
              durationSec: r.durationSec - d,
            }
          : r,
      ),
    );
  }
  // Tail: the nearest sibling window START at or after our end caps it.
  const nextStart = regions.reduce(
    (acc, r) =>
      r.id !== regionId && r.sourceOffsetSec >= sourceEnd - 1e-9
        ? Math.min(acc, r.sourceOffsetSec)
        : acc,
    streamDurationSec,
  );
  const d = Math.min(
    Math.max(deltaSec, MIN_REGION_SEC - target.durationSec),
    nextStart - sourceEnd,
  );
  if (Math.abs(d) < 1e-9) return [...regions];
  return sortRegions(
    regions.map((r) => (r.id === regionId ? { ...r, durationSec: r.durationSec + d } : r)),
  );
}

/** Stored-list invariants: source-ordered, source-disjoint, within
 * [0, streamDurationSec], every region ≥ MIN_REGION_SEC (float slack for
 * pixel-derived boundaries). ARRANGEMENT-axis overlap is deliberately
 * allowed — overlapping pieces both sound, like two whole clips would.
 * Write-guards call this; a false return means drop the write, not throw. */
export function regionsValid(regions: readonly ClipRegion[], streamDurationSec: number): boolean {
  // Empty is valid: every clip deleted — a projection state, audio archived.
  const EPS = 1e-6;
  let cursor = 0;
  for (const r of sortRegions(regions)) {
    if (r.startSec < -EPS || r.durationSec < MIN_REGION_SEC - EPS) return false;
    if (r.sourceOffsetSec < cursor - EPS) return false; // source overlap
    cursor = r.sourceOffsetSec + r.durationSec;
  }
  return cursor <= streamDurationSec + EPS;
}
