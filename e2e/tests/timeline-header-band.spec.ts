// W6-A — the tracks header column is one opaque, full-height surface.
//
// Operator finding: the sticky lane headers ended with the last lane, so
// with few lanes everything below them was bare container — scroll the
// arrangement and the full-height overlays (playhead + marker hairlines)
// and anything else living at content-x drew straight through where TRACKS
// chrome should be. A flex-1 filler row now extends the band (sticky left,
// opaque bg-card, z-[5] like the row headers) to the container's bottom
// edge at every scroll position.
//
// Pinned structurally, not visually: elementFromPoint sampled across the
// band's box — three xs across its 232px, ys from under the ruler down to
// the container bottom (so including below the last lane) — must always
// land on band chrome (a lane header or the filler), never on lane, grid
// or clip content; at rest, scrolled right, at the far right end, and
// vertically scrolled in a squat viewport. The W4-C pointer contract holds
// for the extension: presses in the band (excluded by the viewport-space
// x-guard) never seek, clear a selection or start a marquee, while
// lane-x presses below the last lane still seek.

import { expect, type Page, test } from "@playwright/test";
import {
  expectTakeConverged,
  joinAsRecorder,
  startTake,
  stopTake,
  uiSelection,
} from "./helpers/session";

test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

const TRACK_HEADER_W = 232;
const RULER_H = 30;
const PX_PER_SEC = 24; // default zoom
const TAKE_BASE_SEC = 1; // first take sits at +1 s on the arrangement

/** elementFromPoint across the header band's box; returns the offenders.
 * Sampling starts below the sticky ruler (its corner cell is its own,
 * separately-sticky chrome) and ends at the container's bottom edge.
 * Row SEAM pixels are sampled explicitly (W7-C): each lane header's
 * bottom border must belong to the header itself (border-on-children),
 * not to a z-auto row wrapper — a wrapper-owned seam is the 1px slit the
 * z-[4] playhead used to bleed through while crossing the band. */
async function bandLeaks(desk: Page): Promise<string[]> {
  return await desk.evaluate(
    ({ headerW, rulerH }) => {
      const viewport = document.querySelector("[data-ruler]")?.closest("section");
      if (!viewport) return ["timeline viewport not found"];
      const vp = viewport.getBoundingClientRect();
      const xs = [8, Math.floor(headerW / 2), headerW - 8];
      const ys: number[] = [];
      for (let y = rulerH + 6; y < viewport.clientHeight - 6; y += 40) ys.push(y);
      ys.push(viewport.clientHeight - 8);
      // The seam pixel of every visible lane ROW: the last pixel of the
      // row wrapper's box — measured on the wrapper, NOT the header, so a
      // wrapper-owned border (the regression shape: the header stops 1px
      // short of the row bottom, exposing a z-auto slit the playhead
      // paints through) is actually sampled instead of the header's own
      // last pixel. The integer y matters: Chromium's elementFromPoint
      // quantizes fractional points, and bottom-1 is the one y that
      // reliably lands IN the border pixel. Seams hidden under the sticky
      // ruler or below the viewport are skipped (rects are viewport-
      // absolute; ys are vp-relative).
      for (const header of document.querySelectorAll("[data-lane-header]")) {
        const row = header.parentElement;
        if (!row) continue;
        const seamY = Math.round(row.getBoundingClientRect().bottom) - 1 - vp.top;
        if (seamY > rulerH + 1 && seamY < viewport.clientHeight - 1) ys.push(seamY);
      }
      const bad: string[] = [];
      for (const y of ys) {
        for (const x of xs) {
          const el = document.elementFromPoint(vp.left + x, vp.top + y);
          const inBand =
            el !== null &&
            (el.closest("[data-lane-header]") !== null ||
              el.closest("[data-header-filler]") !== null);
          if (!inBand) bad.push(`(${x},${y}) hit ${el === null ? "nothing" : el.tagName}`);
        }
      }
      return bad;
    },
    { headerW: TRACK_HEADER_W, rulerH: RULER_H },
  );
}

/** Scroll the timeline viewport and report where it actually landed. */
async function scrollTimeline(
  desk: Page,
  to: { left?: number; top?: number },
): Promise<{ left: number; top: number }> {
  return await desk.evaluate((target) => {
    const viewport = document.querySelector("[data-ruler]")?.closest("section");
    if (!viewport) return { left: -1, top: -1 };
    if (target.left !== undefined) viewport.scrollLeft = target.left;
    if (target.top !== undefined) viewport.scrollTop = target.top;
    return { left: viewport.scrollLeft, top: viewport.scrollTop };
  }, to);
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

test("the tracks band is opaque and full-height at every scroll position", async ({ browser }) => {
  test.setTimeout(120_000);
  const sessionId = crypto.randomUUID();

  const desk = await (await browser.newContext()).newPage();
  await desk.goto(`/session/${sessionId}`);
  await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

  const phone = await (await browser.newContext()).newPage();
  await joinAsRecorder(phone, sessionId);
  await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

  // One short take: a clip on the one lane, the playhead parked by the
  // auto-load — content that can scroll through the band's box.
  const takeId = await startTake(desk);
  await desk.waitForTimeout(2_500);
  await stopTake(desk);
  const { deskStreams } = await expectTakeConverged(desk, sessionId, takeId, 1);
  const clipId = (deskStreams[0] as { streamId: string }).streamId;
  await expect(desk.locator("[data-playhead]")).toBeVisible({ timeout: 30_000 });

  // Park the playhead at ~11 arrangement-seconds: after the 400px scroll
  // below, its full-height hairline crosses the band's box under the last
  // lane — exactly the operator's sighting.
  await desk.locator("[data-ruler]").click({ position: { x: 264, y: 22 } });

  // --- horizontal axis: at rest, mid-arrangement, far right end -------------
  expect(await bandLeaks(desk)).toEqual([]);
  expect((await scrollTimeline(desk, { left: 400 })).left).toBe(400);
  expect(await bandLeaks(desk)).toEqual([]);
  await desk.screenshot({ path: test.info().outputPath("band-scrolled-right.png") });
  expect((await scrollTimeline(desk, { left: 1_000_000 })).left).toBeGreaterThan(400);
  expect(await bandLeaks(desk)).toEqual([]);

  // The filler is honest chrome, not merely hit-test cover: sticky in the
  // band's plane, fully opaque background, stacked over the z-[4] playhead.
  const filler = desk.locator("[data-header-filler]");
  const style = await filler.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { position: cs.position, z: cs.zIndex, bg: cs.backgroundColor };
  });
  expect(style.position).toBe("sticky");
  expect(Number(style.z)).toBeGreaterThan(4);
  expect(style.bg).toMatch(/^rgb\(/); // rgb(), not rgba(…): alpha 1

  // --- W4-C pointer contract on the extension --------------------------------
  await scrollTimeline(desk, { left: 0 });
  await desk.locator(`[data-clip="${clipId}"]`).click();
  await expect.poll(async () => await uiSelection(desk)).toEqual([clipId]);
  const playheadX = async () =>
    ((await desk.locator("[data-playhead]").boundingBox()) as { x: number }).x;
  const x0 = await playheadX();
  const vp = (await desk
    .locator("[data-ruler]")
    .evaluate((el) => el.closest("section")?.getBoundingClientRect().toJSON())) as {
    left: number;
    top: number;
    height: number;
  };
  const laneBottom = (await desk.locator("[data-lane-header]").boundingBox()) as {
    y: number;
    height: number;
  };
  const belowLanesY = laneBottom.y + laneBottom.height + 40; // inside the filler

  // A click on the filler band neither seeks nor clears the selection…
  await desk.mouse.click(vp.left + 100, belowLanesY);
  // …and a drag held entirely inside the band starts no marquee (a marquee
  // over empty space would REPLACE the selection with nothing).
  await desk.mouse.move(vp.left + 60, belowLanesY);
  await desk.mouse.down();
  await desk.mouse.move(vp.left + 200, belowLanesY + 30, { steps: 5 });
  await desk.mouse.up();
  await desk.waitForTimeout(300); // a beat for any would-be seek/marquee
  expect(await uiSelection(desk)).toEqual([clipId]);
  expect(await playheadX()).toBe(x0);

  // The lane side of the filler row is still W4-C timeline: a click below
  // the last lane inside the take's span seeks there (W6-B: the transport
  // clock is session-absolute — the clicked arrangement second itself).
  await desk.mouse.click(
    vp.left + TRACK_HEADER_W + (TAKE_BASE_SEC + 1.5) * PX_PER_SEC,
    belowLanesY,
  );
  await expect
    .poll(async () => Math.abs((await playerPosition(desk)) - (TAKE_BASE_SEC + 1.5)), {
      timeout: 30_000,
    })
    .toBeLessThan(0.1);

  // --- vertical axis: squash the viewport so the lanes overflow --------------
  // (48px top bar + 40px toolbar + 264px mixer leave ~78px of timeline at
  // 430 — less than ruler + one lane, so the rows genuinely scroll.)
  await desk.setViewportSize({ width: 1280, height: 430 });
  const scrolled = await scrollTimeline(desk, { left: 400, top: 1_000_000 });
  expect(scrolled.top).toBeGreaterThan(0);
  expect(await bandLeaks(desk)).toEqual([]);

  await phone.close();
  await desk.close();
});
