// W7-B clip-region domain math — the pure half of the Split tool. The doc
// shape and its read/write helpers live in net/collab-doc.ts (wire layer);
// this module owns what a split MEANS: seeding the implicit region of a
// never-split stream, cutting a region in two, and the invariants every
// stored list must satisfy. All functions are pure so the rules are
// unit-testable without a Y.Doc or a pointer event.

import type { ClipRegion } from "../../net/collab-doc";

/** No region may be shorter than this — a sub-100 ms sliver is inaudible
 * as material and un-grabbable as a box, so closer splits are rejected
 * (silent no-op at the tool, never an error strip). */
export const MIN_REGION_SEC = 0.1;

/** The implicit single region of a never-split stream: the whole source at
 * its arrangement position. Its id IS the streamId — selection, delete
 * staging, and every pre-region spec key off that identity, and the first
 * split keeps it on the left piece so nothing re-keys under the operator. */
export function seedRegion(streamId: string, startSec: number, durationSec: number): ClipRegion {
  return { id: streamId, startSec, sourceOffsetSec: 0, durationSec };
}

/** Split one region of a stream's list at `atSourceSec` (SOURCE-domain
 * seconds, same axis as sourceOffsetSec). Returns the new list — source-
 * ordered, the left piece keeping the original id (stable identity for
 * selection and the seeded streamId id), the right piece minted fresh —
 * or null when the cut is rejected: unknown region, or either piece would
 * fall under MIN_REGION_SEC. The pieces ABUT both in source and on the
 * arrangement (right.startSec = left.startSec + left.durationSec), so a
 * fresh split plays and draws exactly like the uncut region.
 */
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
 * through the doc map. Selecting ANY piece of a split stream selects the
 * whole STREAM for stream-scoped actions — delete staging (W7-B) and the
 * align scope (W7-A × W7-B) alike, because both are per-stream by
 * construction: deletion is durable stream removal, and alignment
 * head-trims are properties of the capture, shared by all its pieces. */
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

/** The stored-list invariants (collab-doc.ts ClipRegion doc): source-ordered,
 * non-overlapping in the source domain, within [0, streamDurationSec], every
 * region ≥ MIN_REGION_SEC (a hair of float slack so a boundary computed
 * through pixel geometry never fails its own invariant). Write-guards call
 * this; a false return means drop the write, not throw.
 *
 * ARRANGEMENT-axis overlap between pieces is deliberately ALLOWED (pinned
 * in regions.test.ts): drag two pieces of one stream over each other and
 * BOTH sound — mixed/doubled audio, exactly what two whole clips dragged
 * onto each other have always done. Source disjointness is the only
 * overlap rule; where the operator stacks the pieces is arrangement. */
export function regionsValid(regions: readonly ClipRegion[], streamDurationSec: number): boolean {
  if (regions.length === 0) return false;
  const EPS = 1e-6;
  let cursor = 0;
  for (const r of sortRegions(regions)) {
    if (r.startSec < -EPS || r.durationSec < MIN_REGION_SEC - EPS) return false;
    if (r.sourceOffsetSec < cursor - EPS) return false; // source overlap
    cursor = r.sourceOffsetSec + r.durationSec;
  }
  return cursor <= streamDurationSec + EPS;
}
