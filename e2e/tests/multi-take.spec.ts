// Multi-take session lifecycle (RFC §7 + amendment A9).
//
// One desk, two phones, three consecutive short takes: every take must
// converge at both sinks (complete sets, digest-equal, valid FLAC per
// stream). Then the desk deletes take 2's streams: the server must refuse
// while a take is active (A9 ordering), and once idle must remove rows AND
// blobs durably before fanning out the confirm — after which the desk's
// state drops the streams while takes 1 and 3 stay byte-identical.

import { expect, type Page, test } from "@playwright/test";
import { countBlobFiles, findTakeBlobDir } from "./helpers/blobs";
import {
  type DeskStreamStatus,
  deskState,
  deskStatus,
  expectTakeConverged,
  expectValidFlac,
  joinAsRecorder,
  serverSessionTakeIds,
  startTake,
  stopTake,
} from "./helpers/session";

/** Ask the desk (via its session hook) to delete streams — the same
 * DeskSession.deleteStreams the Delete-key UI path calls. */
async function deleteStreams(
  desk: Page,
  refs: Array<{ takeId: string; streamId: string }>,
): Promise<void> {
  await desk.evaluate((streamRefs) => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: {
          session: { deleteStreams(refs: Array<{ takeId: string; streamId: string }>): void };
        };
      }
    ).__antiphonDesk;
    hook?.session.deleteStreams(streamRefs);
  }, refs);
}

/** Per-take record durations for the 3-take journey; the equal-length
 * regression case gets its own test below. */
const TAKE_DURATIONS_MS = [2_000, 3_500, 5_000] as const;

test.describe("multi-take session", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  // Regression: two consecutive takes with the SAME final seq (equal-length
  // takes — the ordinary "record 3 verses of the same song" case) used to
  // leave take 2 forever syncing: use-capture.ts deduped stream-final on a
  // bare seq number, so take 2's final (equal to take 1's) was never sent
  // and completeness stayed undecidable sink-side (A2). The dedup is now
  // keyed per (takeId, streamId, finalSeq).
  test("equal-length consecutive takes both converge", async ({ browser }) => {
    test.setTimeout(120_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phone = await (await browser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId);
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

    for (let i = 0; i < 2; i++) {
      const takeId = await startTake(desk);
      await expect(phone.getByText("recording", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      // IDENTICAL durations on purpose: identical final seqs.
      await desk.waitForTimeout(2_500);
      await stopTake(desk);
      const { deskStreams } = await expectTakeConverged(desk, sessionId, takeId, 1);
      await expectValidFlac(desk, (deskStreams[0] as DeskStreamStatus).streamId);
    }

    await phone.close();
    await desk.close();
  });

  test("three takes converge; deleting take 2 removes rows and blobs, sparing takes 1 and 3", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phoneA = await (await browser.newContext()).newPage();
    const phoneB = await (await browser.newContext()).newPage();
    await joinAsRecorder(phoneA, sessionId);
    await joinAsRecorder(phoneB, sessionId);
    await expect(desk.getByText("2 phones connected")).toBeVisible({ timeout: 15_000 });

    // --- three consecutive short takes, each converging at both sinks ------
    const takeIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const takeId = await startTake(desk);
      takeIds.push(takeId);
      await expect(phoneA.getByText("recording", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(phoneB.getByText("recording", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await desk.waitForTimeout(TAKE_DURATIONS_MS[i] as number);

      if (i === 2) {
        // A9: deletion of the ACTIVE take's streams must be refused —
        // inbound chunks would resurrect half a stream mid-delete.
        await expect
          .poll(
            async () =>
              ((await deskState(desk))?.streams ?? []).filter((s) => s.takeId === takeId).length,
            { timeout: 15_000 },
          )
          .toBe(2);
        const activeRefs = ((await deskState(desk))?.streams ?? [])
          .filter((s) => s.takeId === takeId)
          .map((s) => ({ takeId: s.takeId, streamId: s.streamId }));
        await deleteStreams(desk, activeRefs);
        await expect
          .poll(async () => ((await deskState(desk))?.errors ?? []).join("\n"), {
            timeout: 10_000,
          })
          .toContain("take-active");
      }

      await stopTake(desk);
      const { deskStreams } = await expectTakeConverged(desk, sessionId, takeId, 2);
      for (const stream of deskStreams) {
        await expectValidFlac(desk, stream.streamId);
      }
    }
    const [take1, take2, take3] = takeIds as [string, string, string];

    // The refused mid-take delete really deleted nothing: take 3 converged
    // above, and all three takes are still archived.
    expect(await serverSessionTakeIds(desk, sessionId)).toEqual(
      expect.arrayContaining([take1, take2, take3]),
    );

    // --- snapshot pre-deletion state ---------------------------------------
    const before = await deskStatus(desk);
    expect(before).toHaveLength(6);
    const keepDigests = new Map(
      before.filter((s) => s.takeId !== take2).map((s) => [s.streamId, s.digest]),
    );
    const take2Refs = before
      .filter((s) => s.takeId === take2)
      .map((s) => ({ takeId: s.takeId, streamId: s.streamId }));
    expect(take2Refs).toHaveLength(2);

    // Locate the server's fs blob store through a take we know is archived.
    const take1BlobDir = await findTakeBlobDir(take1);
    expect(take1BlobDir, "take 1 blobs on disk").not.toBeNull();
    const take2BlobDir = (take1BlobDir as string).replace(take1, take2);
    expect(await countBlobFiles(take2BlobDir)).toBeGreaterThan(0);

    // --- delete take 2's streams (desk decision, server-authoritative) -----
    await deleteStreams(desk, take2Refs);

    // Desk drops its copies only on the server's streams-deleted confirm.
    await expect
      .poll(
        async () => {
          const streams = await deskStatus(desk);
          return `count=${streams.length} take2=${streams.filter((s) => s.takeId === take2).length}`;
        },
        { timeout: 15_000 },
      )
      .toBe("count=4 take2=0");
    // ...including the announce metadata (state.streams) — desk state is
    // consistent, not just the sink store.
    const announces = (await deskState(desk))?.streams ?? [];
    expect(announces.filter((s) => s.takeId === take2)).toEqual([]);

    // Server rows gone: the take lost its last stream, so the take row is
    // deleted too (the session-scoped summary 404s) and the streams no
    // longer reconstruct.
    const gone = await desk.request.get(`/api/sessions/${sessionId}/takes/${take2}`);
    expect(gone.status()).toBe(404);
    await expect
      .poll(async () => await serverSessionTakeIds(desk, sessionId), { timeout: 10_000 })
      .not.toContain(take2);
    for (const ref of take2Refs) {
      const res = await desk.request.get(`/api/streams/${ref.streamId}/flac`);
      expect(res.status()).toBe(409);
    }

    // Server blobs gone (durably deleted BEFORE the confirm fanned out).
    await expect.poll(async () => await countBlobFiles(take2BlobDir), { timeout: 10_000 }).toBe(0);

    // Takes 1 and 3 untouched: still complete, digest-identical at both
    // sinks, byte-for-byte the same digests as before the deletion.
    for (const takeId of [take1, take3]) {
      const { deskStreams, serverStreams } = await expectTakeConverged(desk, sessionId, takeId, 2, {
        timeoutMs: 15_000,
      });
      for (const stream of deskStreams) {
        expect(stream.digest).toBe(keepDigests.get(stream.streamId));
      }
      for (const stream of serverStreams) {
        expect(stream.digest).toBe(keepDigests.get(stream.streamId));
        await expectValidFlac(desk, stream.streamId);
      }
    }

    await phoneA.close();
    await phoneB.close();
    await desk.close();
  });
});
