// QA MAJOR-1 regression (W5-A): a collab attach landing during
// CollabHub.close() must get a clean rejection, and close() must still
// complete. The first cut of close() marked rooms evicted while leaving
// them resident in the maps through the flushes; attachRoom's then-
// unbounded for(;;) re-awaited the same cached promise forever — a
// microtask-only spin that starved every timer (including the flush's own
// resolution and the 10 s shutdown watchdog) and hung the process until
// SIGKILL. Stub Db with timer-resolved queries so the race windows are
// real and controllable; no Postgres needed.

import type { WSContext } from "hono/ws";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CollabHub, frame, MSG_UPDATE } from "../src/collab/index.ts";
import type { Db } from "../src/db/index.ts";

/** The two shapes CollabHub actually uses: a select chain resolving to rows
 * and an insert…onConflictDoUpdate chain resolving after a delay — the
 * delay IS the shutdown flush window the regression needs to hold open. */
function stubDb(delays: { selectMs?: number; insertMs?: number } = {}) {
  const calls = { selects: 0, inserts: 0 };
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const db = {
    select: () => ({
      from: () => ({
        where: async () => {
          calls.selects++;
          await wait(delays.selectMs ?? 0);
          return [];
        },
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: async () => {
          calls.inserts++;
          await wait(delays.insertMs ?? 0);
        },
      }),
    }),
  };
  return { db: db as unknown as Db, calls };
}

function fakeWs() {
  const state = { closed: false };
  const ws = {
    send: () => {},
    close: () => {
      state.closed = true;
    },
  } as unknown as WSContext;
  return { ws, state };
}

const OPTIONS = { msgRatePerSec: 1_000, msgBurst: 1_000, idleEvictMs: 900_000 };

function dirtyUpdate(): ArrayBuffer {
  const doc = new Y.Doc();
  doc.getMap("mix").set("lane-1", -6);
  const framed = frame(MSG_UPDATE, Y.encodeStateAsUpdate(doc));
  return framed.buffer;
}

async function until(cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("collab hub shutdown vs late attach (QA MAJOR-1)", () => {
  it("close() completes while an attach lands mid-flush; the late socket is refused", async () => {
    const { db, calls } = stubDb({ insertMs: 80 });
    const hub = new CollabHub(db, OPTIONS);
    const sessionId = crypto.randomUUID();

    // Desk attaches and dirties the doc so close() has a real flush to await.
    const first = hub.handleConnection(sessionId);
    const a = fakeWs();
    first.onOpen(a.ws);
    await until(() => hub.hasLiveRoom(sessionId), "room resident");
    first.onMessage(dirtyUpdate(), a.ws);
    // onMessage dispatch is fire-and-forget (microtasks); one macrotask
    // guarantees the update applied and the room is dirty before shutdown.
    await new Promise((r) => setTimeout(r, 0));

    // Shutdown starts (flush in flight for ≥80 ms); a second desk attaches
    // inside that window. Old code: infinite microtask spin — the canary
    // timer below could never fire and close() never resolved.
    const closed = hub.close();
    const second = hub.handleConnection(sessionId);
    const b = fakeWs();
    second.onOpen(b.ws);

    let canary = false;
    const canaryTimer = setTimeout(() => {
      canary = true;
    }, 20);

    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("close() did not complete — shutdown deadlock")), 5_000),
      ),
    ]);
    clearTimeout(canaryTimer);

    expect(canary).toBe(true); // timers ran during close(): no starvation
    expect(calls.inserts).toBe(1); // the dirty doc was flushed, not dropped
    expect(hub.hasLiveRoom(sessionId)).toBe(false);
    await until(() => b.state.closed, "late socket refused"); // clean rejection, not a zombie room
  });

  it("a room load in flight when close() runs cannot resurrect a resident room", async () => {
    const { db } = stubDb({ selectMs: 80 });
    const hub = new CollabHub(db, OPTIONS);
    const sessionId = crypto.randomUUID();

    // Attach starts: getRoom's Postgres load is in flight (80 ms)…
    const first = hub.handleConnection(sessionId);
    const a = fakeWs();
    first.onOpen(a.ws);

    // …and shutdown wins the race. The load must self-reject instead of
    // registering a zombie room in the maps close() just vacated.
    await hub.close();
    await until(() => a.state.closed, "in-flight attach refused");
    expect(hub.hasLiveRoom(sessionId)).toBe(false);

    // And attaches after shutdown are refused outright by the guard.
    const late = hub.handleConnection(sessionId);
    const b = fakeWs();
    late.onOpen(b.ws);
    await until(() => b.state.closed, "post-shutdown attach refused");
    expect(hub.hasLiveRoom(sessionId)).toBe(false);
  });
});
