// F8 — stable lane order + status-presentation lows (QA wave 2, G2).
//
// A console's lane order is table stakes: once a lane is on screen it must
// NEVER move for the rest of the session — not on a take, a rename, a
// status poll, a phone reconnect — and a desk reload must rebuild the
// identical order (canonical rule: join order, via the roster's/archive's
// joinedAt; see track-model.ts stableLaneOrder). Lanes also appear the
// moment a performer joins (join order), which retires the misleading
// "Waiting for phones…" copy the instant a phone is actually connected.

import { expect, type Page, test } from "@playwright/test";
import {
  deskState,
  expectTakeConverged,
  joinAsRecorder,
  recorderState,
  renamePeerFromDesk,
  startTake,
  stopTake,
} from "./helpers/session";

/** Track rows in render order, from the desk's ui mirror (mixer strips
 * mirror rows 1:1, so this is the one order that matters). */
async function laneOrder(desk: Page): Promise<Array<{ key: string; name: string }>> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: { ui(): { lanes: Array<{ key: string; name: string }> } | null };
      }
    ).__antiphonDesk;
    return hook?.ui()?.lanes ?? [];
  });
}

test.describe("stable lane order (F8)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("lanes appear on join and hold their order through takes, renames, a phone reconnect and a desk reload", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    // Truly empty room (no phones AND no takes): the waiting copy shows.
    await expect(desk.getByText("Waiting for phones…").first()).toBeVisible();

    // --- phone A joins: a lane materializes immediately, join order -------
    const phoneA = await (await browser.newContext()).newPage();
    await joinAsRecorder(phoneA, sessionId);
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });
    const peerA = (await recorderState(phoneA))?.peerId as string;
    expect(peerA).toBeTruthy();

    // The misleading empty-state copy is gone the moment a phone exists —
    // there's a lane (and a mixer strip) instead, before any take rolls.
    await expect(desk.getByText("Waiting for phones…")).toHaveCount(0);
    await expect.poll(async () => (await laneOrder(desk)).map((l) => l.key)).toEqual([peerA]);
    const laneAName = (await laneOrder(desk))[0]?.name as string;
    await expect(desk.getByRole("slider", { name: `${laneAName} gain` })).toBeVisible();

    // Arm is a real toggle (QA low): aria-pressed reflects state, and the
    // sticky-disarm semantics are spelled out on hover.
    const armA = desk.getByRole("button", { name: `Arm ${laneAName}` });
    await expect(armA).toHaveAttribute("aria-pressed", "true");
    await expect(armA).toHaveAttribute("title", "arm changes apply between takes");
    await armA.click();
    await expect(armA).toHaveAttribute("aria-pressed", "false");
    await armA.click();
    await expect(armA).toHaveAttribute("aria-pressed", "true");

    // --- phone B joins second: appended after A ---------------------------
    const phoneB = await (await browser.newContext()).newPage();
    await joinAsRecorder(phoneB, sessionId);
    await expect(desk.getByText("2 phones connected")).toBeVisible({ timeout: 15_000 });
    const peerB = (await recorderState(phoneB))?.peerId as string;
    await expect
      .poll(async () => (await laneOrder(desk)).map((l) => l.key))
      .toEqual([peerA, peerB]);

    // --- renames change names, never order ---------------------------------
    await renamePeerFromDesk(desk, peerA, "Alice");
    await renamePeerFromDesk(desk, peerB, "Bob");
    await expect
      .poll(async () => (await laneOrder(desk)).map((l) => `${l.key}:${l.name}`))
      .toEqual([`${peerA}:Alice`, `${peerB}:Bob`]);

    // --- take 1: still [Alice, Bob] ----------------------------------------
    const take1 = await startTake(desk);
    await desk.waitForTimeout(2_500);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, take1, 2);
    expect((await laneOrder(desk)).map((l) => l.name)).toEqual(["Alice", "Bob"]);

    // --- status polls churn for a while: order must not wobble -------------
    for (let i = 0; i < 3; i++) {
      await desk.waitForTimeout(1_000);
      expect((await laneOrder(desk)).map((l) => l.name)).toEqual(["Alice", "Bob"]);
    }

    // --- phone B reloads and rejoins (A12 device identity): same lane,
    //     same spot — a reconnect must never reshuffle the console --------
    await phoneB.reload();
    await phoneB.getByRole("button", { name: /enable microphone/i }).click();
    await expect
      .poll(async () => (await recorderState(phoneB))?.serverLink ?? "down", { timeout: 20_000 })
      .toBe("connected");
    expect((await recorderState(phoneB))?.peerId).toBe(peerB);
    await expect(desk.getByText("2 phones connected")).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => (await laneOrder(desk)).map((l) => `${l.key}:${l.name}`))
      .toEqual([`${peerA}:Alice`, `${peerB}:Bob`]);

    // --- take 2 after the reconnect: order still frozen ---------------------
    const take2 = await startTake(desk);
    await desk.waitForTimeout(2_000);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, take2, 2);
    expect((await laneOrder(desk)).map((l) => l.name)).toEqual(["Alice", "Bob"]);

    // --- desk reload: the cold rebuild derives the SAME canonical order
    //     (roster/archive joinedAt), names included (F1 + F8) ---------------
    await desk.reload();
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();
    await expect
      .poll(
        async () =>
          ((await deskState(desk))?.session?.peers ?? []).filter((p) => p.role === "recorder")
            .length,
        { timeout: 20_000 },
      )
      .toBe(2);
    await expect
      .poll(async () => (await laneOrder(desk)).map((l) => `${l.key}:${l.name}`), {
        timeout: 20_000,
      })
      .toEqual([`${peerA}:Alice`, `${peerB}:Bob`]);
    // ...and holds once the archive/status polling has fully caught up.
    await desk.waitForTimeout(3_000);
    expect((await laneOrder(desk)).map((l) => `${l.key}:${l.name}`)).toEqual([
      `${peerA}:Alice`,
      `${peerB}:Bob`,
    ]);

    await phoneA.close();
    await phoneB.close();
    await desk.close();
  });
});
