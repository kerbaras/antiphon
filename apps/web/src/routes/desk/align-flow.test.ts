// W7-A — selection-aware align orchestration: plan eligibility/ordering
// and the runner's latest-wins cancel semantics (module header contract).

import { describe, expect, it } from "vitest";
import {
  type AlignFlowDeps,
  type AlignScopeStream,
  planAlignScopes,
  runAlignFlow,
} from "./align-flow";

const STREAMS: AlignScopeStream[] = [
  { streamId: "a1", takeId: "t1", complete: true },
  { streamId: "a2", takeId: "t1", complete: true },
  { streamId: "b1", takeId: "t2", complete: true },
  { streamId: "b2", takeId: "t2", complete: false }, // still syncing
  { streamId: "c1", takeId: "live", complete: true }, // rolling take
  { streamId: "o1", takeId: "t2", complete: true }, // F9 orphan
];

const OPTS = {
  liveTakeId: "live",
  orphanedStreamIds: new Set(["o1"]),
  takeOrder: ["t1", "t2", "live"],
  loadedTakeId: null as string | null,
};

describe("planAlignScopes (W7-A)", () => {
  it("groups by take and filters live/incomplete/orphan streams — filter, not fail", () => {
    const scopes = planAlignScopes(["a2", "a1", "b1", "b2", "c1", "o1"], STREAMS, OPTS);
    expect(scopes).toEqual([
      { takeId: "t1", streamIds: ["a1", "a2"] },
      { takeId: "t2", streamIds: ["b1"] },
    ]);
  });

  it("puts the LOADED take first, then timeline order", () => {
    const scopes = planAlignScopes(["a1", "b1"], STREAMS, { ...OPTS, loadedTakeId: "t2" });
    expect(scopes.map((s) => s.takeId)).toEqual(["t2", "t1"]);
  });

  it("yields nothing when the selection holds no alignable clip", () => {
    expect(planAlignScopes(["c1", "b2", "o1"], STREAMS, OPTS)).toEqual([]);
    expect(planAlignScopes(["ghost"], STREAMS, OPTS)).toEqual([]);
    expect(planAlignScopes([], STREAMS, OPTS)).toEqual([]);
  });
});

/** Scripted deps: every interaction is journaled for order assertions. */
function fakeDeps(overrides: Partial<AlignFlowDeps> = {}): {
  deps: AlignFlowDeps;
  log: string[];
} {
  const log: string[] = [];
  let loaded: string | null = "t1";
  const deps: AlignFlowDeps = {
    loadedTakeId: () => loaded,
    cancelled: () => false,
    runStep: (takeId, streamIds) => {
      log.push(`step:${takeId}:${streamIds.join("+")}`);
      loaded = takeId; // the queue load makes the step's take the loaded one
      return Promise.resolve("ok");
    },
    restore: (takeId) => {
      log.push(`restore:${takeId}`);
    },
    onProgress: (done, total) => {
      log.push(`progress:${done}/${total}`);
    },
    ...overrides,
  };
  return { deps, log };
}

const TWO_SCOPES = [
  { takeId: "t1", streamIds: ["a1"] },
  { takeId: "t2", streamIds: ["b1"] },
];

describe("runAlignFlow (W7-A)", () => {
  it("runs takes sequentially, reports progress, restores the original take", async () => {
    const { deps, log } = fakeDeps();
    expect(await runAlignFlow(TWO_SCOPES, deps)).toBe("ok");
    expect(log).toEqual([
      "progress:0/2",
      "step:t1:a1",
      "progress:1/2",
      "step:t2:b1",
      "progress:2/2",
      "restore:t1",
    ]);
  });

  it("skips the restore when the flow never left the loaded take", async () => {
    const { deps, log } = fakeDeps();
    expect(await runAlignFlow([{ takeId: "t1", streamIds: ["a1"] }], deps)).toBe("ok");
    expect(log.filter((l) => l.startsWith("restore"))).toEqual([]);
  });

  it("a superseded step aborts the WHOLE flow without restoring — latest wins", async () => {
    const { deps, log } = fakeDeps({
      runStep: (takeId) => {
        log.push(`step:${takeId}`);
        return Promise.resolve(takeId === "t1" ? "superseded" : "ok");
      },
    });
    expect(await runAlignFlow(TWO_SCOPES, deps)).toBe("cancelled");
    // Neither the second step nor the restore ran: the foreign request
    // that superseded us is the operator's newest intent.
    expect(log.filter((l) => l.startsWith("step"))).toEqual(["step:t1"]);
    expect(log.filter((l) => l.startsWith("restore"))).toEqual([]);
  });

  it("cancellation (recording / session switch) stops before the next step", async () => {
    let steps = 0;
    const { deps, log } = fakeDeps({
      cancelled: () => steps >= 1,
      runStep: (takeId) => {
        steps += 1;
        log.push(`step:${takeId}`);
        return Promise.resolve("ok");
      },
    });
    expect(await runAlignFlow(TWO_SCOPES, deps)).toBe("cancelled");
    expect(log.filter((l) => l.startsWith("step"))).toEqual(["step:t1"]);
    expect(log.filter((l) => l.startsWith("restore"))).toEqual([]);
  });

  it("a FAILED step reports and moves on — one broken take never holds the rest", async () => {
    const { deps, log } = fakeDeps({
      runStep: (takeId) => {
        log.push(`step:${takeId}`);
        return Promise.resolve(takeId === "t1" ? "failed" : "ok");
      },
    });
    expect(await runAlignFlow(TWO_SCOPES, deps)).toBe("ok");
    expect(log.filter((l) => l.startsWith("step"))).toEqual(["step:t1", "step:t2"]);
  });
});
