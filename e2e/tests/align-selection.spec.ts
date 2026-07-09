// W7-A — selection-aware auto-align + re-align over manual moves (the
// operator's ask), on the content-align capture shape (two staggered
// chirpless captures of the same music-like performance — accepts by
// construction, helpers/align.ts musicLikeWav).
//
// Test 1 (one take):
//   (c) NO selection → the button keeps the whole-take force re-align:
//       both lanes re-measure, the persisted record's `at` stamp bumps,
//       and no manual-offset note appears (there was nothing to reset).
//   (a) drag a pre-aligned clip away, select it (the drag press selects),
//       click auto-align → its arrange override is cleared cross-desk,
//       the box returns to the aligned position, the chip notes
//       "manual offsets reset · 1 clip", the UNSELECTED lane's verdict
//       entry survives byte-identical (scoped re-measure), and the
//       RENDERED residual between the lanes reads ≈ 0 — the consistency
//       invariant, measured in signal.
//
// Test 2 (two takes):
//   (d) draw-all-aligned: with take 2 loaded, take 1's boxes compose its
//       PERSISTED verdict — separated by exactly the stored head-trim
//       spread — without take 1 being loaded (the W6 follow-up fold-in).
//   (b) a selection spanning both takes realigns BOTH (fresh `at` stamps
//       in both records), progress reads "aligning take N/2…", the
//       originally loaded take is restored after, and the selection
//       stays sticky.

import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  clipLefts,
  expectTakeLoaded,
  measureLaneOffset,
  musicLikeWav,
  SAMPLE_RATE,
} from "./helpers/align";
import {
  expectTakeConverged,
  joinAsRecorder,
  startTake,
  stopTake,
  uiSelection,
} from "./helpers/session";

const wavPath = path.join(os.tmpdir(), `antiphon-align-selection-${process.pid}.wav`);
writeFileSync(wavPath, musicLikeWav());

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${wavPath}`,
    ],
  },
});

interface RecordEntry {
  alignment: { lagSamples: number; confidence: number; applied: boolean; method?: string };
}

interface RecordView {
  at: number;
  entries: Record<string, RecordEntry>;
}

/** The take's persisted verdict record from the shared doc (W7-A hook). */
async function alignmentRecord(desk: Page, takeId: string): Promise<RecordView | null> {
  return await desk.evaluate((tid) => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: {
          alignmentRecord(takeId: string): {
            at: number;
            entries: Record<
              string,
              {
                alignment: {
                  lagSamples: number;
                  confidence: number;
                  applied: boolean;
                  method?: string;
                };
              }
            >;
          } | null;
        };
      }
    ).__antiphonDesk;
    return hook?.alignmentRecord(tid) ?? null;
  }, takeId);
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

async function clipStarts(desk: Page): Promise<Record<string, number>> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: { ui(): { clipStarts: Record<string, number> } | null };
      }
    ).__antiphonDesk;
    return hook?.ui()?.clipStarts ?? {};
  });
}

/** Persisted head-trim spread of a two-lane content verdict, in seconds
 * (content lags never wrap — the raw diff IS the anchor the desk draws
 * with; 0 when fewer than two applied entries composed). */
function recordSpreadSec(record: RecordView | null): number {
  if (!record) return 0;
  const lags = Object.values(record.entries)
    .filter((e) => e.alignment.applied)
    .map((e) => e.alignment.lagSamples);
  if (lags.length < 2) return 0;
  return (Math.max(...lags) - Math.min(...lags)) / SAMPLE_RATE;
}

const PX_PER_SEC = 24;

test.describe("selection-aware auto-align (W7-A)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("no-selection keeps whole-take realign; drag-then-realign resets the move and restores alignment", async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const sessionId = crypto.randomUUID();

    const deskContext = await browser.newContext();
    const desk = await deskContext.newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phoneA = await (await browser.newContext()).newPage();
    await joinAsRecorder(phoneA, sessionId);
    await desk.waitForTimeout(1_500);
    const phoneB = await (await browser.newContext()).newPage();
    await joinAsRecorder(phoneB, sessionId);
    await expect(desk.getByText("2 phones connected")).toBeVisible({ timeout: 15_000 });

    const takeId = await startTake(desk);
    await desk.waitForTimeout(12_000);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, takeId, 2, { timeoutMs: 90_000 });
    await expectTakeLoaded(desk, takeId, 30_000);
    const alignButton = desk.getByRole("button", { name: "Auto-align" });
    await expect(alignButton).toHaveAttribute("data-align-state", "aligned", { timeout: 90_000 });
    const record0 = (await alignmentRecord(desk, takeId)) as RecordView;
    expect(record0).not.toBeNull();

    // ---- (c) NO selection: the button re-runs the WHOLE take -------------
    await expect.poll(async () => (await uiSelection(desk)).length).toBe(0);
    await alignButton.click();
    // No manual offsets existed → no reset note, ever.
    await expect(desk.getByTestId("align-note")).toHaveCount(0);
    // The re-measure lands a FRESH persisted record (newer `at`) with the
    // same two applied verdicts — behavior identical to pre-W7-A plus the
    // (empty) reset.
    await expect
      .poll(async () => (await alignmentRecord(desk, takeId))?.at ?? 0, { timeout: 60_000 })
      .toBeGreaterThan(record0.at);
    await expect(alignButton).toHaveAttribute("data-align-state", "aligned", { timeout: 60_000 });
    await expect(desk.getByTestId("align-outcome")).toContainText(/2 tracks aligned/i);

    // ---- (a) drag a pre-aligned clip away, realign it back ---------------
    const ids = [...(await clipLefts(desk)).keys()].sort();
    const dragId = ids[0] as string;
    const otherId = ids[1] as string;
    const baselineX = (await clipLefts(desk)).get(dragId) as number;
    const clip = desk.locator(`[data-clip="${dragId}"]`);
    const box = await clip.boundingBox();
    if (!box) throw new Error("clip not visible");
    await desk.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await desk.mouse.down();
    await desk.mouse.move(box.x + box.width / 2 + 2 * PX_PER_SEC, box.y + box.height / 2, {
      steps: 8,
    });
    await desk.mouse.up();
    // The drag moved the box, wrote the override, and SELECTED the clip
    // (a press selects — the selection scope for the realign).
    const draggedX = (await clipLefts(desk)).get(dragId) as number;
    expect(Math.abs(draggedX - baselineX - 2 * PX_PER_SEC)).toBeLessThan(2);
    expect((await clipStarts(desk))[dragId]).toBeGreaterThan(0);
    await expect.poll(async () => await uiSelection(desk)).toEqual([dragId]);
    const recordBefore = (await alignmentRecord(desk, takeId)) as RecordView;
    // HONESTY NOTE (QA): this pin covers the persist path only — the kept
    // lane's ALIGNMENT verdict travels the settle→doc write unchanged.
    // It cannot prove scoping by itself (the DSP is deterministic, so a
    // whole-take re-measure of identical audio reproduces identical
    // bytes); scoping proper is unit-pinned (player.test.ts "scoped align
    // (W7-A)": probe-call counts + kept-verdict identity). Alignment
    // sub-object only: drift fields legitimately rewrite when a scoped
    // run's estimateDrift re-derives the reference.
    const keptBefore = JSON.stringify(recordBefore.entries[otherId]?.alignment);

    await alignButton.click();
    // The reset is immediate and honest: override gone, note says so.
    await expect(desk.getByTestId("align-note")).toHaveText("manual offsets reset · 1 clip");
    await expect.poll(async () => (await clipStarts(desk))[dragId]).toBeUndefined();
    // Fresh scoped verdict persisted; the box is back at its aligned spot.
    await expect
      .poll(async () => (await alignmentRecord(desk, takeId))?.at ?? 0, { timeout: 60_000 })
      .toBeGreaterThan(recordBefore.at);
    await expect(alignButton).toHaveAttribute("data-align-state", "aligned", { timeout: 60_000 });
    await expect
      .poll(async () => Math.abs(((await clipLefts(desk)).get(dragId) as number) - baselineX))
      .toBeLessThan(2);
    // The UNSELECTED lane's alignment verdict survived the persist path
    // byte-identical (scope of this pin: see the honesty note above).
    const recordAfter = (await alignmentRecord(desk, takeId)) as RecordView;
    expect(JSON.stringify(recordAfter.entries[otherId]?.alignment)).toBe(keptBefore);
    expect(recordAfter.entries[dragId]?.alignment.applied).toBe(true);
    // Selection stayed sticky through the flow.
    await expect.poll(async () => await uiSelection(desk)).toEqual([dragId]);

    // THE audible proof: after drag → realign, the rendered lanes carry no
    // residual (the mixed kept+fresh verdicts share one lag domain). A
    // realign that lost the reference would read the ±2 s drag or the
    // capture stagger here.
    const residual = await measureLaneOffset(desk, 6, 1);
    expect(Math.abs(residual.lagSec)).toBeLessThanOrEqual(0.05);
    expect(residual.r).toBeGreaterThan(0.9);

    await phoneA.close();
    await phoneB.close();
    await desk.close();
    await deskContext.close();
  });

  test("cross-take selection realigns both takes and restores the loaded one; neighbors draw their persisted shifts", async ({
    browser,
  }) => {
    test.setTimeout(360_000);
    const sessionId = crypto.randomUUID();

    const deskContext = await browser.newContext();
    const desk = await deskContext.newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phoneA = await (await browser.newContext()).newPage();
    await joinAsRecorder(phoneA, sessionId);
    await desk.waitForTimeout(1_500);
    const phoneB = await (await browser.newContext()).newPage();
    await joinAsRecorder(phoneB, sessionId);
    await expect(desk.getByText("2 phones connected")).toBeVisible({ timeout: 15_000 });

    const alignButton = desk.getByRole("button", { name: "Auto-align" });
    const takeStreams: Record<string, string[]> = {};
    const takeIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const takeId = await startTake(desk);
      takeIds.push(takeId);
      await desk.waitForTimeout(12_000);
      await stopTake(desk);
      const { deskStreams } = await expectTakeConverged(desk, sessionId, takeId, 2, {
        timeoutMs: 90_000,
      });
      takeStreams[takeId] = deskStreams.map((s) => s.streamId).sort();
      // Each take auto-loads and aligns as it completes — its verdict
      // persists to the doc before the next one starts.
      await expectTakeLoaded(desk, takeId, 60_000);
      await expect(alignButton).toHaveAttribute("data-align-state", "aligned", {
        timeout: 90_000,
      });
    }
    const [take1, take2] = takeIds as [string, string];

    // ---- (d) draw-all-aligned: take 1 is the UNLOADED neighbor now, and
    // its boxes must compose its PERSISTED verdict — separated by exactly
    // the stored head-trim spread (both clips share the take slot, no
    // overrides). Pre-W7-A they drew at the same x. The LATER starter's
    // (smaller lag) box sits right of the earlier starter's by the spread.
    expect(await loadedTakeId(desk)).toBe(take2);
    const record1 = (await alignmentRecord(desk, take1)) as RecordView;
    const spread1 = recordSpreadSec(record1);
    expect(spread1).toBeGreaterThan(1.4); // the deliberate join stagger
    const [s1a, s1b] = takeStreams[take1] as [string, string];
    const lagOf = (id: string) => record1.entries[id]?.alignment.lagSamples ?? 0;
    const earlier = lagOf(s1a) >= lagOf(s1b) ? s1a : s1b; // max lag = most pre-roll
    const later = earlier === s1a ? s1b : s1a;
    const lefts = await clipLefts(desk);
    const separation = ((lefts.get(later) as number) - (lefts.get(earlier) as number)) / PX_PER_SEC;
    expect(Math.abs(separation - spread1)).toBeLessThan(0.1);

    // ---- (b) select clips across BOTH takes, realign ---------------------
    const allIds = [...(takeStreams[take1] as string[]), ...(takeStreams[take2] as string[])];
    await desk.locator(`[data-clip="${allIds[0]}"]`).click();
    for (const id of allIds.slice(1)) {
      await desk.locator(`[data-clip="${id}"]`).click({ modifiers: ["Shift"] });
    }
    await expect.poll(async () => await uiSelection(desk)).toEqual([...allIds].sort());
    const at1 = ((await alignmentRecord(desk, take1)) as RecordView).at;
    const at2 = ((await alignmentRecord(desk, take2)) as RecordView).at;

    await alignButton.click();
    // The flow walks the takes sequentially — progress surfaces in the
    // chip slot while it runs (loaded take 2 first, then take 1).
    await expect(desk.getByTestId("align-outcome")).toContainText(/aligning take [12]\/2…/, {
      timeout: 60_000,
    });
    // Both takes' verdicts come back FRESH (newer `at` stamps, applied)…
    await expect
      .poll(async () => ((await alignmentRecord(desk, take1)) as RecordView).at, {
        timeout: 120_000,
      })
      .toBeGreaterThan(at1);
    await expect
      .poll(async () => ((await alignmentRecord(desk, take2)) as RecordView).at, {
        timeout: 120_000,
      })
      .toBeGreaterThan(at2);
    // …the originally loaded take comes back once the flow settles…
    await expect.poll(async () => await loadedTakeId(desk), { timeout: 120_000 }).toBe(take2);
    await expect(alignButton).toHaveAttribute("data-align-state", "aligned", { timeout: 60_000 });
    for (const takeId of takeIds) {
      const record = (await alignmentRecord(desk, takeId)) as RecordView;
      for (const streamId of takeStreams[takeId] as string[]) {
        expect(record.entries[streamId]?.alignment.applied, `${takeId}/${streamId} applied`).toBe(
          true,
        );
      }
    }
    // …and the selection stayed sticky through loads and restore.
    await expect.poll(async () => await uiSelection(desk)).toEqual([...allIds].sort());

    // The neighbor's boxes still compose the (fresh) persisted spread.
    const freshSpread = recordSpreadSec((await alignmentRecord(desk, take1)) as RecordView);
    const leftsAfter = await clipLefts(desk);
    const separationAfter =
      ((leftsAfter.get(later) as number) - (leftsAfter.get(earlier) as number)) / PX_PER_SEC;
    expect(Math.abs(separationAfter - freshSpread)).toBeLessThan(0.1);

    await phoneA.close();
    await phoneB.close();
    await desk.close();
    await deskContext.close();
  });
});
