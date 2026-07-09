// W7-A — selection-aware auto-align orchestration: the pure plan (which
// takes, which streams, in what order) and the sequential runner that
// walks it through the F5 load queue. The player owns the measurement
// (align(force, scope) — player.ts); the desk owns eligibility, ordering,
// the manual-move reset, and the restore of the operator's loaded take.
//
// CANCEL SEMANTICS — latest wins, mirroring the queue the flow rides on:
//   · a foreign load landing mid-step supersedes that step (the queue's
//     own superseded() signal), and a superseded step aborts the WHOLE
//     flow WITHOUT restoring the original take — the newer request IS the
//     operator's newest intent; restoring would fight it;
//   · recording starting (or a session switch / unmount) cancels before
//     the next step for the same reason — the flow never queues work the
//     desk's own gates would refuse;
//   · a step that merely FAILS (decode error) reports on the error strip
//     through the queue's own error path and the flow moves on — one
//     broken take must not hold the rest hostage.
// A cancelled flow may leave scoped clips' manual offsets already reset
// but not yet re-measured: the persisted verdict still draws AND plays
// them aligned (W7-A fold-in), so nothing tears — the next align run
// simply refreshes the measurement.

export interface AlignScopeStream {
  streamId: string;
  takeId: string;
  complete: boolean;
}

/** One take's slice of the flow: the streams to (re)measure. The player
 * normalizes a scope covering the whole take to a whole-take run. */
export interface AlignTakeScope {
  takeId: string;
  streamIds: string[];
}

/** Group an eligible selection into per-take align scopes. Eligibility is
 * filter-not-fail (W7-A): live-take clips, incomplete streams, and F9
 * orphans silently drop out — a mixed selection aligns what it can.
 * Order: the LOADED take first (no re-decode — the cheapest step, and the
 * operator is looking at it), then timeline take order. */
export function planAlignScopes(
  selection: readonly string[],
  streams: readonly AlignScopeStream[],
  opts: {
    liveTakeId: string | null;
    orphanedStreamIds: ReadonlySet<string>;
    takeOrder: readonly string[];
    loadedTakeId: string | null;
  },
): AlignTakeScope[] {
  const byTake = new Map<string, string[]>();
  for (const stream of streams) {
    if (!selection.includes(stream.streamId)) continue;
    if (!stream.complete) continue;
    if (stream.takeId === opts.liveTakeId) continue;
    if (opts.orphanedStreamIds.has(stream.streamId)) continue;
    const bucket = byTake.get(stream.takeId);
    if (bucket) bucket.push(stream.streamId);
    else byTake.set(stream.takeId, [stream.streamId]);
  }
  const rank = (takeId: string): number =>
    takeId === opts.loadedTakeId ? -1 : opts.takeOrder.indexOf(takeId);
  return [...byTake.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([takeId, streamIds]) => ({ takeId, streamIds: [...streamIds].sort() }));
}

export type AlignStepStatus = "ok" | "superseded" | "failed";

export interface AlignFlowDeps {
  /** The player's CURRENT loaded take (read live, not captured). */
  loadedTakeId(): string | null;
  /** Recording / session switch / unmount — checked before every step. */
  cancelled(): boolean;
  /** Load `takeId` (whole take) and force-align `streamIds` through the
   * F5 queue; resolves with the queue's honest settle status. */
  runStep(takeId: string, streamIds: readonly string[]): Promise<AlignStepStatus>;
  /** Re-request the operator's original take (standard load + restore). */
  restore(takeId: string): void;
  /** Progress for the align chip: `done` of `total` takes settled. */
  onProgress(done: number, total: number): void;
}

/** Walk the scopes sequentially (load → align → next), then restore the
 * originally loaded take when the flow moved off it. See the module
 * header for the cancel semantics. */
export async function runAlignFlow(
  scopes: readonly AlignTakeScope[],
  deps: AlignFlowDeps,
): Promise<"ok" | "cancelled"> {
  const originalTakeId = deps.loadedTakeId();
  for (const [index, scope] of scopes.entries()) {
    if (deps.cancelled()) return "cancelled";
    deps.onProgress(index, scopes.length);
    const status = await deps.runStep(scope.takeId, scope.streamIds);
    if (status === "superseded") return "cancelled"; // latest wins — no restore
  }
  deps.onProgress(scopes.length, scopes.length);
  if (deps.cancelled()) return "cancelled";
  if (originalTakeId !== null && deps.loadedTakeId() !== originalTakeId) {
    deps.restore(originalTakeId);
  }
  return "ok";
}
