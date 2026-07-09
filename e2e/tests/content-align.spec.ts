// W4-B — the operator's P0: "auto align does not work even when almost
// identical clips". Two recorders capture near-identical content with NO
// calibration chirp, at a real capture-start offset, and the desk must
// align them via the content cross-correlation fallback — automatically,
// with an honest "content" verdict. W6-C adds the two layers the verdict
// chip alone can't prove: the RENDERED signal is aligned (per-lane tap,
// residual ≈ 0), and the timeline SHOWS it (clip boxes shift by the same
// head-trim spread the schedule applies — visual honesty).
//
// Scenario construction: Chromium's fake audio device plays a WAV file
// (--use-file-for-fake-audio-capture) from ITS OWN start at each
// getUserMedia, so two phones that enable their mics a couple of seconds
// apart record the same "performance" at genuinely different positions —
// exactly the near-identical-clips-at-an-offset shape. The default fake
// tone can't serve here: it is periodic, so no unique content lag exists
// (alignment-state.spec.ts pins that honest decline). The file is
// music-like — AM tones + filtered noise under an APERIODIC phrase
// contour, the same recipe as the dsp content.rs calibration tests
// (helpers/align.ts).

import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  alignDeltas,
  clipLefts,
  expectTakeLoaded,
  measureLaneOffset,
  musicLikeWav,
  SAMPLE_RATE,
} from "./helpers/align";
import { parseWav, parseZip } from "./helpers/files";
import { expectTakeConverged, joinAsRecorder, startTake, stopTake } from "./helpers/session";

// Written at module load: the browser (and its flags) launches per worker
// AFTER the spec file is imported, so the path exists before capture.
const wavPath = path.join(os.tmpdir(), `antiphon-content-align-${process.pid}.wav`);
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

interface TrackAlignmentView {
  streamId: string;
  alignment: {
    lagSamples: number;
    confidence: number;
    applied: boolean;
    method?: string;
  } | null;
}

async function playerTracks(desk: Page): Promise<TrackAlignmentView[]> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: {
          playerSnapshot(): { tracks: TrackAlignmentView[] } | null;
        };
      }
    ).__antiphonDesk;
    return hook?.playerSnapshot()?.tracks ?? [];
  });
}

test.describe("content alignment (W4-B)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("chirpless near-identical clips auto-align via content correlation", async ({ browser }) => {
    test.setTimeout(240_000);
    const sessionId = crypto.randomUUID();

    const deskContext = await browser.newContext();
    const desk = await deskContext.newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    // Phone captures start ~2+ s apart: each capture plays the fake-audio
    // file from position 0 at its own getUserMedia, so the streams hold
    // the same content at a genuine offset ≈ the gap between the joins.
    const phoneA = await (await browser.newContext()).newPage();
    await joinAsRecorder(phoneA, sessionId);
    await desk.waitForTimeout(1_500);
    const phoneB = await (await browser.newContext()).newPage();
    await joinAsRecorder(phoneB, sessionId);
    await expect(desk.getByText("2 phones connected")).toBeVisible({ timeout: 15_000 });

    // A ~12 s chirpless take: long enough for the fallback's probe
    // windows to reach the offset in either assignment direction.
    const takeId = await startTake(desk);
    await desk.waitForTimeout(12_000);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, takeId, 2, { timeoutMs: 90_000 });
    await expectTakeLoaded(desk, takeId, 30_000);

    // THE fix: alignment auto-runs on load, the chirp finds nothing, and
    // the content fallback aligns the clips — verdict says so, honestly.
    const alignButton = desk.getByRole("button", { name: "Auto-align" });
    await expect(alignButton).toHaveAttribute("data-align-state", "aligned", {
      timeout: 90_000,
    });
    const outcome = desk.getByTestId("align-outcome");
    await expect(outcome).toContainText(/2 tracks aligned/i);
    // Operator copy says "waveform"; the stored method value is "content".
    await expect(outcome).toContainText(/waveform/);

    // Both tracks carry an applied content verdict…
    const tracks = await playerTracks(desk);
    expect(tracks).toHaveLength(2);
    for (const t of tracks) {
      expect(t.alignment?.applied).toBe(true);
      expect(t.alignment?.method).toBe("content");
    }

    // …and the schedule math holds a real head-trim spread matching the
    // capture-start gap: ≥ the deliberate 1.5 s stagger, ≤ the fallback's
    // search reach (generous bound — join timing jitters under CI load).
    const deltas = await alignDeltas(desk);
    expect(deltas).toHaveLength(2);
    const spread = Math.max(...deltas.map(([, d]) => d)) - Math.min(...deltas.map(([, d]) => d));
    expect(spread).toBeGreaterThan(1.4 * SAMPLE_RATE);
    expect(spread).toBeLessThan(10 * SAMPLE_RATE);

    // ---- W6-C visual honesty: the timeline SHOWS the alignment. ---------
    // The clip boxes separate by exactly the head-trim spread (24 px/s at
    // zoom 1), and it is the LATER starter (the zero-delta track) whose box
    // sits right — the stored audio and arrangement positions never moved,
    // only the drawing composed the align shift in.
    const lefts = await clipLefts(desk);
    expect(lefts.size).toBe(2);
    const sortedByDelta = [...deltas].sort((a, b) => a[1] - b[1]); // [later starter, earlier]
    const laterX = lefts.get((sortedByDelta[1] as [string, number])[0]) as number;
    const zeroX = lefts.get((sortedByDelta[0] as [string, number])[0]) as number;
    const pxPerSec = 24;
    expect(Math.abs(zeroX - laterX - (spread / SAMPLE_RATE) * pxPerSec)).toBeLessThan(1);

    // ---- W6-C audible proof: the RENDERED lanes carry no residual. ------
    // Tap both track analysers inside the graph and cross-correlate the
    // lanes' envelopes: near-identical content aligned by the schedule must
    // correlate at ≈ zero lag (a broken application would read the raw
    // ~1.5-2.5 s capture stagger instead). One schedule pass, gapless-style.
    // W6-B domain note: play() takes SESSION seconds — the take head sits
    // at +1 s on the arrangement (the helper's content-full rule).
    const residual = await measureLaneOffset(desk, 6, 1);
    expect(Math.abs(residual.lagSec)).toBeLessThanOrEqual(0.05);
    expect(residual.r).toBeGreaterThan(0.9);
    expect(residual.scheduleCount).toBe(1);
    // Park the transport back at the head — the marker below spans the take.
    await desk.evaluate(() => {
      const hook = (
        globalThis as unknown as { __antiphonDesk?: { player: { seek(s: number): void } } }
      ).__antiphonDesk;
      hook?.player.seek(0);
    });

    // ---- W5-C × W4-B seam: a per-song export of this CONTENT-aligned take.
    // The package's manifest must tell the same story the desk just showed
    // (method "content", applied), and the content-alignment deltas must be
    // baked into the sliced stems exactly like chirp ones — planSource is
    // shared, so stems of one range come out lag-compensated and equal-length.
    const addButton = desk.getByRole("button", { name: "Add marker at playhead" });
    await expect(addButton).toBeEnabled({ timeout: 15_000 });
    await addButton.click(); // one marker at 0 → "01 Song 1" spans the take
    const exportButton = desk.getByRole("button", { name: "Export ▾" });
    await expect(exportButton).toBeEnabled({ timeout: 30_000 });
    await exportButton.click();
    await desk.getByRole("menuitem", { name: /^01 Song 1/ }).hover();
    const songProject = desk.getByRole("menuitem", { name: "Export 01 Song 1 project package" });
    await expect(songProject).toBeEnabled({ timeout: 30_000 });
    const [download] = await Promise.all([desk.waitForEvent("download"), songProject.click()]);
    const zip = parseZip(await readFile(await download.path()));
    const master = parseWav((zip.find((e) => e.name === "master.wav") as { data: Buffer }).data);
    const stems = zip.filter((e) => e.name.startsWith("stems/"));
    expect(stems).toHaveLength(2);
    for (const stem of stems) {
      // Aligned = every lane rendered to the same range length, with audio.
      const wav = parseWav(stem.data);
      expect(wav.durationSec).toBeCloseTo(master.durationSec, 6);
      expect(wav.hasSignal).toBe(true);
    }
    const manifest = JSON.parse(
      (zip.find((e) => e.name === "project.json") as { data: Buffer }).data.toString("utf8"),
    ) as {
      stems: Array<{
        chirp: { lagSamples: number; applied: boolean; method?: string } | null;
        baked: { headSec: number };
      }>;
    };
    expect(manifest.stems).toHaveLength(2);
    for (const stem of manifest.stems) {
      expect(stem.chirp?.applied).toBe(true);
      expect(stem.chirp?.method).toBe("content");
    }
    // The measured spread IS what got baked: headSec difference between
    // the lanes matches the player's own head-trim spread.
    const headSpread = Math.abs(
      (manifest.stems[0]?.baked.headSec ?? 0) - (manifest.stems[1]?.baked.headSec ?? 0),
    );
    expect(headSpread * SAMPLE_RATE).toBeGreaterThan(1.4 * SAMPLE_RATE);
    expect(headSpread * SAMPLE_RATE).toBeLessThan(10 * SAMPLE_RATE);

    await phoneA.close();
    await phoneB.close();
    await desk.close();
    await deskContext.close();
  });
});
