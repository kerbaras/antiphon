// Server kill/restart mid-take (RFC §7.1 + §8), end to end.
//
// The playwright webServer owns the suite's shared server, so this journey
// spawns a DEDICATED server instance (own port + blob root, same Postgres)
// behind a same-origin proxy (the web app hardcodes same-origin /api + WS).
// Mid-take the server process is SIGKILLed — a crash, not a shutdown.
// Capture must never gate on the network (§7.1): the phone keeps encoding
// into its ring. On restart the server rebuilds its SinkEngine from the
// archive (apps/server/src/ingest/index.ts init: "rejoins its own archive
// as if it had merely been disconnected"), the recorder reconnects and
// backfills the downtime from its ring, and the take converges at both
// sinks with zero holes, zero gaps, zero drops.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  freePort,
  type SameOriginProxy,
  type ServerProcess,
  startDedicatedServer,
  startSameOriginProxy,
} from "./helpers/dedicated-server";
import {
  deskState,
  expectTakeConverged,
  expectValidFlac,
  joinAsRecorder,
  recorderSamples,
  recorderState,
  type ServerStreamStatus,
  startTake,
} from "./helpers/session";

/** Vite preview port from playwright.config.ts (baseURL). */
const WEB_PREVIEW_PORT = 4173;

/** Poll the dedicated server directly (test-runner fetch): resilient to
 * the server being down mid-poll. */
async function takeStreamsDirect(
  apiPort: number,
  sessionId: string,
  takeId: string,
): Promise<ServerStreamStatus[]> {
  try {
    const res = await fetch(
      `http://127.0.0.1:${apiPort}/api/sessions/${sessionId}/takes/${takeId}`,
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { streams: ServerStreamStatus[] };
    return body.streams;
  } catch {
    return [];
  }
}

async function recorderDiagnostics(
  page: Page,
): Promise<{ gaps: Array<[number, number]>; droppedSamples: number }> {
  return await page.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphon?: {
          snapshot(): {
            stats: { gaps: Array<[number, number]> } | null;
            ring: { droppedSamples: number } | null;
          } | null;
        };
      }
    ).__antiphon;
    const snap = hook?.snapshot();
    return {
      gaps: snap?.stats?.gaps ?? [],
      droppedSamples: snap?.ring?.droppedSamples ?? 0,
    };
  });
}

test.describe("server restart mid-take", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  // BUG found while writing this journey (workaround below: the main test
  // re-sends take-stop over the desk's raw signaling channel).
  //
  // DeskSession's "welcome" handler trusts the server's session snapshot
  // unconditionally (apps/web/src/net/desk-session.ts ~line 230:
  // `this.patch({ activeTakeId: msg.session.activeTake?.takeId ?? null })`).
  // Room state is in-memory (apps/server/src/signaling/index.ts), so a
  // restarted server welcomes the reconnecting desk with activeTake=null —
  // the desk silently flips to "not recording" while every recorder keeps
  // rolling (recorders correctly ignore a null activeTake and keep their
  // local take, per never-lose-audio). Consequences: the desk's Stop-take
  // button disables, DeskSession.stopTake() no-ops, and the operator
  // cannot end the still-rolling take from the UI; worse, Record-take
  // re-enables mid-take. Expected per RFC §3 ("The desk is ... the
  // session's control authority") and §7: the desk's own take state must
  // survive a server restart — keep activeTakeId when a reconnect welcome
  // carries no active take (or re-assert take-start to the reborn room).
  test.fixme("desk keeps control of the rolling take across a server restart", async () => {
    // Expected flow once fixed: kill+restart the server mid-take, wait for
    // the desk's signaling to reconnect, and assert the desk still reports
    // the take as active with the Stop-take button enabled:
    //   expect((await deskState(desk))?.activeTakeId).toBe(takeId);
    //   await expect(desk.getByRole("button", { name: "Stop take" })).toBeEnabled();
  });

  test("recorder ring backfill + archive rebuild converge the take", async ({ browser }) => {
    test.setTimeout(240_000);
    const sessionId = crypto.randomUUID();

    const apiPort = await freePort();
    const blobRoot = await mkdtemp(path.join(os.tmpdir(), "antiphon-restart-blobs-"));
    let server: ServerProcess | null = null;
    let proxy: SameOriginProxy | null = null;

    try {
      server = await startDedicatedServer({ port: apiPort, blobRoot });
      proxy = await startSameOriginProxy(WEB_PREVIEW_PORT, apiPort);
      const origin = proxy.origin;

      const desk = await (await browser.newContext()).newPage();
      await desk.goto(`${origin}/session/${sessionId}`);
      await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

      const phone = await (await browser.newContext()).newPage();
      await joinAsRecorder(phone, sessionId, origin);
      await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

      // --- take starts; audio lands in the dedicated archive ----------------
      const takeId = await startTake(desk);
      await expect(phone.getByText("recording", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      const streamId = (await recorderState(phone))?.streamId as string;
      await expect
        .poll(
          async () =>
            (await takeStreamsDirect(apiPort, sessionId, takeId)).find(
              (s) => s.streamId === streamId,
            )?.chunkCount ?? 0,
          { timeout: 20_000 },
        )
        .toBeGreaterThanOrEqual(4);
      const chunksAtKill = (await takeStreamsDirect(apiPort, sessionId, takeId)).find(
        (s) => s.streamId === streamId,
      )?.chunkCount as number;

      // --- CRASH: SIGKILL the server mid-take --------------------------------
      const samplesBefore = await recorderSamples(phone);
      await server.kill();
      server = null;

      // §7.1: capture NEVER gates on the network — samples keep flowing
      // while the archive is a corpse (the phone's WS is down too).
      await expect
        .poll(async () => (await recorderState(phone))?.signalingConnected ?? true, {
          timeout: 15_000,
        })
        .toBe(false);
      await phone.waitForTimeout(3_000);
      expect(await recorderSamples(phone)).toBeGreaterThan(samplesBefore + 48_000);

      // --- RESTART on the same port, same blob root, same database ----------
      server = await startDedicatedServer({ port: apiPort, blobRoot });

      // Crash recovery (RFC §8): the reborn ingest rebuilds its SinkEngine
      // from the archive before any peer reconnects — it already "holds"
      // every persisted chunk.
      interface IngestStreamStatus {
        streamId: string;
        heldCount: number;
      }
      const ingestRes = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${sessionId}/ingest`);
      expect(ingestRes.ok).toBe(true);
      const rebuilt = ((await ingestRes.json()) as IngestStreamStatus[]).find(
        (s) => s.streamId === streamId,
      );
      expect(rebuilt, "ingest engine rebuilt from the archive").toBeDefined();
      expect((rebuilt as IngestStreamStatus).heldCount).toBeGreaterThanOrEqual(chunksAtKill);

      // The phone reconnects (signaling backoff, then the data leg once the
      // dead PeerConnection is noticed) and resumes live + ring backfill.
      await expect
        .poll(async () => (await recorderState(phone))?.serverLink ?? "down", {
          timeout: 90_000,
          intervals: [1_000],
        })
        .toBe("connected");
      await expect
        .poll(
          async () =>
            (await takeStreamsDirect(apiPort, sessionId, takeId)).find(
              (s) => s.streamId === streamId,
            )?.chunkCount ?? 0,
          { timeout: 60_000, intervals: [1_000] },
        )
        .toBeGreaterThan(chunksAtKill);

      // --- stop the take ------------------------------------------------------
      // The desk lost its activeTakeId to the reconnect welcome (see the
      // fixme above), so the Stop-take UI path is dead; end the take by
      // re-sending the control message the button would have sent.
      await expect
        .poll(async () => (await deskState(desk))?.signalingConnected ?? false, {
          timeout: 30_000,
        })
        .toBe(true);
      await desk.evaluate((id) => {
        const hook = (
          globalThis as unknown as {
            __antiphonDesk?: { session: unknown };
          }
        ).__antiphonDesk;
        const session = hook?.session as { signaling: { send(msg: unknown): void } };
        session.signaling.send({ v: 1, type: "take-stop", takeId: id });
      }, takeId);

      // --- convergence: both sinks identical and complete ---------------------
      // The desk leg (direct P2P) never died, and the server backfilled the
      // downtime from the phone's ring: seq 0..=final everywhere, zero
      // holes, zero gaps, digest-equal.
      const converged = await expectTakeConverged(desk, sessionId, takeId, 1, {
        origin,
        timeoutMs: 90_000,
      });
      expect(converged.serverStreams[0]?.chunkCount as number).toBeGreaterThan(chunksAtKill);
      await expectValidFlac(desk, streamId, { origin });

      // The ring absorbed the outage without loss: no declared gaps, no
      // dropped samples (§9 — "there is no excuse for a small ring").
      const diagnostics = await recorderDiagnostics(phone);
      expect(diagnostics.gaps).toEqual([]);
      expect(diagnostics.droppedSamples).toBe(0);

      await phone.close();
      await desk.close();
    } finally {
      await server?.kill();
      await proxy?.close();
      await rm(blobRoot, { recursive: true, force: true });
    }
  });
});
