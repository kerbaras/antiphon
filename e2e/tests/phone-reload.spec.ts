// Recorder mid-take reload (RFC amendment A6).
//
// A phone page reload loses the in-memory ring; resuming the same stream
// id would leave an unfillable hole and restart the sample domain. A6:
// rejoining mid-take arms a FRESH stream id for the remainder; the
// truncated original stream's bytes are preserved server-side and remain
// incomplete (it never receives a stream-final), while the new stream
// converges normally at take stop.

import { expect, test } from "@playwright/test";
import {
  deskStatus,
  expectTakeConverged,
  expectValidFlac,
  joinAsRecorder,
  recorderState,
  type ServerStreamStatus,
  serverTakeStreams,
  startTake,
  stopTake,
} from "./helpers/session";

test.describe("phone reload mid-take", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  // Regression: on a mid-take rejoin the welcome (one WS round-trip)
  // reliably beats the encoder worker's wasm boot, and CaptureController.arm
  // used to THROW "capture pipeline not ready" with nothing retrying — the
  // phone stayed "ready" forever while the capture ring overflowed. Arming
  // now gates on pipeline readiness (the intent is queued and fires on the
  // worker's ready), so the same journey works with NO signaling gate.
  test("rejoin arms even when the welcome beats the encoder worker boot", async ({ browser }) => {
    test.setTimeout(120_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phone = await (await browser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId);
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

    const takeId = await startTake(desk);
    await expect(phone.getByText("recording", { exact: true })).toBeVisible({ timeout: 15_000 });
    const oldStreamId = (await recorderState(phone))?.streamId as string;
    await desk.waitForTimeout(2_000);

    // Reload mid-take and re-enable the mic immediately — the welcome
    // races (and beats) the worker boot, exactly the path that used to
    // throw and leave the recorder idle.
    const pageErrors: string[] = [];
    phone.on("pageerror", (e) => pageErrors.push(String(e)));
    await phone.reload();
    await phone.getByRole("button", { name: /enable microphone/i }).click();
    await expect(phone.getByText("recording", { exact: true })).toBeVisible({ timeout: 15_000 });
    expect(pageErrors.filter((e) => e.includes("capture pipeline not ready"))).toEqual([]);

    // A6: same take, FRESH stream — and the queued arm really captures:
    // the new stream converges once the take stops.
    const state = await recorderState(phone);
    expect(state?.activeTakeId).toBe(takeId);
    const newStreamId = state?.streamId as string;
    expect(newStreamId).toBeTruthy();
    expect(newStreamId).not.toBe(oldStreamId);

    await desk.waitForTimeout(1_500);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, takeId, 1, { onlyStreamIds: [newStreamId] });

    await phone.close();
    await desk.close();
  });

  test("re-join arms a new stream; the truncated stream is preserved and flagged incomplete", async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phone = await (await browser.newContext()).newPage();

    // Gate for server→phone signaling: while held, welcome/fanout messages
    // queue instead of delivering — indistinguishable from control-plane
    // latency. This pins the OTHER ordering (pipeline up before the welcome
    // lands); the welcome-first race has its own test above.
    let held = false;
    const gates: Array<() => void> = [];
    await phone.routeWebSocket(/\/join\/[^/]+\/ws$/, (ws) => {
      const server = ws.connectToServer();
      const queue: Array<string | Buffer> = [];
      ws.onMessage((message) => server.send(message));
      server.onMessage((message) => {
        if (held) queue.push(message);
        else ws.send(message);
      });
      gates.push(() => {
        for (const message of queue.splice(0)) ws.send(message);
      });
    });

    await joinAsRecorder(phone, sessionId);
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

    // --- take starts; the phone streams for a bit --------------------------
    const takeId = await startTake(desk);
    await expect(phone.getByText("recording", { exact: true })).toBeVisible({ timeout: 15_000 });
    const oldStreamId = (await recorderState(phone))?.streamId as string;
    expect(oldStreamId).toBeTruthy();

    // Let real audio land in the archive before pulling the rug.
    await expect
      .poll(
        async () =>
          (await serverTakeStreams(desk, sessionId, takeId)).find((s) => s.streamId === oldStreamId)
            ?.chunkCount ?? 0,
        { timeout: 20_000 },
      )
      .toBeGreaterThanOrEqual(4);
    const truncatedChunksBefore = (await serverTakeStreams(desk, sessionId, takeId)).find(
      (s) => s.streamId === oldStreamId,
    )?.chunkCount as number;

    // --- reload the phone mid-take and re-join ------------------------------
    // Hold server→phone signaling until the capture pipeline reports
    // ready, then release the queued welcome.
    held = true;
    await phone.reload();
    await phone.getByRole("button", { name: /enable microphone/i }).click();
    await expect
      .poll(
        async () =>
          await phone.evaluate(() => {
            const hook = (globalThis as unknown as { __antiphon?: { controller: unknown } })
              .__antiphon;
            const controller = hook?.controller as { workerReady?: boolean } | undefined;
            return controller?.workerReady === true;
          }),
        { timeout: 20_000 },
      )
      .toBe(true);
    held = false;
    for (const flush of gates) flush();
    await expect(phone.getByText("server sink")).toBeVisible();
    await expect
      .poll(async () => (await recorderState(phone))?.serverLink ?? "down", { timeout: 20_000 })
      .toBe("connected");

    // A6: the welcome carries the active take; the recorder arms a FRESH
    // stream id for the remainder — same take, new stream, capturing.
    await expect
      .poll(
        async () => {
          const state = await recorderState(phone);
          if (!state?.streamId) return "no stream";
          return `take=${state.activeTakeId === takeId} fresh=${state.streamId !== oldStreamId}`;
        },
        { timeout: 20_000 },
      )
      .toBe("take=true fresh=true");
    await expect(phone.getByText("recording", { exact: true })).toBeVisible({ timeout: 15_000 });
    const newStreamId = (await recorderState(phone))?.streamId as string;

    // Record the remainder, then stop the take from the desk.
    await desk.waitForTimeout(2_500);
    await stopTake(desk);

    // --- the NEW stream converges normally (M1 invariants) ------------------
    const converged = await expectTakeConverged(desk, sessionId, takeId, 1, {
      onlyStreamIds: [newStreamId],
    });
    await expectValidFlac(desk, newStreamId);
    expect(converged.serverStreams[0]?.finalSeq).not.toBeNull();

    // --- the truncated stream: preserved, incomplete, no stream-final -------
    const truncated = (await serverTakeStreams(desk, sessionId, takeId)).find(
      (s) => s.streamId === oldStreamId,
    ) as ServerStreamStatus;
    expect(truncated, "truncated stream still archived").toBeDefined();
    // Bytes preserved: nothing was deleted by the reload.
    expect(truncated.chunkCount).toBeGreaterThanOrEqual(truncatedChunksBefore);
    // Flagged incomplete in take metadata: it never received a
    // stream-final, so completeness is undecidable-by-design (A2/A6).
    expect(truncated.finalSeq).toBeNull();
    expect(truncated.complete).toBe(false);
    expect(truncated.settled).toBe(false);

    // The archive refuses to serve it as a complete .flac (never lie about
    // audio) but serves the preserved bytes when partial is requested.
    const full = await desk.request.get(`/api/streams/${oldStreamId}/flac`);
    expect(full.status()).toBe(409);
    await expectValidFlac(desk, oldStreamId, { partial: true });

    // Sink↔sink reconciliation (§6.8) still covers the truncated stream:
    // desk and server converge on an identical copy of what was captured.
    await expect
      .poll(
        async () => {
          const d = (await deskStatus(desk)).find((s) => s.streamId === oldStreamId);
          const s = (await serverTakeStreams(desk, sessionId, takeId)).find(
            (x) => x.streamId === oldStreamId,
          );
          if (!d || !s) return "missing";
          return `held=${d.heldCount === s.chunkCount} digest=${d.digest === s.digest}`;
        },
        { timeout: 30_000, intervals: [1_000] },
      )
      .toBe("held=true digest=true");
    // ...and the desk agrees it is incomplete (no final seq ever arrived).
    const deskTruncated = (await deskStatus(desk)).find((s) => s.streamId === oldStreamId);
    expect(deskTruncated?.finalSeq ?? null).toBeNull();
    expect(deskTruncated?.complete).toBe(false);

    // Exactly two streams belong to the take: the truncated one and the
    // fresh one. The reload forked the stream, not the take.
    const all = await serverTakeStreams(desk, sessionId, takeId);
    expect(all.map((s) => s.streamId).sort()).toEqual([oldStreamId, newStreamId].sort());

    await phone.close();
    await desk.close();
  });
});
