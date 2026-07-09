// W6-C — manual clip arrangement over an aligned take. The operator's
// report ("clips never align, they remain at the same place even once
// manually moved") had three layers; this spec pins the DRAG layer with
// signal evidence, on top of a content-aligned session:
//   1. a clip drag reaches the schedule — the rendered inter-lane offset
//      moves by exactly the dragged seconds (per-lane tap, envelope xcorr);
//   2. the drag COMPOSES on top of the align delta — the residual reads
//      the drag amount, not drag±stagger (no double-apply, no undo);
//   3. the drag survives a reload: the arrangement override lives in the
//      shared doc, and box position + rendered offset come back identical.
//   4. QA F1 — a click into an UNLOADED take's span (retarget-load with a
//      persisted aligned verdict, anchor > 0) settles the playhead at
//      EXACTLY the clicked arrangement position: the parked pin holds
//      through the verdict landing (never a visible jump right by the
//      anchor) and the final player position maps through the ANCHORED
//      base, not the anchorless one.
// Geometry note: boxes draw at arrangement position + align shift (the
// W6-C visual composition), so the drag moves the box 1:1 under the
// pointer while the OVERRIDE stays in the un-shifted audio domain.

import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  alignDeltas,
  clipLefts,
  expectTakeLoaded,
  measureLaneOffset,
  musicLikeWav,
  SAMPLE_RATE,
} from "./helpers/align";
import { expectTakeConverged, joinAsRecorder, startTake, stopTake } from "./helpers/session";

const wavPath = path.join(os.tmpdir(), `antiphon-clip-arrange-${process.pid}.wav`);
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

test.describe("clip arrangement over alignment (W6-C)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("a drag reaches the schedule, composes on the align delta, and survives reload", async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const sessionId = crypto.randomUUID();

    const deskContext = await browser.newContext();
    const desk = await deskContext.newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    // The content-align capture shape: two staggered chirpless captures of
    // the same music-like performance (see content-align.spec.ts).
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
    await expect(desk.getByRole("button", { name: "Auto-align" })).toHaveAttribute(
      "data-align-state",
      "aligned",
      { timeout: 90_000 },
    );
    const deltas = await alignDeltas(desk);
    expect(deltas).toHaveLength(2);

    // Baseline: aligned lanes render with ≈ zero residual offset. W6-B
    // domain note: play() takes SESSION (arrangement) seconds now — the
    // take sits at +1 s, so "from the take head" is fromSec 1 (the
    // helper's both-lanes-content-full rule, translated).
    const baseline = await measureLaneOffset(desk, 6, 1);
    expect(Math.abs(baseline.lagSec)).toBeLessThanOrEqual(0.05);
    expect(baseline.r).toBeGreaterThan(0.9);

    // Drag the lexicographically-later stream's clip +2 s (48 px at zoom
    // 1) — the same lane the tap's positive-lag convention tracks.
    const dragId = [...(await clipLefts(desk)).keys()].sort()[1] as string;
    const beforeX = (await clipLefts(desk)).get(dragId) as number;
    const clip = desk.locator(`[data-clip="${dragId}"]`);
    const box = await clip.boundingBox();
    if (!box) throw new Error("clip not visible");
    const pxPerSec = 24;
    await desk.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await desk.mouse.down();
    await desk.mouse.move(box.x + box.width / 2 + 2 * pxPerSec, box.y + box.height / 2, {
      steps: 8,
    });
    await desk.mouse.up();

    // The box moved 1:1 under the pointer (the align shift composes into
    // the drawing without disturbing the gesture)…
    const afterX = (await clipLefts(desk)).get(dragId) as number;
    expect(Math.abs(afterX - beforeX - 2 * pxPerSec)).toBeLessThan(2);
    // …and the override landed in the shared doc's arrangement map.
    const overrides = await desk.evaluate(() => {
      const hook = (
        globalThis as unknown as {
          __antiphonDesk?: { ui(): { clipStarts: Record<string, number> } | null };
        }
      ).__antiphonDesk;
      return hook?.ui()?.clipStarts ?? {};
    });
    expect(overrides[dragId]).toBeGreaterThan(0);

    // The drag reached the schedule AND composed ON TOP of the align
    // delta: the dragged (second-sorted) lane now renders 2 s late — the
    // tap reads −2 by its sign convention. Measured from PAST the new
    // clip delay so both lanes stay content-full (helper note; session
    // seconds — the dragged clip now starts at arrangement 3), and pinned
    // away from the two failure shapes: |2±stagger| is what a drag that
    // double-applied or clobbered the alignment would read.
    const dragged = await measureLaneOffset(desk, 6, 3.5);
    expect(dragged.lagSec).toBeLessThan(-1.8);
    expect(dragged.lagSec).toBeGreaterThan(-2.2);
    const stagger =
      (Math.max(...deltas.map(([, d]) => d)) - Math.min(...deltas.map(([, d]) => d))) / SAMPLE_RATE;
    expect(Math.abs(-dragged.lagSec - (2 + stagger))).toBeGreaterThan(0.5);
    expect(Math.abs(-dragged.lagSec - (2 - stagger))).toBeGreaterThan(0.5);

    // Reload: the override (shared doc), the box position, the restored
    // verdict AND the rendered offset all come back — moves stick.
    await desk.reload();
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();
    await expectTakeLoaded(desk, takeId, 90_000);
    await expect(desk.getByRole("button", { name: "Auto-align" })).toHaveAttribute(
      "data-align-state",
      "aligned",
      { timeout: 90_000 },
    );
    await expect
      .poll(
        async () =>
          await desk.evaluate(() => {
            const hook = (
              globalThis as unknown as {
                __antiphonDesk?: { ui(): { clipStarts: Record<string, number> } | null };
              }
            ).__antiphonDesk;
            return hook?.ui()?.clipStarts ?? {};
          }),
        { timeout: 30_000 },
      )
      .toEqual(overrides);
    const reloadedX = (await clipLefts(desk)).get(dragId) as number;
    expect(Math.abs(reloadedX - afterX)).toBeLessThan(2);
    const reloaded = await measureLaneOffset(desk, 6, 3.5);
    expect(Math.abs(reloaded.lagSec - dragged.lagSec)).toBeLessThanOrEqual(0.05);

    // ---- QA F1: cross-take click-to-seek lands EXACTLY on the click. ----
    // A second take makes take 1 the UNLOADED one with a persisted aligned
    // verdict (anchor ≈ the capture stagger). Clicking bare surface inside
    // take 1's span retargets through the load queue; the parked pin must
    // hold the clicked spot through load AND verdict-restore — no visible
    // jump right by the anchor — and the final player position must map
    // through the anchored base.
    const take2Id = await startTake(desk);
    await desk.waitForTimeout(4_000);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, take2Id, 2, { timeoutMs: 90_000 });
    await expectTakeLoaded(desk, take2Id, 60_000);

    // Click at arrangement 6 s: inside take 1's clips on the x axis (they
    // span [1, ~13] and [3, ~15]), on the empty surface below both lanes
    // (a clip press would be selection, not seek — W4-C).
    const RULER_H = 30;
    const TRACK_ROW_H = 66;
    const rulerBox = (await desk.locator("[data-ruler]").boundingBox()) as {
      x: number;
      y: number;
    };
    const clickSec = 6;
    await desk.mouse.click(
      rulerBox.x + clickSec * pxPerSec,
      rulerBox.y + RULER_H + 2 * TRACK_ROW_H + 40,
    );

    // Sample the drawn playhead through retarget-load + verdict restore,
    // then a beat longer: EVERY sample stays on the click. Without the
    // settle-gated pin handover the trace reads click → click+anchor.
    interface PinSample {
      playhead: number | null;
      loaded: string | null;
      aligning: boolean;
      settled: boolean;
      position: number;
    }
    const sample = (): Promise<PinSample> =>
      desk.evaluate(() => {
        const hook = (
          globalThis as unknown as {
            __antiphonDesk?: {
              ui(): { playheadSec: number | null } | null;
              playerSnapshot(): {
                loadedTakeId: string | null;
                aligning: boolean;
                alignmentOutcome: unknown;
                positionSec: number;
              } | null;
            };
          }
        ).__antiphonDesk;
        const snap = hook?.playerSnapshot();
        return {
          playhead: hook?.ui()?.playheadSec ?? null,
          loaded: snap?.loadedTakeId ?? null,
          aligning: snap?.aligning ?? true,
          settled: (snap?.aligning ?? true) === false && (snap?.alignmentOutcome ?? null) !== null,
          position: snap?.positionSec ?? -1,
        };
      });
    const samples: number[] = [];
    let settledOnTake1 = false;
    for (let i = 0; i < 150 && !settledOnTake1; i++) {
      await desk.waitForTimeout(100);
      const s = await sample();
      if (s.playhead !== null) samples.push(s.playhead);
      settledOnTake1 = s.loaded === takeId && s.settled;
    }
    expect(settledOnTake1).toBe(true);
    for (let i = 0; i < 10; i++) {
      await desk.waitForTimeout(100);
      samples.push((await sample()).playhead as number);
    }
    expect(samples.length).toBeGreaterThan(10);
    for (const at of samples) {
      expect(Math.abs(at - clickSec), `playhead sample ${at} vs click ${clickSec}`).toBeLessThan(
        0.1,
      );
    }
    // Exact final mapping: the transport clock is SESSION-absolute and
    // anchor-free (W6-B), so the audio target of a click inside the
    // selected take's DRAWN region is click − ANCHOR — position + anchor
    // must read the click back exactly. An anchorless mapping would miss
    // by the whole anchor (> 1.4 s, asserted real). (Pre-W6-B this read
    // base + anchor + take-local position; the base now lives inside the
    // session position itself.)
    const anchorSec = await desk.evaluate(() => {
      const hook = (
        globalThis as unknown as {
          __antiphonDesk?: { player: { alignShifts(): { anchorSec: number } } };
        }
      ).__antiphonDesk;
      return hook?.player.alignShifts().anchorSec ?? -1;
    });
    expect(anchorSec).toBeGreaterThan(1.4);
    const finalPos = (await sample()).position;
    expect(Math.abs(anchorSec + finalPos - clickSec)).toBeLessThan(0.06);

    // ---- W6-B × W6-C invariant pin: the playhead applies the anchor ----
    // PER TAKE. Session playback (W6-B) rolls from inside the loaded,
    // ANCHORED take 1 across the gap into take 2 — an unloaded neighbor
    // whose boxes draw at capture placement (W6-C's loaded-take-only
    // scope). While the audio comes from take 1's shifted boxes the drawn
    // playhead reads position + anchor; over the neighbor it must read
    // the RAW session position — never lying by the loaded take's anchor
    // (> 1.4 s here, so the two readings are unambiguous even with the
    // ~0.1 s mirror-vs-engine sampling skew).
    // take 1's audio spans [1, 1 + takeDuration] on the session axis;
    // the ALIGNED end depends on which lane the +2 s drag hit (the
    // trimmed-head lane ends ~2 s earlier than the zero-trim one, and the
    // streamId sort that picked the drag target is random) — so the
    // play-from point and the sample buckets both derive from the
    // measured end, with margins the mirror-vs-engine sampling skew
    // can't misfile across.
    const take1EndSec =
      1 +
      (await desk.evaluate(() => {
        const hook = (
          globalThis as unknown as {
            __antiphonDesk?: { playerSnapshot(): { takeDurationSec: number } | null };
          }
        ).__antiphonDesk;
        return hook?.playerSnapshot()?.takeDurationSec ?? -1;
      }));
    expect(take1EndSec).toBeGreaterThan(12.5);
    const pairs: Array<{ playhead: number; position: number }> = [];
    await desk.evaluate((fromSec) => {
      const hook = (
        globalThis as unknown as { __antiphonDesk?: { player: { play(sec: number): void } } }
      ).__antiphonDesk;
      hook?.player.play(fromSec); // inside take 1, 3.5 s before its aligned end
    }, take1EndSec - 3.5);
    for (let i = 0; i < 80; i++) {
      await desk.waitForTimeout(150);
      const s = await desk.evaluate(() => {
        const hook = (
          globalThis as unknown as {
            __antiphonDesk?: {
              ui(): { playheadSec: number | null } | null;
              playerSnapshot(): { positionSec: number; playing: boolean } | null;
            };
          }
        ).__antiphonDesk;
        return {
          playhead: hook?.ui()?.playheadSec ?? null,
          position: hook?.playerSnapshot()?.positionSec ?? -1,
          playing: hook?.playerSnapshot()?.playing ?? false,
        };
      });
      if (!s.playing) break; // end-of-session auto-pause
      if (s.playhead !== null) pairs.push({ playhead: s.playhead, position: s.position });
    }
    const inTake1 = pairs.filter((p) => p.position <= take1EndSec - 1);
    const beyondTake1 = pairs.filter((p) => p.position >= take1EndSec + 0.5);
    expect(inTake1.length).toBeGreaterThanOrEqual(3);
    expect(beyondTake1.length).toBeGreaterThanOrEqual(3);
    for (const p of inTake1) {
      expect(
        Math.abs(p.playhead - (p.position + anchorSec)),
        `selected-take playhead ${p.playhead} vs pos ${p.position} + anchor ${anchorSec}`,
      ).toBeLessThan(0.35);
    }
    for (const p of beyondTake1) {
      expect(
        Math.abs(p.playhead - p.position),
        `neighbor playhead ${p.playhead} vs raw pos ${p.position}`,
      ).toBeLessThan(0.35);
    }

    await phoneA.close();
    await phoneB.close();
    await desk.close();
    await deskContext.close();
  });
});
