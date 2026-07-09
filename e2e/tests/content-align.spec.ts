// W4-B — the operator's P0: "auto align does not work even when almost
// identical clips". Two recorders capture near-identical content with NO
// calibration chirp, at a real capture-start offset, and the desk must
// align them via the content cross-correlation fallback — automatically,
// with an honest "content" verdict.
//
// Scenario construction: Chromium's fake audio device plays a WAV file
// (--use-file-for-fake-audio-capture) from ITS OWN start at each
// getUserMedia, so two phones that enable their mics a couple of seconds
// apart record the same "performance" at genuinely different positions —
// exactly the near-identical-clips-at-an-offset shape. The default fake
// tone can't serve here: it is periodic, so no unique content lag exists
// (alignment-state.spec.ts pins that honest decline). The file is
// music-like — AM tones + filtered noise under an APERIODIC phrase
// contour, the same recipe as the dsp content.rs calibration tests.

import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { expectTakeConverged, joinAsRecorder, startTake, stopTake } from "./helpers/session";

const SAMPLE_RATE = 48_000;
const FILE_SECONDS = 60;

/** 16-bit mono PCM WAV of music-like content (see header comment). */
function musicLikeWav(): Buffer {
  const n = SAMPLE_RATE * FILE_SECONDS;
  const tones: Array<[number, number]> = [
    [220, 0.11],
    [311.1, 0.07],
    [466.2, 0.05],
  ];
  const knotLen = SAMPLE_RATE / 2; // 0.5 s phrase-contour knots
  const knots = Array.from({ length: n / knotLen + 2 }, () => 0.4 + 0.6 * Math.random());
  const data = Buffer.alloc(n * 2);
  let lp1 = 0;
  let lp2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    let s = 0;
    for (let k = 0; k < tones.length; k++) {
      const [freq, amp] = tones[k] as [number, number];
      const am = 0.6 + 0.4 * Math.sin(2 * Math.PI * (0.23 + 0.11 * k) * t);
      s += amp * am * Math.sin(2 * Math.PI * freq * t);
    }
    lp1 += 0.35 * (Math.random() * 2 - 1 - lp1);
    lp2 += 0.35 * (lp1 - lp2);
    const knot = i / knotLen;
    const frac = (i % knotLen) / knotLen;
    const contour =
      (knots[Math.floor(knot)] as number) * (1 - frac) +
      (knots[Math.floor(knot) + 1] as number) * frac;
    const v = (s + 0.3 * lp2) * contour;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 26000))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // integer PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bit depth
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

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

/** The player's applied head-trim deltas (streamId → samples), via hook. */
async function alignDeltas(desk: Page): Promise<Array<[string, number]>> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: { player: { alignDeltas(): Map<string, number> } };
      }
    ).__antiphonDesk;
    if (!hook) return [];
    return [...hook.player.alignDeltas().entries()];
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
    await expect.poll(() => loadedTakeId(desk), { timeout: 30_000 }).toBe(takeId);

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

    await phoneA.close();
    await phoneB.close();
    await desk.close();
    await deskContext.close();
  });
});
