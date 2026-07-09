// W4-C — timeline interaction batch (Wave 4 operator dogfooding).
//
// 1 · Click-to-seek ANYWHERE: a plain click on bare timeline surface is a
//     transport action — the playhead parks at the clicked x even when the
//     player has nothing loaded (a session with no takes at all), and a
//     click inside another take's clips retargets the player onto that take
//     (the double-click-a-take "focus dance" is gone; double-click on a
//     clip stays as the explicit load for clip presses, which remain
//     selection-only per QA E3). A click during PLAYBACK keeps its point
//     through the retarget load (paused, no auto-resume — QA W4-C major),
//     and an explicit foreign seek (⏮) always clears a parked pin, even
//     when the player's position value doesn't move (QA W4-C minor).
//     W6-B: the player's clock IS the arrangement timeline now — position
//     assertions are session-absolute (take base included), any in-session
//     click (gaps included) is directly expressible by the engine, and ⏮
//     returns to SESSION zero. The pin-over-clamp scenario (QA W4-C minor)
//     now needs a park BEYOND the session end to arise at all.
// 2 · Marquee from empty vertical space: the interactive layer spans the
//     full scrollable container, so a selection drag can start below the
//     last lane and still select every clip its rectangle crosses.
// 3 · The timeline is not text: drags across lane labels, placeholder copy
//     and clip titles must never produce a DOM text selection.

import { expect, type Page, test } from "@playwright/test";
import {
  type DeskStreamStatus,
  expectTakeConverged,
  joinAsRecorder,
  startTake,
  stopTake,
  uiSelection,
} from "./helpers/session";

// Default zoom (24 px/sec); the first take sits at +1 s on the arrangement.
const PX_PER_SEC = 24;
const TAKE_BASE_SEC = 1;
const RULER_H = 30;
const TRACK_ROW_H = 66;

async function uiPlayhead(desk: Page): Promise<number | null> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: { ui(): { playheadSec: number | null } | null };
      }
    ).__antiphonDesk;
    return hook?.ui()?.playheadSec ?? null;
  });
}

async function loadedTakeId(desk: Page): Promise<string | null> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: { playerSnapshot(): { loadedTakeId: string | null } | null };
      }
    ).__antiphonDesk;
    return hook?.playerSnapshot()?.loadedTakeId ?? null;
  });
}

async function playerPosition(desk: Page): Promise<number> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: { playerSnapshot(): { positionSec: number } | null };
      }
    ).__antiphonDesk;
    return hook?.playerSnapshot()?.positionSec ?? -1;
  });
}

async function playerPlaying(desk: Page): Promise<boolean> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: { playerSnapshot(): { playing: boolean } | null };
      }
    ).__antiphonDesk;
    return hook?.playerSnapshot()?.playing ?? false;
  });
}

/** The window's live text selection after a drag — must stay empty. */
async function selectedText(desk: Page): Promise<string> {
  return await desk.evaluate(() => window.getSelection()?.toString() ?? "");
}

test.describe("timeline interactions (W4-C)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("click-to-seek anywhere, marquee from empty space, no text selection", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    // --- 3a · the timeline is not text: a drag from the placeholder row's
    // header label across the lane copy must select NOTHING (it selected
    // both strings before select-none) -----------------------------------------
    const waiting = (await desk
      .locator("section")
      .getByText("Waiting for phones…")
      .boundingBox()) as { x: number; y: number };
    await desk.mouse.move(waiting.x + 2, waiting.y + 5);
    await desk.mouse.down();
    await desk.mouse.move(waiting.x + 500, waiting.y + 5, { steps: 10 });
    await desk.mouse.up();
    expect(await selectedText(desk)).toBe("");

    const phone = await (await browser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId);
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

    // Lane x-origin in page coordinates: the ruler starts where lanes start.
    const ruler = desk.locator("[data-ruler]");
    const rulerBox = (await ruler.boundingBox()) as { x: number; y: number };
    const laneX = (sec: number) => rulerBox.x + sec * PX_PER_SEC;
    const rowY = rulerBox.y + RULER_H + 20; // inside the first (only) lane row

    // --- 1a · no takes at ALL: a lane click still places the playhead -------
    await desk.mouse.click(laneX(5), rowY);
    await expect
      .poll(async () => {
        const at = await uiPlayhead(desk);
        return at === null ? "none" : Math.abs(at - 5) < 0.1;
      })
      .toBe(true);
    await expect(desk.locator("[data-playhead]")).toBeVisible();

    // --- two takes (~3.5 s and ~2.5 s), recorded to convergence -------------
    const streamOf: Record<string, string> = {};
    const takeIds: string[] = [];
    for (const durationMs of [3_500, 2_500]) {
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
    const clip1 = streamOf[take1] as string;
    const clip2 = streamOf[take2] as string;

    // The latest complete take auto-loads.
    await expect.poll(async () => await loadedTakeId(desk), { timeout: 30_000 }).toBe(take2);

    const box1 = (await desk.locator(`[data-clip="${clip1}"]`).boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const box2 = (await desk.locator(`[data-clip="${clip2}"]`).boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const belowLanesY = rulerBox.y + RULER_H + TRACK_ROW_H + 40; // empty space under the last lane

    // --- 1b · click inside take 1's span (in the empty space BELOW the lane:
    // the surface is one time axis) retargets the player — no dblclick dance —
    // and parks at the clicked SESSION time once loaded (W6-B: the engine
    // clock is the arrangement axis, so position == clicked x) ------------------
    await desk.mouse.click(laneX(TAKE_BASE_SEC + 1.5), belowLanesY);
    await expect
      .poll(async () => {
        const at = await uiPlayhead(desk);
        return at === null ? "none" : Math.abs(at - (TAKE_BASE_SEC + 1.5)) < 0.1;
      })
      .toBe(true); // playhead parks immediately, before the load settles
    await expect.poll(async () => await loadedTakeId(desk), { timeout: 30_000 }).toBe(take1);
    await expect
      .poll(async () => Math.abs((await playerPosition(desk)) - (TAKE_BASE_SEC + 1.5)))
      .toBeLessThan(0.1);

    // --- 1c · click in the bare gap between the takes: the playhead parks at
    // the clicked spot, the loaded take does NOT change -------------------------
    const gapX = box2.x - 24; // gap is TAKE_GAP_SECONDS = 2 s → 48 px; dead center
    const gapSec = (gapX - rulerBox.x) / PX_PER_SEC;
    await desk.mouse.click(gapX, rowY);
    await expect
      .poll(async () => {
        const at = await uiPlayhead(desk);
        return at === null ? "none" : Math.abs(at - gapSec) < 0.1;
      })
      .toBe(true);
    expect(await loadedTakeId(desk)).toBe(take1);

    // --- 1d · a ruler click into take 2's span retargets too ------------------
    const take2BaseSec = (box2.x - rulerBox.x) / PX_PER_SEC;
    await ruler.click({ position: { x: (take2BaseSec + 1) * PX_PER_SEC, y: 22 } });
    await expect.poll(async () => await loadedTakeId(desk), { timeout: 30_000 }).toBe(take2);
    await expect
      .poll(async () => Math.abs((await playerPosition(desk)) - (take2BaseSec + 1)))
      .toBeLessThan(0.1);

    // --- 1e · a click DURING PLAYBACK into another take's span keeps the
    // clicked point through the retarget (QA W4-C major): the pin must not
    // yield to the OLD take's motion — the new take comes up PAUSED at the
    // clicked spot (double-click load parity, no auto-resume) ------------------
    await desk.keyboard.press("Space"); // play take 2 from within its span
    await expect.poll(async () => await playerPlaying(desk)).toBe(true);
    await desk.mouse.click(laneX(TAKE_BASE_SEC + 1.5), belowLanesY);
    await expect.poll(async () => await loadedTakeId(desk), { timeout: 30_000 }).toBe(take1);
    await expect
      .poll(async () => Math.abs((await playerPosition(desk)) - (TAKE_BASE_SEC + 1.5)))
      .toBeLessThan(0.1);
    expect(await playerPlaying(desk)).toBe(false);
    await expect
      .poll(async () => {
        const at = await uiPlayhead(desk);
        return at === null ? "none" : Math.abs(at - (TAKE_BASE_SEC + 1.5)) < 0.1;
      })
      .toBe(true); // the playhead sits at the CLICKED point, not the take start

    // --- 1f · ⏮ clears a BEYOND-END pin even though the player's position
    // value doesn't have to move to the pin (QA W4-C minor, W6-B shape: the
    // engine expresses every in-session position now, so the only park it
    // CANNOT express is one past the session end — the pin holds the clicked
    // spot there, and ⏮'s foreign seek must still tear it down) ---------------
    const beyondEndX = box2.x + box2.width + 3 * PX_PER_SEC; // ~3 s past the last clip
    const beyondEndSec = (beyondEndX - rulerBox.x) / PX_PER_SEC;
    await desk.mouse.click(beyondEndX, rowY);
    await expect
      .poll(async () => {
        const at = await uiPlayhead(desk);
        return at === null ? "none" : Math.abs(at - beyondEndSec) < 0.1;
      })
      .toBe(true); // pin holds the honest clicked spot (audio parked at session end)
    await desk.getByRole("button", { name: "Return to start" }).click();
    await expect
      .poll(async () => {
        const at = await uiPlayhead(desk);
        return at === null ? "none" : Math.abs(at) < 0.1;
      })
      .toBe(true); // pin yielded: ⏮ = SESSION zero (W6-B), engine expresses it

    // --- 2 · marquee STARTED below the last lane still selects the clips its
    // rectangle crosses (the interactive layer spans the whole container) ------
    await desk.mouse.move(box2.x + box2.width + 12, belowLanesY);
    await desk.mouse.down();
    await desk.mouse.move(box1.x - 12, box1.y + 4, { steps: 8 });
    await desk.mouse.up();
    await expect.poll(async () => await uiSelection(desk)).toEqual([clip1, clip2].sort());
    expect(await loadedTakeId(desk)).toBe(take1); // selection still never loads (QA E3)

    // --- 3b · with real lanes: a drag from the lane-header labels out across
    // the clip titles still selects nothing ------------------------------------
    const header = desk.getByText("audio", { exact: true }).first();
    const headerBox = (await header.boundingBox()) as { x: number; y: number; height: number };
    await desk.mouse.move(headerBox.x + 2, headerBox.y + headerBox.height / 2);
    await desk.mouse.down();
    await desk.mouse.move(box2.x + box2.width, box2.y + 8, { steps: 10 });
    await desk.mouse.up();
    expect(await selectedText(desk)).toBe("");

    await phone.close();
    await desk.close();
  });
});
