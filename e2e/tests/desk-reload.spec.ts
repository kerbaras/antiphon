// Desk reload mid-session (RFC §8 crash recovery, sink flavor).
//
// A desk that reloads is a sink restarting: it must rescan its durable
// store (OPFS), rebuild receiver state "as if it had merely been
// disconnected", and end up byte-identical with the server archive — takes
// and streams listed, clips visible, take loaded into the player. A NEW
// take recorded after the reload (through the re-established links) must
// converge end-to-end exactly like the first.

import { expect, test } from "@playwright/test";
import {
  type DeskStreamStatus,
  deskState,
  expectTakeConverged,
  expectValidFlac,
  joinAsRecorder,
  recorderState,
  serverSessionTakeIds,
  startTake,
  stopTake,
} from "./helpers/session";

test.describe("desk reload", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("desk rebuilds its archive view after a reload and records a new take", async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phone = await (await browser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId);
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

    // --- take 1: record to convergence -------------------------------------
    const take1 = await startTake(desk);
    await expect(phone.getByText("recording", { exact: true })).toBeVisible({ timeout: 15_000 });
    await desk.waitForTimeout(2_500);
    await stopTake(desk);
    const converged1 = await expectTakeConverged(desk, sessionId, take1, 1);
    const take1Stream = converged1.deskStreams[0] as DeskStreamStatus;

    // --- reload the desk page ------------------------------------------------
    await desk.reload();
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    // The sink worker rescanned OPFS and rebuilt state (RFC §8): the desk
    // reports recovered chunks and the stream reappears complete with the
    // exact same digest — no re-transfer, no loss.
    await expect
      .poll(async () => (await deskState(desk))?.rebuiltChunks ?? 0, { timeout: 20_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(
        async () => {
          const streams = ((await deskState(desk))?.deskStatus ?? []).filter(
            (s) => s.takeId === take1,
          );
          const s = streams[0];
          if (!s) return "no stream";
          return `complete=${s.complete} digest=${s.digest === take1Stream.digest}`;
        },
        { timeout: 20_000 },
      )
      .toBe("complete=true digest=true");

    // The server archive still lists the take, and both sinks agree.
    expect(await serverSessionTakeIds(desk, sessionId)).toContain(take1);
    await expectTakeConverged(desk, sessionId, take1, 1, { timeoutMs: 15_000 });

    // The rebuilt take is visible on the timeline and loaded into the
    // player (playable state), straight from the desk's own store.
    await expect(desk.getByRole("button", { name: "Select Take 1" })).toBeVisible({
      timeout: 15_000,
    });
    await expect
      .poll(
        async () =>
          await desk.evaluate(() => {
            const hook = (
              globalThis as unknown as {
                __antiphonDesk?: {
                  playerSnapshot(): {
                    loadedTakeId: string | null;
                    tracks: unknown[];
                    durationSec: number;
                  } | null;
                };
              }
            ).__antiphonDesk;
            const snap = hook?.playerSnapshot();
            if (!snap) return "no player";
            return `take=${snap.loadedTakeId?.slice(0, 8)} tracks=${snap.tracks.length} dur=${
              snap.durationSec > 0
            }`;
          }),
        { timeout: 20_000 },
      )
      .toBe(`take=${take1.slice(0, 8)} tracks=1 dur=true`);

    // The phone re-links to the reloaded desk (fresh desk peer id) — both
    // the control-plane roster and the P2P data leg come back.
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => (await recorderState(phone))?.deskLink ?? "down", { timeout: 30_000 })
      .toBe("connected");

    // --- take 2 after the reload works end-to-end ---------------------------
    // (Longer than take 1 on purpose: equal-length consecutive takes trip
    // the stream-final dedup bug documented in multi-take.spec.ts.)
    const take2 = await startTake(desk);
    expect(take2).not.toBe(take1);
    await expect(phone.getByText("recording", { exact: true })).toBeVisible({ timeout: 15_000 });
    await desk.waitForTimeout(4_000);
    await stopTake(desk);
    const converged2 = await expectTakeConverged(desk, sessionId, take2, 1);
    for (const stream of converged2.deskStreams) {
      await expectValidFlac(desk, stream.streamId);
    }

    // Take 1 was untouched by the whole excursion.
    const finalTake1 = await expectTakeConverged(desk, sessionId, take1, 1, {
      timeoutMs: 15_000,
    });
    expect((finalTake1.deskStreams[0] as DeskStreamStatus).digest).toBe(take1Stream.digest);

    await phone.close();
    await desk.close();
  });
});
