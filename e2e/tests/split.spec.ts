// W7-B — the Split/Cut tool + clip regions (operator ask: "C activates
// Split; clicking a track splits the take there; split all lanes at the
// cursor; V returns to Select; split cursor icon").
//
// Two sine lanes — the deterministic-DECLINE fixture, so align shifts are
// zero and every geometry assertion is exact:
//   · tool state: C activates Split (toolbar button wears the accent with
//     white text — the prototype's active styling), V and Escape return to
//     Select, the toolbar click path works too, and C no longer opens the
//     comments composer (N does — the key moved);
//   · clip click cuts THAT region at the pointer: two boxes whose lefts
//     and widths continue the original geometry exactly;
//   · a ruler click cuts EVERY lane crossing that x;
//   · pieces drag individually (the sibling holds its spot) and the move
//     lands in the shared doc's regions map;
//   · everything — boxes and doc lists — survives a desk reload;
//   · recording disables the tool (auto-revert + inert C + disabled button);
//   · Delete is a PROJECTION edit (W9-F): no dialog, the clip leaves the
//     arrangement while the raw audio stays archived (an emptied stream
//     reads present-and-empty); Ctrl+Z / Ctrl+Shift+Z walk the ledger;
//     Shift+Delete stays the durable rows+blobs path behind the F2 confirm;
//   · re-align over a selection holding a split PIECE (W7-A × W7-B seam,
//     REVISED by W9-E): the piece's whole stream enters the align scope;
//     its CUTS (ids, source windows) survive untouched but its pieces
//     snap back to source-true positions (take slot + source offset) —
//     piece positions are manual moves like any drag, and that reset is
//     exactly what lines the waveforms up. The frozen pre-split arrange
//     key still survives (old desks' view must not move; the stream is
//     dragged BEFORE splitting so the frozen key exists — QA seam
//     hardening) and the chip note counts every clip that moved.
//
// The audible half — a fresh split playing seamlessly across its boundary,
// and render parity — lives in split-playback.spec.ts (it needs the
// beep-grid fake mic, and launchOptions are per-file).

import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { clipLefts, sineWav } from "./helpers/align";
import {
  expectTakeConverged,
  joinAsRecorder,
  serverTakeStreams,
  startTake,
  stopTake,
} from "./helpers/session";

const PX_PER_SEC = 24; // default zoom
const SAMPLE_RATE = 48_000;
const TAKE_BASE_SEC = 1;

// ---- desk hook readers -------------------------------------------------------

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

async function expectTakeLoaded(desk: Page, takeId: string, tracks: number): Promise<void> {
  await expect
    .poll(
      async () =>
        await desk.evaluate(() => {
          const hook = (
            globalThis as unknown as {
              __antiphonDesk?: {
                playerSnapshot(): { loadedTakeId: string | null; tracks: unknown[] } | null;
              };
            }
          ).__antiphonDesk;
          const snap = hook?.playerSnapshot();
          return `take=${snap?.loadedTakeId ?? null} tracks=${snap?.tracks.length ?? 0}`;
        }),
      { timeout: 60_000 },
    )
    .toBe(`take=${takeId} tracks=${tracks}`);
}

/** Clip box widths in px, keyed by region id (clipLefts' width twin). */
async function clipWidths(desk: Page): Promise<Map<string, number>> {
  const entries = await desk.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-clip]")].map((el) => [
      el.dataset.clip as string,
      Number.parseFloat(el.style.width || "0"),
    ]),
  );
  return new Map(entries as Array<[string, number]>);
}

// =============== Test 1 — tool state, geometry, persistence =====================

// The flat-sine fixture (helpers/align.ts): content alignment declines by
// construction, so align shifts/anchor are ZERO and box geometry below is
// exact arithmetic on region seconds — no stagger fuzz. (test.use with
// launchOptions must be file-level; the beep-grammar playback test lives
// in split-playback.spec.ts for the same reason.)
const sinePath = path.join(os.tmpdir(), `antiphon-split-sine-${process.pid}.wav`);
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

test.describe("split tool — activation, geometry, persistence (W7-B)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("C/V/Escape + toolbar switch tools; clip and ruler cuts land exactly; pieces drag and persist; recording disables; delete is honest", async ({
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
    const phoneB = await (await browser.newContext()).newPage();
    await joinAsRecorder(phoneB, sessionId);
    await expect(desk.getByText("2 phones connected")).toBeVisible({ timeout: 15_000 });

    const takeId = await startTake(desk);
    await desk.waitForTimeout(5_000);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, takeId, 2, { timeoutMs: 90_000 });
    await expectTakeLoaded(desk, takeId, 2);
    // Alignment settles DECLINED on the sine fixture → shift/anchor 0.
    await expect(desk.getByRole("button", { name: "Auto-align" })).toHaveAttribute(
      "data-align-state",
      "declined",
      { timeout: 90_000 },
    );

    // Two lanes, streamId-keyed clips; per-stream durations from the sink
    // (totalSamples rides the snapshot beyond the helper's typed subset).
    const streams = await desk.evaluate((wantedTakeId) => {
      const hook = (
        globalThis as unknown as {
          __antiphonDesk?: {
            snapshot(): {
              deskStatus: Array<{ streamId: string; takeId: string; totalSamples: number }>;
            } | null;
          };
        }
      ).__antiphonDesk;
      return (hook?.snapshot()?.deskStatus ?? []).filter((s) => s.takeId === wantedTakeId);
    }, takeId);
    const durOf = new Map(
      streams.map((s) => [s.streamId, Math.max(s.totalSamples / SAMPLE_RATE, 1)]),
    );
    const [streamA, streamB] = streams.map((s) => s.streamId).sort() as [string, string];
    const overrideOf = async (streamId: string) =>
      await desk.evaluate((sid) => {
        const hook = (
          globalThis as unknown as {
            __antiphonDesk?: { ui(): { clipStarts: Record<string, number> } | null };
          }
        ).__antiphonDesk;
        return hook?.ui()?.clipStarts[sid] ?? null;
      }, streamId);

    // --- manually move stream A BEFORE splitting it (QA seam hardening) --------
    // The +1 s select-mode drag writes an `arrange` override that the first
    // split FREEZES (collab-doc compat stance). The re-align block at the
    // end pins the PM decision against exactly this state: the frozen key
    // must survive a forced re-align untouched — pre-seam code deleted it
    // and counted stream A in the reset note.
    const boxA0 = await desk.locator(`[data-clip="${streamA}"]`).boundingBox();
    if (!boxA0) throw new Error("stream A clip not visible");
    await desk.mouse.move(boxA0.x + boxA0.width / 2, boxA0.y + boxA0.height / 2);
    await desk.mouse.down();
    await desk.mouse.move(boxA0.x + boxA0.width / 2 + PX_PER_SEC, boxA0.y + boxA0.height / 2, {
      steps: 6,
    });
    await desk.mouse.up();
    await expect.poll(async () => await overrideOf(streamA)).not.toBeNull();
    // Stream A's arrangement base for every geometry assertion below (the
    // exact override value the split will seed startSecs from).
    const aBase = (await overrideOf(streamA)) as number;
    expect(aBase).toBeCloseTo(TAKE_BASE_SEC + 1, 1);

    // --- tool state: select by default; C activates Split ---------------------
    const selectButton = desk.locator('[data-tool="select"]');
    const splitButton = desk.locator('[data-tool="split"]');
    expect(await uiTool(desk)).toBe("select");
    await expect(selectButton).toHaveAttribute("aria-pressed", "true");
    await expect(splitButton).toHaveAttribute("aria-pressed", "false");
    // Displayed key hints: V for Select, C for Split (the operator's key —
    // not the prototype's S, which belongs to lane-solo).
    await expect(selectButton).toHaveText("SelectV");
    await expect(splitButton).toHaveText("SplitC");

    await desk.keyboard.press("c");
    expect(await uiTool(desk)).toBe("split");
    await expect(splitButton).toHaveAttribute("aria-pressed", "true");
    await expect(selectButton).toHaveAttribute("aria-pressed", "false");
    // Prototype active styling: accent bg (#2e8bff), white text — polled
    // past the button's transition-colors ramp.
    await expect
      .poll(async () =>
        splitButton.evaluate((el) => {
          const s = getComputedStyle(el);
          return `${s.backgroundColor} / ${s.color}`;
        }),
      )
      .toBe("rgb(46, 139, 255) / rgb(255, 255, 255)");
    // …and the inactive tool sits transparent.
    await expect
      .poll(async () => selectButton.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe("rgba(0, 0, 0, 0)");
    // C no longer opens the comments composer — the comments tab never
    // opened, so the composer isn't even rendered (N is the key now, and
    // the comments.spec journey pins the N path end-to-end).
    await expect(desk.getByLabel("Comment text")).toHaveCount(0);
    // The timeline surface AND the clips wear the blade cursor (data-URI
    // scissors, col-resize fallback); the clips' grab cursor is suppressed.
    const surfaceCursor = await desk
      .locator("section > div[role='presentation']")
      .first()
      .evaluate((el) => (el as HTMLElement).style.cursor);
    expect(surfaceCursor).toContain("data:image/svg+xml");
    expect(surfaceCursor).toContain("col-resize");
    const clipCursor = await desk
      .locator(`[data-clip="${streamA}"]`)
      .evaluate((el) => (el as HTMLElement).style.cursor);
    expect(clipCursor).toContain("data:image/svg+xml");

    // --- V returns to Select; Escape exits too; toolbar click activates -------
    await desk.keyboard.press("v");
    expect(await uiTool(desk)).toBe("select");
    await desk.keyboard.press("c");
    expect(await uiTool(desk)).toBe("split");
    await desk.keyboard.press("Escape");
    expect(await uiTool(desk)).toBe("select");
    await splitButton.click();
    expect(await uiTool(desk)).toBe("split");
    await expect(splitButton).toHaveAttribute("aria-pressed", "true");

    // --- clip click cuts THAT region at the pointer ----------------------------
    // Cut stream A 2 s into its box. Sine lanes: shift 0 → box left is
    // exactly the stream's arrangement base (aBase for the dragged A,
    // TAKE_BASE_SEC for B), so geometry is pure arithmetic.
    const boxA = await desk.locator(`[data-clip="${streamA}"]`).boundingBox();
    if (!boxA) throw new Error("stream A clip not visible");
    await desk.mouse.click(boxA.x + 2 * PX_PER_SEC, boxA.y + boxA.height / 2);
    await expect.poll(async () => Object.keys(await uiRegions(desk)).length).toBe(1); // only stream A split; B untouched (never-split stays absent)
    const afterClipCut = await uiRegions(desk);
    const aPieces = afterClipCut[streamA] as UiRegion[];
    expect(aPieces).toHaveLength(2);
    // The left piece KEEPS the streamId identity; the pieces abut in both
    // domains at exactly the click offset (mouse lands on integer px), and
    // the seeded startSecs baked A's pre-split drag (aBase).
    expect(aPieces[0]?.id).toBe(streamA);
    expect(aPieces[0]?.startSec).toBeCloseTo(aBase, 6);
    const cutA = aPieces[0]?.durationSec as number;
    expect(Math.abs(cutA - 2)).toBeLessThan(2 / PX_PER_SEC); // ≤1px quantization
    expect(aPieces[1]?.sourceOffsetSec).toBeCloseTo(cutA, 6);
    expect(aPieces[1]?.startSec).toBeCloseTo(aBase + cutA, 6);
    expect((aPieces[0]?.durationSec as number) + (aPieces[1]?.durationSec as number)).toBeCloseTo(
      durOf.get(streamA) as number,
      6,
    );
    // Box geometry: two boxes continuing the original run exactly.
    const lefts = await clipLefts(desk);
    const widths = await clipWidths(desk);
    const rightAId = aPieces[1]?.id as string;
    expect(lefts.get(streamA)).toBeCloseTo(aBase * PX_PER_SEC, 3);
    expect(widths.get(streamA)).toBeCloseTo(cutA * PX_PER_SEC - 3, 3);
    expect(lefts.get(rightAId)).toBeCloseTo((aBase + cutA) * PX_PER_SEC, 3);
    expect(widths.get(rightAId)).toBeCloseTo(
      ((durOf.get(streamA) as number) - cutA) * PX_PER_SEC - 3,
      3,
    );
    // Stream B still renders its single (unsplit) box.
    expect(lefts.has(streamB)).toBe(true);
    expect(await desk.locator("[data-clip]").count()).toBe(3);

    // --- ruler click cuts EVERY lane crossing that x ---------------------------
    // x = TAKE_BASE_SEC + 3.5 crosses stream A's RIGHT piece (A sits at
    // aBase after its drag) and stream B's whole clip: after the cut A has
    // 3 pieces, B has 2 — each cut at ITS OWN source position under the
    // one drawn hairline.
    const rulerCutSec = TAKE_BASE_SEC + 3.5;
    await desk.locator("[data-ruler]").click({ position: { x: rulerCutSec * PX_PER_SEC, y: 22 } });
    await expect.poll(async () => await desk.locator("[data-clip]").count()).toBe(5);
    const afterRuler = await uiRegions(desk);
    expect(afterRuler[streamA]).toHaveLength(3);
    expect(afterRuler[streamB]).toHaveLength(2);
    // Every piece boundary sits at the SAME drawn x: source offsets equal
    // the ruler x minus each stream's own base.
    expect((afterRuler[streamA] as UiRegion[])[2]?.sourceOffsetSec).toBeCloseTo(
      rulerCutSec - aBase,
      1,
    );
    expect((afterRuler[streamB] as UiRegion[])[1]?.sourceOffsetSec).toBeCloseTo(
      rulerCutSec - TAKE_BASE_SEC,
      1,
    );
    // Stream A's wide tail piece (fresh id) — the re-align seam block's
    // selection target (the 0.5 s middle piece renders at the 26px
    // min-width and can sit under its neighbor's hit area).
    const aTailId = (afterRuler[streamA] as UiRegion[])[2]?.id as string;

    // --- pieces drag individually (V first: dragging is a Select behavior) ----
    await desk.keyboard.press("v");
    const bTailId = (afterRuler[streamB] as UiRegion[])[1]?.id as string;
    const bTailBox = await desk.locator(`[data-clip="${bTailId}"]`).boundingBox();
    if (!bTailBox) throw new Error("stream B tail piece not visible");
    const beforeDrag = await clipLefts(desk);
    await desk.mouse.move(bTailBox.x + bTailBox.width / 2, bTailBox.y + bTailBox.height / 2);
    await desk.mouse.down();
    await desk.mouse.move(
      bTailBox.x + bTailBox.width / 2 + 2 * PX_PER_SEC,
      bTailBox.y + bTailBox.height / 2,
      { steps: 8 },
    );
    await desk.mouse.up();
    const afterDrag = await clipLefts(desk);
    // The dragged piece moved 2 s right; its sibling held its spot.
    expect((afterDrag.get(bTailId) as number) - (beforeDrag.get(bTailId) as number)).toBeCloseTo(
      2 * PX_PER_SEC,
      0,
    );
    expect(afterDrag.get(streamB)).toBeCloseTo(beforeDrag.get(streamB) as number, 3);
    // …and the move landed in the doc's regions map (startSec only).
    const draggedRegions = await uiRegions(desk);
    const bTail = (draggedRegions[streamB] as UiRegion[]).find((r) => r.id === bTailId);
    const bTailBefore = (afterRuler[streamB] as UiRegion[]).find((r) => r.id === bTailId);
    expect((bTail?.startSec as number) - (bTailBefore?.startSec as number)).toBeCloseTo(2, 1);
    expect(bTail?.sourceOffsetSec).toBeCloseTo(bTailBefore?.sourceOffsetSec as number, 6);

    // --- reload: regions and box geometry come back (shared-doc persisted) ----
    // Settle the wire first: local doc writes coalesce on a 33 ms flush
    // timer (net/collab.ts UPDATE_FLUSH_MS) and ride a buffered WebSocket —
    // an immediate reload can drop the drag's tail updates before the
    // server applied them. There is no client-side observable for
    // "server holds my last write", so this one is an honest small sleep.
    await desk.waitForTimeout(1_000);
    const beforeReloadRegions = await uiRegions(desk);
    const beforeReloadLefts = await clipLefts(desk);
    await desk.reload();
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();
    await expectTakeLoaded(desk, takeId, 2);
    await expect
      .poll(async () => await uiRegions(desk), { timeout: 30_000 })
      .toEqual(beforeReloadRegions);
    await expect.poll(async () => await desk.locator("[data-clip]").count()).toBe(5);
    const reloadedLefts = await clipLefts(desk);
    for (const [id, left] of beforeReloadLefts) {
      expect(
        Math.abs((reloadedLefts.get(id) as number) - left),
        `box ${id} after reload`,
      ).toBeLessThan(1);
    }

    // --- Delete is a PROJECTION edit (W9-F): no dialog, Ctrl+Z restores -------
    // Clips are windows onto the raw audio; plain Delete only removes the
    // window. (The old durable-by-default rule read as a bug at the desk.)
    const beforeDeleteRegions = await uiRegions(desk);
    await desk.locator(`[data-clip="${bTailId}"]`).click();
    await expect(desk.locator(`[data-clip="${bTailId}"]`)).toHaveAttribute("data-selected", "true");
    await desk.keyboard.press("Delete");
    // No confirm dialog — the piece leaves the arrangement immediately…
    await expect(desk.getByRole("alertdialog")).toHaveCount(0);
    await expect.poll(async () => await desk.locator("[data-clip]").count()).toBe(4);
    const afterPieceDelete = await uiRegions(desk);
    expect(afterPieceDelete[streamB]).toHaveLength(1);
    expect((afterPieceDelete[streamB] as UiRegion[])[0]?.id).toBe(streamB);
    expect(afterPieceDelete[streamA]).toHaveLength(3);
    // …and the raw audio is untouched: the server still holds the stream.
    expect(
      (await serverTakeStreams(desk, sessionId, takeId)).some((s) => s.streamId === streamB),
      "stream B still archived after a clip delete",
    ).toBe(true);

    // Ctrl/Cmd+Z walks the ledger back EXACTLY; Ctrl/Cmd+Shift+Z replays.
    await desk.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => await desk.locator("[data-clip]").count()).toBe(5);
    expect(await uiRegions(desk)).toEqual(beforeDeleteRegions);
    await desk.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(async () => await desk.locator("[data-clip]").count()).toBe(4);

    // Deleting a stream's LAST clip leaves the honest empty projection —
    // present-and-empty in the doc (never "absent", which would resurrect
    // the whole clip), lane + archive stay, undo brings it back.
    await desk.locator(`[data-clip="${streamB}"]`).click();
    await desk.keyboard.press("Delete");
    await expect.poll(async () => await desk.locator("[data-clip]").count()).toBe(3);
    expect((await uiRegions(desk))[streamB]).toEqual([]);
    expect(
      (await serverTakeStreams(desk, sessionId, takeId)).some((s) => s.streamId === streamB),
      "stream B still archived with zero clips",
    ).toBe(true);
    await desk.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => await desk.locator("[data-clip]").count()).toBe(4);

    // --- Shift+Delete stays the DURABLE path, behind the F2 confirm -----------
    // (undo can't restore blobs, so THIS one keeps its dialog.)
    await desk.locator(`[data-clip="${streamB}"]`).click();
    await desk.keyboard.press("Shift+Delete");
    const durableDialog = desk.getByRole("alertdialog");
    await expect(durableDialog).toBeVisible();
    await expect(durableDialog.getByText("server rows and blobs", { exact: false })).toBeVisible();
    await desk.keyboard.press("Escape"); // cancel — keep the lane for the seam test
    await expect(durableDialog).not.toBeVisible();
    expect(await desk.locator("[data-clip]").count()).toBe(4);

    // --- recording disables the tool -------------------------------------------
    await desk.keyboard.press("c");
    expect(await uiTool(desk)).toBe("split");
    const take2Id = await startTake(desk);
    // Take-start auto-reverts to Select and the toolbar button disables.
    await expect.poll(async () => await uiTool(desk)).toBe("select");
    await expect(desk.locator('[data-tool="split"]')).toBeDisabled();
    await desk.keyboard.press("c"); // inert while recording
    expect(await uiTool(desk)).toBe("select");
    await desk.waitForTimeout(2_500);
    await stopTake(desk);
    await expect(desk.locator('[data-tool="split"]')).toBeEnabled({ timeout: 15_000 });

    // --- re-align resets split PIECES to source-true spots (W9-E) -------------
    // The W7-A×W7-B "positions preserved" parking read as a bug at the
    // desk (operator report: pieces never lined their waveforms up), so a
    // forced re-align now treats piece positions like any manual move:
    // every scoped piece returns to take slot + source offset — the same
    // zero a never-split clip returns to — while the CUTS (ids, source
    // windows) stay byte-identical and the frozen legacy arrange key
    // survives (old desks' pre-split view must not move). The chip note
    // counts every clip that actually moved.
    await expectTakeConverged(desk, sessionId, take2Id, 2, { timeoutMs: 90_000 });
    await expectTakeLoaded(desk, take2Id, 2); // latest complete auto-loads
    const alignButton = desk.getByRole("button", { name: "Auto-align" });
    await expect(alignButton).toBeEnabled({ timeout: 90_000 }); // load's own align settled
    // Give one NEVER-SPLIT take-2 clip a manual move (+1 s)…
    const take2StreamId = await desk.evaluate((tid) => {
      const hook = (
        globalThis as unknown as {
          __antiphonDesk?: {
            snapshot(): { deskStatus: Array<{ streamId: string; takeId: string }> } | null;
          };
        }
      ).__antiphonDesk;
      return (hook?.snapshot()?.deskStatus ?? []).find((s) => s.takeId === tid)?.streamId ?? "";
    }, take2Id);
    const t2Box = await desk.locator(`[data-clip="${take2StreamId}"]`).boundingBox();
    if (!t2Box) throw new Error("take-2 clip not visible");
    await desk.mouse.move(t2Box.x + t2Box.width / 2, t2Box.y + t2Box.height / 2);
    await desk.mouse.down();
    await desk.mouse.move(t2Box.x + t2Box.width / 2 + PX_PER_SEC, t2Box.y + t2Box.height / 2, {
      steps: 6,
    });
    await desk.mouse.up();
    await expect.poll(async () => await overrideOf(take2StreamId)).not.toBeNull();
    // …select it (the drag press selected it) PLUS a split PIECE of stream
    // A (a fresh-id tail piece — the region→stream resolver under test),
    // then force the re-align.
    await desk.locator(`[data-clip="${aTailId}"]`).click({ modifiers: ["Shift"] });
    const regionsBefore = await uiRegions(desk);
    const recordAt = async (tid: string) =>
      await desk.evaluate((takeIdArg) => {
        const hook = (
          globalThis as unknown as {
            __antiphonDesk?: { alignmentRecord(takeId: string): { at: number } | null };
          }
        ).__antiphonDesk;
        return hook?.alignmentRecord(takeIdArg)?.at ?? 0;
      }, tid);
    const take1RecordAtBefore = await recordAt(takeId);
    await alignButton.click();
    // The chip note counts every clip that moved: the never-split take-2
    // override (1) plus stream A's three pieces, all seeded off the
    // pre-split +1 s drag and now snapped back by exactly that second.
    await expect(desk.getByTestId("align-note")).toHaveText("manual offsets reset · 4 clips");
    // The never-split clip's override cleared; stream A's pieces keep
    // their CUTS (ids + source windows byte-identical) but sit at
    // source-true positions; A's frozen arrange key survives at its
    // pre-split value (deleting it would move the clip on OLD desks'
    // pre-split view — the compat half of the old decision, kept);
    // stream B was NOT in scope, so its region holds its spot.
    const expectRealignedRegions = (regions: Record<string, UiRegion[]>) => {
      const cutsOf = (list: UiRegion[] | undefined) =>
        (list ?? []).map(({ id, sourceOffsetSec, durationSec }) => ({
          id,
          sourceOffsetSec,
          durationSec,
        }));
      expect(cutsOf(regions[streamA])).toEqual(cutsOf(regionsBefore[streamA]));
      for (const r of regions[streamA] ?? []) {
        expect(r.startSec, `piece ${r.id} at source-true spot`).toBeCloseTo(
          TAKE_BASE_SEC + r.sourceOffsetSec,
          6,
        );
      }
      expect(regions[streamB]).toEqual(regionsBefore[streamB]);
    };
    await expect.poll(async () => await overrideOf(take2StreamId)).toBeNull();
    expectRealignedRegions(await uiRegions(desk));
    expect(await overrideOf(streamA)).toBeCloseTo(aBase, 6);
    // Selecting the PIECE put its whole take in the align scope: take 1's
    // persisted record re-measures (fresh `at` stamp) — the region→stream
    // resolver reaching the W7-A flow, pinned end-to-end.
    await expect
      .poll(async () => (await recordAt(takeId)) > take1RecordAtBefore, { timeout: 120_000 })
      .toBe(true);
    // Let the two-take flow settle before teardown (button re-enables);
    // the reset layout AND the frozen key hold through the whole flow.
    await expect(alignButton).toBeEnabled({ timeout: 120_000 });
    expectRealignedRegions(await uiRegions(desk));
    expect(await overrideOf(streamA)).toBeCloseTo(aBase, 6);

    await phoneA.close();
    await phoneB.close();
    await desk.close();
    await deskContext.close();
  });
});
