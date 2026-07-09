// F12 regression — end-of-take auto-stop must not desync UI vs engine.
// W6-B promoted the rule to end-of-SESSION with the transport scope: with
// this spec's single take, the session end IS the take's end (plus its
// +1 s arrangement base), and "restart from the top" means session zero —
// the assertions below hold under both readings, by construction.
//
// One phone records a short take; once it converges and auto-loads, Play
// runs it to the end. The meter loop's auto-stop must leave the desk UI
// (last notified snapshot — what the timecode renders) and the engine
// (`position()`) agreeing: both parked AT the session end, exactly like a
// user pause on the last frame. Pressing Play from that parked end then
// restarts from the top (play()'s own return-to-start guard) with a live
// meter loop — the playhead visibly advances again.

import { expect, type Page, test } from "@playwright/test";
import { expectTakeConverged, joinAsRecorder, startTake, stopTake } from "./helpers/session";

interface TransportView {
  loadedTakeId: string | null;
  playing: boolean;
  enginePositionSec: number;
  durationSec: number;
  /** positionSec of the last snapshot the player NOTIFIED (UI truth). */
  uiPositionSec: number;
}

interface PlayerHook {
  __antiphonDesk?: {
    player: {
      snapshot(): {
        loadedTakeId: string | null;
        playing: boolean;
        positionSec: number;
        durationSec: number;
      };
    };
    playerSnapshot(): { positionSec: number } | null;
  };
}

async function transport(desk: Page): Promise<TransportView | null> {
  return await desk.evaluate(() => {
    const hook = (globalThis as unknown as PlayerHook).__antiphonDesk;
    if (!hook) return null;
    const engine = hook.player.snapshot();
    return {
      loadedTakeId: engine.loadedTakeId,
      playing: engine.playing,
      enginePositionSec: engine.positionSec,
      durationSec: engine.durationSec,
      uiPositionSec: hook.playerSnapshot()?.positionSec ?? Number.NaN,
    };
  });
}

test.describe("end-of-take auto-stop (F12)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("auto-stop parks UI and engine together; Play restarts from the top", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phone = await (await browser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId);
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

    // --- a short take, converged and auto-loaded --------------------------
    const takeId = await startTake(desk);
    await desk.waitForTimeout(2_500);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, takeId, 1);
    await expect
      .poll(async () => (await transport(desk))?.loadedTakeId ?? null, { timeout: 30_000 })
      .toBe(takeId);

    // --- play the whole take; the meter loop auto-stops at the end --------
    await desk.getByRole("button", { name: "Play", exact: true }).click();
    await expect
      .poll(async () => (await transport(desk))?.playing ?? true, { timeout: 30_000 })
      .toBe(false);

    const stopped = await transport(desk);
    if (!stopped) throw new Error("desk hook unavailable");
    expect(stopped.durationSec).toBeGreaterThan(1);
    // B1: the UI's last notify and the engine agree...
    expect(Math.abs(stopped.uiPositionSec - stopped.enginePositionSec)).toBeLessThan(0.02);
    // ...and both park AT the take end (pause-on-last-frame semantics).
    expect(Math.abs(stopped.enginePositionSec - stopped.durationSec)).toBeLessThan(0.05);

    // --- Play from the parked end restarts at 0, playhead moving ----------
    await desk.getByRole("button", { name: "Play", exact: true }).click();
    await expect
      .poll(async () => (await transport(desk))?.playing ?? false, { timeout: 10_000 })
      .toBe(true);
    const restarted = await transport(desk);
    if (!restarted) throw new Error("desk hook unavailable");
    expect(restarted.enginePositionSec).toBeLessThan(1);
    // The meter loop is alive again: the UI-notified playhead advances.
    await expect
      .poll(async () => (await transport(desk))?.uiPositionSec ?? Number.NaN, { timeout: 10_000 })
      .toBeGreaterThan(restarted.uiPositionSec + 0.1);

    await phone.close();
    await desk.close();
  });
});
