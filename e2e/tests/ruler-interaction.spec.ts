// F11 — ruler hit targets: marker flags must not blanket the ruler.
//
// The 2026-07-08 QA sweeps (QA-2 A4, QA-3 B-1) caught the MarkerFlag button
// spanning the FULL ruler height plus its label width: clicking the ruler
// "behind" a flag label seeked to the marker instead of the clicked time
// (an invisible dead-zone 2–4 s wide at default zoom), and comment ticks
// inside that footprint — exactly where comments cluster, just after song
// starts — were click-shadowed (elementFromPoint resolved to the flag's
// label span) and visually buried under the chip.
//
// One phone records a short take; a comment lands at ~2 s and a marker at
// ~1 s, so the tick sits ~1 s inside the flag's old footprint. Then, in the
// fixed layout (flag chip at the ruler's head, ticks own the foot, hit
// target = hairline strip + chip only):
//  (a) a plain-ruler click 1–2 s after the marker seeks to the CLICKED time,
//  (b) the tick is hit-testable where it sits (elementFromPoint, QA-3 B-1),
//  (c) clicking the tick seeks to the comment,
//  (d) plain ruler background seeks everywhere — including the head band
//      past the chip's end.

import { expect, type Page, test } from "@playwright/test";
import { expectTakeConverged, joinAsRecorder, startTake, stopTake } from "./helpers/session";

// ---- desk hook readers -------------------------------------------------------

interface UiComment {
  id: string;
  atSec: number;
}

async function uiComments(desk: Page): Promise<UiComment[]> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: { ui(): { comments: UiComment[] } | null };
      }
    ).__antiphonDesk;
    return hook?.ui()?.comments ?? [];
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

/** Wait until the take is decoded into the player (marker/comment UI unlocks). */
async function expectTakeLoaded(desk: Page, takeId: string, tracks: number): Promise<void> {
  await expect
    .poll(
      async () => {
        return await desk.evaluate(() => {
          const hook = (
            globalThis as unknown as {
              __antiphonDesk?: {
                playerSnapshot(): { loadedTakeId: string | null; tracks: unknown[] } | null;
              };
            }
          ).__antiphonDesk;
          const snap = hook?.playerSnapshot();
          return `take=${snap?.loadedTakeId ?? null} tracks=${snap?.tracks.length ?? 0}`;
        });
      },
      { timeout: 30_000 },
    )
    .toBe(`take=${takeId} tracks=${tracks}`);
}

/** What actually receives a pointer at the tick's center (QA-3 B-1 probe):
 * "tick" when the tick or a descendant is topmost, else a terse description
 * of the shadowing element. */
async function hitAtTickCenter(desk: Page): Promise<string> {
  return await desk.evaluate(() => {
    const tick = document.querySelector("[data-comment-tick]");
    if (!tick) return "no tick rendered";
    const rect = tick.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    if (hit && (hit === tick || tick.contains(hit))) return "tick";
    const owner = hit?.closest("[data-marker]");
    return `${hit?.tagName ?? "nothing"}${owner ? " inside [data-marker] flag" : ""}`;
  });
}

// Default zoom: 24 px/sec; the first take sits at +1 s on the arrangement.
const PX_PER_SEC = 24;
const TAKE_BASE_SEC = 1;

test.describe("ruler hit targets (F11)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("marker flags don't shadow ruler seeks or comment ticks", async ({ browser }) => {
    test.setTimeout(180_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phone = await (await browser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId);
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

    // --- a short take, recorded to convergence -------------------------------
    const takeId = await startTake(desk);
    await desk.waitForTimeout(4_000);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, takeId, 1);
    await expectTakeLoaded(desk, takeId, 1);

    // --- comment at ~2 s (before any marker exists, so nothing shadows the
    // placement click), then a marker at ~1 s: the tick ends up ~1 s after
    // the flag, inside its old full-height footprint -------------------------
    await expect(desk.getByRole("button", { name: "Add comment at playhead" })).toBeEnabled({
      timeout: 15_000,
    });
    await desk
      .locator("[data-ruler]")
      .click({ position: { x: (TAKE_BASE_SEC + 2) * PX_PER_SEC, y: 15 } });
    // W6-B: positions are session-absolute (the ruler click's own x).
    await expect
      .poll(async () => Math.abs((await playerPosition(desk)) - (TAKE_BASE_SEC + 2)))
      .toBeLessThan(0.1);
    // N opens the composer (moved from C — the Split tool owns C, W7-B).
    await desk.keyboard.press("n");
    const composer = desk.getByLabel("Comment text");
    await expect(composer).toBeFocused();
    await composer.fill("tick under the flag footprint");
    await composer.press("Enter");
    await expect(desk.locator("[data-comment-tick]")).toHaveCount(1);
    await desk.keyboard.press("Escape"); // leave the composer

    await desk
      .locator("[data-ruler]")
      .dblclick({ position: { x: (TAKE_BASE_SEC + 1) * PX_PER_SEC, y: 15 } });
    await expect(desk.getByRole("button", { name: "Marker Song 1", exact: true })).toBeVisible();
    const commentAtSec = (await uiComments(desk))[0]?.atSec as number;
    expect(commentAtSec).toBeGreaterThan(1.7);
    expect(commentAtSec).toBeLessThan(2.3);

    // --- (a) plain ruler 1.3 s after the marker seeks to the CLICKED time ---
    // (48..~92 px was the flag's old invisible footprint; 80 px is bare ruler)
    const midX = (TAKE_BASE_SEC + 2.33) * PX_PER_SEC; // ≈ 80 px, take-time 2.33 s
    await desk.locator("[data-ruler]").click({ position: { x: midX, y: 22 } });
    await expect
      .poll(async () => Math.abs((await playerPosition(desk)) - midX / PX_PER_SEC))
      .toBeLessThan(0.1);

    // --- (b) the tick's own pixels are topmost where it sits ----------------
    expect(await hitAtTickCenter(desk)).toBe("tick");

    // --- (c) clicking the tick seeks to the comment --------------------------
    await desk.locator("[data-comment-tick]").click({ timeout: 5_000 });
    await expect
      .poll(async () => Math.abs((await playerPosition(desk)) - (TAKE_BASE_SEC + commentAtSec)))
      .toBeLessThan(0.05);

    // --- (d) head-band ruler background past the chip still seeks -----------
    const headX = (TAKE_BASE_SEC + 3) * PX_PER_SEC + 4; // ≈ 100 px, take-time ≈ 3.17 s
    await desk.locator("[data-ruler]").click({ position: { x: headX, y: 8 } });
    await expect
      .poll(async () => Math.abs((await playerPosition(desk)) - headX / PX_PER_SEC))
      .toBeLessThan(0.1);

    // The flag itself still seeks to the marker (visuals + behavior intact;
    // the marker sits at take-time 1 = session TAKE_BASE_SEC + 1).
    await desk.getByRole("button", { name: "Marker Song 1", exact: true }).click();
    await expect
      .poll(async () => Math.abs((await playerPosition(desk)) - (TAKE_BASE_SEC + 1)))
      .toBeLessThan(0.05);

    await phone.close();
    await desk.close();
  });
});
