// F5 — rapid take switching must never strand the player. A take pick
// landing while another take is still decoding used to be dropped with no
// retry (player.load's `loading` guard), leaving transport/exports/panels
// inert on the selected take until a manual reload. Loads now run through
// a latest-wins queue: two Select-Take picks ~100 ms apart always converge
// the player onto the SECOND one. (Double-click is the explicit load
// action — plain selection no longer switches takes, QA E3.)

import { expect, type Page, test } from "@playwright/test";
import {
  type DeskStreamStatus,
  expectTakeConverged,
  joinAsRecorder,
  startTake,
  stopTake,
} from "./helpers/session";

async function loadedTake(desk: Page): Promise<{ takeId: string | null; error: string | null }> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: {
          playerSnapshot(): {
            loadedTakeId: string | null;
            loading: boolean;
            error: string | null;
          } | null;
          ui(): { selectedTakeId: string | null } | null;
        };
      }
    ).__antiphonDesk;
    const snap = hook?.playerSnapshot();
    return { takeId: snap?.loadedTakeId ?? null, error: snap?.error ?? null };
  });
}

test.describe("rapid take switching (F5)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("two take picks ~100ms apart converge the player on the second", async ({ browser }) => {
    test.setTimeout(150_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phone = await (await browser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId);
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

    // Two takes; the first is longer so its decode occupies the player
    // when the second pick lands (the QA repro window).
    const streamOf: Record<string, string> = {};
    const takeIds: string[] = [];
    for (const durationMs of [5_000, 2_500]) {
      const takeId = await startTake(desk);
      takeIds.push(takeId);
      await expect(phone.getByText("recording", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await desk.waitForTimeout(durationMs);
      await stopTake(desk);
      const { deskStreams } = await expectTakeConverged(desk, sessionId, takeId, 1);
      streamOf[takeId] = (deskStreams[0] as DeskStreamStatus).streamId;
    }
    const [take1, take2] = takeIds as [string, string];

    // The latest complete take auto-loads.
    await expect.poll(async () => (await loadedTake(desk)).takeId, { timeout: 30_000 }).toBe(take2);

    // --- the F5 repro: pick take 1, then take 2 ~100 ms later ---------------
    // Old behavior: take 1's load is in flight, take 2's is dropped on the
    // floor — the player parks on take 1 while the UI says take 2.
    await desk.locator(`[data-clip="${streamOf[take1]}"]`).dblclick();
    await desk.waitForTimeout(100);
    await desk.locator(`[data-clip="${streamOf[take2]}"]`).dblclick();
    await expect.poll(async () => (await loadedTake(desk)).takeId, { timeout: 30_000 }).toBe(take2);

    // And the reverse pair converges on take 1 — no sticky ordering.
    await desk.locator(`[data-clip="${streamOf[take2]}"]`).dblclick();
    await desk.waitForTimeout(100);
    await desk.locator(`[data-clip="${streamOf[take1]}"]`).dblclick();
    await expect.poll(async () => (await loadedTake(desk)).takeId, { timeout: 30_000 }).toBe(take1);

    // The player is genuinely usable on the converged pick, not stranded.
    await expect(desk.getByRole("button", { name: "Play", exact: true })).toBeEnabled();

    await phone.close();
    await desk.close();
  });
});
