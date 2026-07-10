// Selection-aware auto-align orchestration: the pure plan (which takes,
// which streams, in what order) and the sequential runner that walks it
// through the load queue. The player owns the measurement (align()).

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
 * filter-not-fail: live-take clips, incomplete streams, and orphans
 * silently drop out — a mixed selection aligns what it can. Order: the
 * LOADED take first (no re-decode), then timeline take order. */
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
   * load queue; resolves with the queue's honest settle status. */
  runStep(takeId: string, streamIds: readonly string[]): Promise<AlignStepStatus>;
  /** Re-request the operator's original take (standard load + restore). */
  restore(takeId: string): void;
  /** Progress for the align chip: `done` of `total` takes settled. */
  onProgress(done: number, total: number): void;
}

/** Walk the scopes sequentially (load → align → next), then restore the
 * originally loaded take when the flow moved off it. Latest wins: a superseded
 * step aborts the flow WITHOUT restoring; a merely failed step moves on. */
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
