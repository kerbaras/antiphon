// QA wave-2 group G3 — timeline polish.
//
// F17 · additive clip selection: plain click replaces the selection;
// shift-click (and cmd/ctrl-click) TOGGLES a clip in/out of it; a marquee
// dragged with shift held ADDS its hits instead of replacing. Selection
// stays decoupled from loading (QA E3 / wave 1): none of these gestures
// may switch the loaded take — double-click remains the explicit load.
// The Delete-confirm flow (F2) must itemize a mixed multi-take selection.
//
// LOW · zoom anchoring: changing zoom keeps the content under the anchor
// (the playhead when visible, else the viewport center) at the same
// viewport x — the timeline must not slide under the operator's eye.
//
// LOW · min-width clips: a sub-second take draws at the clip floor width
// (26 px), narrower than any status badge — the badge must be hidden
// (never clipped mid-word) with the status still conveyed via the clip
// title; wide clips keep their badge.

import { expect, type Page, test } from "@playwright/test";
import {
  type DeskStreamStatus,
  expectTakeConverged,
  joinAsRecorder,
  startTake,
  stopTake,
  uiSelection,
} from "./helpers/session";

// Default zoom (24 px/sec); first take sits at +1 s on the arrangement.
const PX_PER_SEC = 24;
const TAKE_BASE_SEC = 1;

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

/** Marquee over one clip: drag from the empty gap right of it into the
 * empty gap left of it (TAKE_GAP_SECONDS = 2 s → 48 px of clear lane on
 * either side at the default zoom). */
async function marqueeOver(desk: Page, streamId: string, modifier?: "Shift"): Promise<void> {
  const box = await desk.locator(`[data-clip="${streamId}"]`).boundingBox();
  expect(box, `clip ${streamId} visible`).not.toBeNull();
  if (!box) return;
  if (modifier) await desk.keyboard.down(modifier);
  await desk.mouse.move(box.x + box.width + 12, box.y + 4);
  await desk.mouse.down();
  await desk.mouse.move(box.x - 12, box.y + box.height - 4, { steps: 6 });
  await desk.mouse.up();
  if (modifier) await desk.keyboard.up(modifier);
}

test.describe("timeline polish (F17 + zoom anchor + min-width badges)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("shift-click toggles, shift-marquee adds, zoom anchors, tiny clips drop the badge", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phone = await (await browser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId);
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

    // --- take 1 (~3.5 s, badge-wide) and take 2 (sub-second, floor-width) ---
    const streamOf: Record<string, string> = {};
    const takeIds: string[] = [];
    for (const durationMs of [3_500, 700]) {
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

    // The latest complete take auto-loads; selection gestures below must
    // never move the player off it (QA E3 preserved).
    await expect.poll(async () => await loadedTakeId(desk), { timeout: 30_000 }).toBe(take2);

    // --- F17: plain click replaces ------------------------------------------
    await desk.locator(`[data-clip="${clip1}"]`).click();
    await expect.poll(async () => await uiSelection(desk)).toEqual([clip1]);
    await expect(desk.locator(`[data-clip="${clip1}"]`)).toHaveAttribute("data-selected", "true");

    // --- F17: shift-click ADDS the second take's clip ------------------------
    await desk.locator(`[data-clip="${clip2}"]`).click({ modifiers: ["Shift"] });
    await expect.poll(async () => await uiSelection(desk)).toEqual([clip1, clip2].sort());
    await expect(desk.locator(`[data-clip="${clip2}"]`)).toHaveAttribute("data-selected", "true");
    expect(await loadedTakeId(desk)).toBe(take2); // selection never loads

    // --- F2 dialog itemizes the mixed multi-take selection -------------------
    // Shift+Delete: the DURABLE path keeps the confirm (plain Delete is a
    // projection-only edit since W9-F and asks nothing).
    await desk.keyboard.press("Shift+Delete");
    const dialog = desk.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Delete 2 clips?")).toBeVisible();
    await expect(dialog.getByText("Take 1", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Take 2", { exact: true })).toBeVisible();
    await desk.keyboard.press("Escape"); // cancel — nothing deleted
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await uiSelection(desk)).length).toBe(2);

    // --- F17: cmd/ctrl-click TOGGLES a selected clip back out ----------------
    await desk.locator(`[data-clip="${clip1}"]`).click({ modifiers: ["ControlOrMeta"] });
    await expect.poll(async () => await uiSelection(desk)).toEqual([clip2]);
    await expect(desk.locator(`[data-clip="${clip1}"]`)).toHaveAttribute("data-selected", "false");

    // --- F17: shift-click toggles the last one out too ------------------------
    await desk.locator(`[data-clip="${clip2}"]`).click({ modifiers: ["Shift"] });
    await expect.poll(async () => await uiSelection(desk)).toEqual([]);

    // --- F17: plain marquee replaces; shift-marquee ADDS ----------------------
    await marqueeOver(desk, clip1);
    await expect.poll(async () => await uiSelection(desk)).toEqual([clip1]);
    await marqueeOver(desk, clip2, "Shift");
    await expect.poll(async () => await uiSelection(desk)).toEqual([clip1, clip2].sort());
    expect(await loadedTakeId(desk)).toBe(take2);

    // Empty-lane clicks: shift-click PRESERVES the selection (an additive
    // gesture never wipes it); a plain click still clears (baseline).
    // (Plain-press on an already-selected clip also keeps the group — the
    // wave-1 drag-the-group semantics, unchanged by F17.)
    const box2 = (await desk.locator(`[data-clip="${clip2}"]`).boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const bareLane = { x: box2.x + box2.width + 30, y: box2.y + 10 };
    await desk.keyboard.down("Shift");
    await desk.mouse.click(bareLane.x, bareLane.y);
    await desk.keyboard.up("Shift");
    await expect.poll(async () => await uiSelection(desk)).toEqual([clip1, clip2].sort());
    await desk.mouse.click(bareLane.x, bareLane.y);
    await expect.poll(async () => await uiSelection(desk)).toEqual([]);

    // --- LOW: min-width clip hides its badge, keeps status in the title ------
    const tiny = desk.locator(`[data-clip="${clip2}"]`);
    const tinyBox = await tiny.boundingBox();
    expect(tinyBox).not.toBeNull();
    expect((tinyBox as { width: number }).width).toBeLessThan(40); // truly floor-width
    await expect(tiny.locator("[data-badge]")).toHaveCount(0);
    await expect(tiny).toHaveAttribute("title", /converged|aligned|syncing/);
    await expect(tiny.locator("[data-status-dot]")).toBeVisible(); // color keeps carrying status
    // ...and nothing inside the tiny clip overflows it horizontally.
    const overflow = await tiny.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // The wide clip keeps its badge (converged or aligned, mic-dependent).
    await expect(desk.locator(`[data-clip="${clip1}"]`).locator("[data-badge]")).toBeVisible();

    // --- LOW: zoom anchors the playhead -------------------------------------
    // Load take 1 (explicit double-click), park the playhead mid-take.
    await desk.locator(`[data-clip="${clip1}"]`).dblclick();
    await expect.poll(async () => await loadedTakeId(desk), { timeout: 30_000 }).toBe(take1);
    const seekX = (TAKE_BASE_SEC + 1.75) * PX_PER_SEC;
    await desk.locator("[data-ruler]").click({ position: { x: seekX, y: 22 } });
    // W6-B: session-absolute position — the clicked arrangement second.
    await expect
      .poll(async () => Math.abs((await playerPosition(desk)) - (TAKE_BASE_SEC + 1.75)))
      .toBeLessThan(0.1);

    const playhead = desk.locator("[data-playhead]");
    await expect(playhead).toBeVisible();
    const xAt = async () => ((await playhead.boundingBox()) as { x: number }).x;

    const x0 = await xAt();
    const drift = async () => Math.abs((await xAt()) - x0);
    await desk.getByRole("button", { name: "Zoom in" }).click(); // 100% → 125%
    await expect.poll(drift).toBeLessThanOrEqual(3);

    await desk.getByRole("button", { name: "Zoom in" }).click(); // 125% → 150%
    await expect.poll(drift).toBeLessThanOrEqual(3);

    await desk.getByRole("button", { name: "Zoom out" }).click(); // 150% → 125%
    await desk.getByRole("button", { name: "Zoom out" }).click(); // 125% → 100%
    await expect.poll(drift).toBeLessThanOrEqual(3);

    await phone.close();
    await desk.close();
  });
});
