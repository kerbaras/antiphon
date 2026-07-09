// W2-F — comments with mark-as-done.
//
// One phone records a short take; once it converges and auto-loads, the
// reviewer annotates it: N opens the composer focused (moved from C in
// W7-B — the Split tool owns C now), a take-wide note lands at the
// playhead, a lane-pinned note lands mid-take after a ruler seek. Panel
// rows carry author + seekable timecode (+ lane chip when pinned); the
// ruler grows one amber tick per comment. Resolving drops the
// tab's open-count badge, dims the tick, and the Open filter hides the row.
// Comments persist in localStorage per (session, take) — they must survive
// a desk reload alongside the OPFS archive rebuild — and delete removes
// row + tick.

import { expect, type Page, test } from "@playwright/test";
import {
  deskStatus,
  expectTakeConverged,
  joinAsRecorder,
  startTake,
  stopTake,
} from "./helpers/session";

// ---- desk hook readers -------------------------------------------------------

interface UiComment {
  id: string;
  atSec: number;
  streamId: string | null;
  text: string;
  author: string;
  createdAtMs: number;
  resolvedAtMs: number | null;
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

/** Wait until the take is decoded into the player (comment UI unlocks). */
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

// Default zoom: 24 px/sec; the first take sits at +1 s on the arrangement.
const PX_PER_SEC = 24;
const TAKE_BASE_SEC = 1;

test.describe("comments with mark-as-done (W2-F)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("compose, pin to a lane, seek, resolve, filter, survive a reload, delete", async ({
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

    // --- a short take, recorded to convergence -------------------------------
    const takeId = await startTake(desk);
    await desk.waitForTimeout(4_000);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, takeId, 1);
    await expectTakeLoaded(desk, takeId, 1);
    const streamId = (await deskStatus(desk)).find((s) => s.takeId === takeId)?.streamId as string;

    // --- N opens the composer focused (C belongs to the Split tool now —
    // W7-B); toolbar pill unlocks too ------------------------------------------
    await expect(desk.getByRole("button", { name: "Add comment at playhead" })).toBeEnabled({
      timeout: 15_000,
    });
    await desk.keyboard.press("n");
    const composer = desk.getByLabel("Comment text");
    await expect(composer).toBeFocused();

    // --- author pref is editable inline; take-wide comment at playhead 0 -----
    await desk.getByLabel("Comment author").fill("Maestra");
    await composer.fill("alto flat in the second phrase");
    await composer.press("Enter");
    await expect(desk.locator("[data-comment]")).toHaveCount(1);
    const row1 = desk.locator("[data-comment]").first();
    await expect(row1.getByText("Maestra")).toBeVisible();
    await expect(row1.getByTitle("Seek to comment")).toHaveText("@ 00:00.0");

    // --- lane-pinned comment mid-take: seek the ruler, then compose ----------
    await desk.keyboard.press("Escape"); // leave the composer
    await desk
      .locator("[data-ruler]")
      .click({ position: { x: (TAKE_BASE_SEC + 2) * PX_PER_SEC, y: 15 } });
    // W6-B: the transport clock is session-absolute — a ruler click parks
    // the engine at the clicked ARRANGEMENT second (comments stay take-local).
    await expect
      .poll(async () => Math.abs((await playerPosition(desk)) - (TAKE_BASE_SEC + 2)))
      .toBeLessThan(0.1);
    await desk.keyboard.press("n");
    await expect(composer).toBeFocused();
    await desk.getByLabel("Pin comment to lane").selectOption({ index: 1 });
    await composer.fill("tenor entry late here");
    await composer.press("Enter");

    // --- panel rows + ruler ticks ---------------------------------------------
    await expect(desk.locator("[data-comment]")).toHaveCount(2);
    await expect(desk.locator("[data-comment-tick]")).toHaveCount(2);
    const comments = await uiComments(desk);
    expect(comments).toHaveLength(2);
    const first = comments[0] as UiComment;
    const second = comments[1] as UiComment;
    expect(first.streamId).toBeNull();
    expect(first.atSec).toBeCloseTo(0, 1);
    expect(second.streamId).toBe(streamId);
    expect(second.atSec).toBeGreaterThan(1.7);
    expect(second.atSec).toBeLessThan(2.3);
    expect(comments.map((c) => c.author)).toEqual(["Maestra", "Maestra"]);
    // The pinned row wears its lane chip.
    await expect(
      desk.locator(`[data-comment="${second.id}"] [data-lane="${streamId}"]`),
    ).toBeVisible();

    // --- row timecode click seeks the playhead --------------------------------
    await desk.locator(`[data-comment="${first.id}"]`).getByTitle("Seek to comment").click();
    await expect
      .poll(async () => Math.abs((await playerPosition(desk)) - (TAKE_BASE_SEC + first.atSec)))
      .toBeLessThan(0.05);

    // --- resolve: badge drops, tick dims, Open filter hides the row -----------
    // (the badge span abuts the label, so the accessible name is "comments2")
    await expect(desk.getByRole("button", { name: "comments2" })).toBeVisible();
    await desk.getByRole("button", { name: "Resolve comment: tenor entry late here" }).click();
    await expect(desk.getByRole("button", { name: "comments1" })).toBeVisible();
    await expect(desk.locator('[data-comment][data-resolved="true"]')).toHaveCount(1);
    await expect(desk.locator("[data-comment-tick]")).toHaveCount(2);
    await expect(desk.locator('[data-comment-tick][data-resolved="true"]')).toHaveCount(1);
    await desk.getByRole("button", { name: /^open$/i }).click();
    await expect(desk.locator("[data-comment]")).toHaveCount(1);
    await expect(desk.locator(`[data-comment="${second.id}"]`)).toHaveCount(0);
    await desk.getByRole("button", { name: /^all$/i }).click();
    await expect(desk.locator("[data-comment]")).toHaveCount(2);

    // --- comments survive a desk reload (localStorage + OPFS rebuild) ---------
    await desk.reload();
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();
    await expectTakeLoaded(desk, takeId, 1);
    await expect(desk.locator("[data-comment-tick]")).toHaveCount(2, { timeout: 15_000 });
    await expect(desk.locator('[data-comment-tick][data-resolved="true"]')).toHaveCount(1);
    await desk.getByRole("button", { name: /^comments/ }).click();
    await expect(desk.locator("[data-comment]")).toHaveCount(2);
    await expect(desk.getByRole("button", { name: "comments1" })).toBeVisible();
    await expect(desk.getByLabel("Comment author")).toHaveValue("Maestra");
    const reloaded = await uiComments(desk);
    expect(reloaded.map((c) => c.text)).toEqual([
      "alto flat in the second phrase",
      "tenor entry late here",
    ]);
    expect((reloaded[0] as UiComment).resolvedAtMs).toBeNull();
    expect((reloaded[1] as UiComment).resolvedAtMs).not.toBeNull();
    expect((reloaded[1] as UiComment).streamId).toBe(streamId);

    // --- delete (hover affordance) removes row + tick --------------------------
    const resolvedRow = desk.locator('[data-comment][data-resolved="true"]');
    await resolvedRow.hover();
    await resolvedRow.getByRole("button", { name: /^Delete comment/ }).click();
    await expect(desk.locator("[data-comment]")).toHaveCount(1);
    await expect(desk.locator("[data-comment-tick]")).toHaveCount(1);
    expect((await uiComments(desk)).map((c) => c.text)).toEqual(["alto flat in the second phrase"]);

    await phone.close();
    await desk.close();
  });
});
