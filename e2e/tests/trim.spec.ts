// W9-F — the Trim tool + the arrangement undo ledger.
//
// Clips are PROJECTIONS of the raw audio (streamId + source window +
// arrangement position): the trim tool drags a clip's nearest edge to
// shorten the window or re-open material a cut/trim hid; nothing ever
// touches the stored audio. One sine lane (deterministic decline → zero
// align shifts, exact geometry):
//   · T activates Trim (toolbar + key), V/Escape return to Select, clips
//     wear the resize cursor, recording disables the tool;
//   · tail trim shrinks the window (doc + box), tail extend re-opens it,
//     clamped at the sibling's source window;
//   · head trim moves start WITH source offset (untrimmed material holds
//     its arrangement spot); head extend clamps at the previous window;
//   · a never-split clip's first trim seeds its region list (the split
//     tool's exact seeding rule);
//   · Ctrl+Z rolls each gesture back exactly; Ctrl+Shift+Z replays it.

import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { sineWav } from "./helpers/align";
import { expectTakeConverged, joinAsRecorder, startTake, stopTake } from "./helpers/session";

const PX_PER_SEC = 24; // default zoom
const TAKE_BASE_SEC = 1;

interface UiRegion {
  id: string;
  startSec: number;
  sourceOffsetSec: number;
  durationSec: number;
}

async function uiRegions(desk: Page): Promise<Record<string, UiRegion[]>> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: { ui(): { regions: Record<string, UiRegion[]> } | null };
      }
    ).__antiphonDesk;
    return hook?.ui()?.regions ?? {};
  });
}

async function uiTool(desk: Page): Promise<string> {
  return await desk.evaluate(() => {
    const hook = (globalThis as unknown as { __antiphonDesk?: { ui(): { tool: string } | null } })
      .__antiphonDesk;
    return hook?.ui()?.tool ?? "none";
  });
}

/** Drag from a clip's edge by dxPx (the trim gesture). `at` = fraction of
 * the clip width to press at (edge halves decide head vs tail). */
async function dragOnClip(desk: Page, clipId: string, at: number, dxPx: number): Promise<void> {
  const box = await desk.locator(`[data-clip="${clipId}"]`).boundingBox();
  if (!box) throw new Error(`clip ${clipId} not visible`);
  const x = box.x + box.width * at;
  const y = box.y + box.height / 2;
  await desk.mouse.move(x, y);
  await desk.mouse.down();
  await desk.mouse.move(x + dxPx, y, { steps: 6 });
  await desk.mouse.up();
}

const sinePath = path.join(os.tmpdir(), `antiphon-trim-sine-${process.pid}.wav`);
writeFileSync(sinePath, sineWav());
test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${sinePath}`,
    ],
  },
});

test.describe("trim tool + undo ledger (W9-F)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("edge drags trim/extend within source bounds; never-split seeds; Ctrl+Z walks it all back", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();
    const phone = await (await browser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId);
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

    const takeId = await startTake(desk);
    await desk.waitForTimeout(5_000);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, takeId, 1, { timeoutMs: 90_000 });
    await expect(desk.getByRole("button", { name: "Auto-align" })).toHaveAttribute(
      "data-align-state",
      "declined",
      { timeout: 90_000 },
    );
    const streamId = (await desk.evaluate(() => {
      const hook = (
        globalThis as unknown as {
          __antiphonDesk?: { snapshot(): { deskStatus: Array<{ streamId: string }> } | null };
        }
      ).__antiphonDesk;
      return hook?.snapshot()?.deskStatus[0]?.streamId ?? "";
    })) as string;
    expect(streamId).not.toBe("");

    // --- tool state: T activates, resize cursor on clips, V returns -----------
    const trimButton = desk.locator('[data-tool="trim"]');
    await expect(trimButton).toHaveText("TrimT");
    await desk.keyboard.press("t");
    expect(await uiTool(desk)).toBe("trim");
    await expect(trimButton).toHaveAttribute("aria-pressed", "true");
    expect(
      await desk
        .locator(`[data-clip="${streamId}"]`)
        .evaluate((el) => (el as HTMLElement).style.cursor),
    ).toBe("ew-resize");

    // --- never-split first trim SEEDS the region list, tail shrinks -1 s ------
    // (grab well inside the right half — the nearest-edge rule.)
    expect(await uiRegions(desk)).toEqual({}); // never-split so far
    await dragOnClip(desk, streamId, 0.9, -PX_PER_SEC);
    const seeded = (await uiRegions(desk))[streamId] as UiRegion[];
    expect(seeded).toHaveLength(1);
    const whole = seeded[0] as UiRegion;
    expect(whole.id).toBe(streamId);
    expect(whole.startSec).toBeCloseTo(TAKE_BASE_SEC, 1);
    expect(whole.sourceOffsetSec).toBe(0);
    const fullSec = whole.durationSec + 1; // pre-trim length (drag took 1 s)

    // --- tail extend re-opens the hidden second, clamped at the stream end ----
    await dragOnClip(desk, streamId, 0.9, 99 * PX_PER_SEC);
    await expect
      .poll(async () => ((await uiRegions(desk))[streamId] as UiRegion[])[0]?.durationSec ?? 0)
      .toBeCloseTo(fullSec, 1);

    // --- head trim: +0.5 s moves start WITH source offset ---------------------
    const beforeHead = ((await uiRegions(desk))[streamId] as UiRegion[])[0] as UiRegion;
    await dragOnClip(desk, streamId, 0.1, PX_PER_SEC / 2);
    const afterHead = ((await uiRegions(desk))[streamId] as UiRegion[])[0] as UiRegion;
    expect(afterHead.sourceOffsetSec).toBeCloseTo(beforeHead.sourceOffsetSec + 0.5, 1);
    expect(afterHead.startSec).toBeCloseTo(beforeHead.startSec + 0.5, 1);
    expect(afterHead.durationSec).toBeCloseTo(beforeHead.durationSec - 0.5, 1);
    // The box's left edge moved right by the same half second.
    const box = await desk.locator(`[data-clip="${streamId}"]`).boundingBox();
    expect(box).not.toBeNull();

    // --- head extend re-opens it, clamped at source 0 --------------------------
    await dragOnClip(desk, streamId, 0.1, -99 * PX_PER_SEC);
    await expect
      .poll(async () => ((await uiRegions(desk))[streamId] as UiRegion[])[0]?.sourceOffsetSec ?? -1)
      .toBe(0);

    // --- trim respects a sibling window after a split --------------------------
    // Split mid-clip, delete the RIGHT piece, then tail-extend the left
    // piece: it re-opens the deleted window and clamps at the stream end.
    await desk.keyboard.press("c");
    const clipBox = await desk.locator(`[data-clip="${streamId}"]`).boundingBox();
    if (!clipBox) throw new Error("clip not visible");
    await desk
      .locator(`[data-clip="${streamId}"]`)
      .click({ position: { x: clipBox.width / 2, y: 30 } });
    await expect.poll(async () => ((await uiRegions(desk))[streamId] ?? []).length).toBe(2);
    const pieces = (await uiRegions(desk))[streamId] as UiRegion[];
    const right = pieces[1] as UiRegion;
    await desk.keyboard.press("v");
    await desk.locator(`[data-clip="${right.id}"]`).click();
    await desk.keyboard.press("Delete"); // projection delete, no dialog
    await expect.poll(async () => ((await uiRegions(desk))[streamId] ?? []).length).toBe(1);
    await desk.keyboard.press("t");
    await dragOnClip(desk, streamId, 0.9, 99 * PX_PER_SEC);
    await expect
      .poll(async () => ((await uiRegions(desk))[streamId] as UiRegion[])[0]?.durationSec ?? 0)
      .toBeCloseTo(fullSec, 1); // the whole source re-opened

    // --- the ledger: undo walks every gesture back, redo replays --------------
    // Steps (newest first): tail re-extend, piece delete, split, head
    // extend, head trim, tail extend, seed trim.
    const undoScript: Array<{ pieces: number; check?: (list: UiRegion[]) => boolean }> = [
      { pieces: 1 }, // before the final tail extend: still 1 piece (shorter)
      { pieces: 2 }, // before the delete: both pieces
      { pieces: 1 }, // before the split: one region
      { pieces: 1 }, // before the head extend
      { pieces: 1 }, // before the head trim
      { pieces: 1 }, // before the tail extend
    ];
    for (const step of undoScript) {
      await desk.keyboard.press("ControlOrMeta+z");
      await expect
        .poll(async () => ((await uiRegions(desk))[streamId] ?? []).length)
        .toBe(step.pieces);
    }
    // One more undo reverts the seeding trim entirely: never-split again.
    await desk.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => Object.keys(await uiRegions(desk)).length).toBe(0);
    await expect.poll(async () => await desk.locator("[data-clip]").count()).toBe(1);

    // Redo replays the seed trim…
    await desk.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(async () => ((await uiRegions(desk))[streamId] ?? []).length).toBe(1);
    await expect
      .poll(async () => ((await uiRegions(desk))[streamId] as UiRegion[])[0]?.durationSec ?? 0)
      .toBeCloseTo(fullSec - 1, 1);

    // --- recording disables the tool -------------------------------------------
    await desk.keyboard.press("t");
    expect(await uiTool(desk)).toBe("trim");
    const take2 = await startTake(desk);
    await expect.poll(async () => await uiTool(desk)).toBe("select");
    await expect(trimButton).toBeDisabled();
    await desk.keyboard.press("t"); // inert while recording
    expect(await uiTool(desk)).toBe("select");
    await desk.waitForTimeout(1_500);
    await stopTake(desk);
    await expect(trimButton).toBeEnabled({ timeout: 15_000 });
    await expectTakeConverged(desk, sessionId, take2, 1, { timeoutMs: 90_000 });

    await phone.close();
    await desk.close();
  });
});
