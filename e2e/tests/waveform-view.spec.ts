// F18 — waveform whiplash. While a take records, clips draw the encoder's
// signal-complexity proxy (self-normalized — always "tall"); when the
// stream completes and decodes, the drawing used to switch to ABSOLUTE
// amplitude, so a quiet take collapsed into a flat dotted strip. QA read
// that as data loss at the exact moment the recording succeeded.
//
// Fix under test: the decoded waveform draws PEAK-NORMALIZED per clip,
// with an honest "×N" view-gain chip when the boost is significant (and a
// silence floor so near-silence still draws flat instead of amplified
// noise). This spec forces the whiplash with a genuinely QUIET fake mic:
// a dedicated Chromium launch feeding a −26 dBFS sine through
// --use-file-for-fake-audio-capture, so absolute drawing would produce
// ≤5%-tall bars. It asserts:
//   (a) the decoded clip's tallest bar spans the wave area (no collapse),
//   (b) the ×N view-gain chip is present and honest (≈ 1/peak),
//   (c) screenshot evidence: live (proxy) vs decoded (normalized) clip.
// Screenshots land in screens/qa/ (gitignored evidence, same home as the
// QA sweeps').

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, expect, test } from "@playwright/test";
import { WEB_PORT } from "../ports";
import {
  type DeskStreamStatus,
  expectTakeConverged,
  joinAsRecorder,
  startTake,
  stopTake,
} from "./helpers/session";

const ORIGIN = `http://localhost:${WEB_PORT}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCREEN_DIR = path.join(repoRoot, "screens", "qa");

/** Amplitude of the quiet source: −26 dBFS → view gain ≈ ×20 (< the ×24
 * cap, > the ×2 chip threshold — squarely in "normalize and say so"). */
const QUIET_PEAK = 0.05;

/** 16-bit PCM mono WAV: `seconds` of a 440 Hz sine at `peak`. Chromium
 * loops the file for the lifetime of the fake capture device. */
function quietWav(seconds: number, peak: number, sampleRate = 48_000): Buffer {
  const frames = seconds * sampleRate;
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * peak * 32767);
    data.writeInt16LE(v, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test.describe("waveform view continuity (F18)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  let quietBrowser: Browser | null = null;
  test.afterEach(async () => {
    await quietBrowser?.close();
    quietBrowser = null;
  });

  test("a quiet take keeps a readable waveform after decode, with an honest ×N chip", async () => {
    test.setTimeout(180_000);
    await mkdir(SCREEN_DIR, { recursive: true });

    // Dedicated launch: the project-level fake mic is a loud tone; this
    // browser's fake capture is the quiet file (both desk + phone live here).
    const wavPath = test.info().outputPath("quiet-440hz.wav");
    await writeFile(wavPath, quietWav(30, QUIET_PEAK));
    quietBrowser = await chromium.launch({
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        `--use-file-for-fake-audio-capture=${wavPath}`,
      ],
    });

    const sessionId = crypto.randomUUID();
    const desk = await (await quietBrowser.newContext()).newPage();
    await desk.goto(`${ORIGIN}/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phone = await (await quietBrowser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId, ORIGIN);
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

    // --- record ~4 s; screenshot the LIVE clip (energy-proxy waveform) ------
    const takeId = await startTake(desk);
    await expect(phone.getByText("recording", { exact: true })).toBeVisible({ timeout: 15_000 });
    const liveClip = desk.locator("[data-clip]").first();
    await expect(liveClip).toBeVisible({ timeout: 15_000 });
    await desk.waitForTimeout(3_000); // enough chunks for a real proxy contour
    await liveClip.screenshot({ path: path.join(SCREEN_DIR, "f18-clip-live.png") });
    await desk.waitForTimeout(1_000);
    await stopTake(desk);

    const { deskStreams } = await expectTakeConverged(desk, sessionId, takeId, 1, {
      origin: ORIGIN,
    });
    const streamId = (deskStreams[0] as DeskStreamStatus).streamId;
    const clip = desk.locator(`[data-clip="${streamId}"]`);

    // --- wait for the decoded waveform to replace the proxy -----------------
    await expect
      .poll(
        async () =>
          await desk.evaluate(() => {
            const hook = (
              globalThis as unknown as {
                __antiphonDesk?: { ui(): { waveformsCached: number } | null };
              }
            ).__antiphonDesk;
            return hook?.ui()?.waveformsCached ?? 0;
          }),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);

    await clip.screenshot({ path: path.join(SCREEN_DIR, "f18-clip-decoded.png") });

    // (a) No collapse: the tallest decoded bar still spans the wave area.
    // Absolute drawing of a −26 dBFS source would cap every bar at ≤9%.
    const maxBarPct = await clip.evaluate((el) => {
      const bars = Array.from(el.querySelectorAll<HTMLElement>("[data-wave] > div"));
      return Math.max(0, ...bars.map((bar) => Number.parseFloat(bar.style.height)));
    });
    expect(maxBarPct).toBeGreaterThan(60);

    // (b) The view-gain chip is present and honest: ≈ ×(1/peak), well past
    // the ×2 badge threshold and under the ×24 cap.
    const chip = clip.locator("[data-wave-gain]");
    await expect(chip).toBeVisible();
    const gain = Number.parseInt((await chip.getAttribute("data-wave-gain")) ?? "0", 10);
    expect(gain).toBeGreaterThanOrEqual(10);
    expect(gain).toBeLessThanOrEqual(24);
    await expect(chip).toHaveText(`×${gain}`);

    await phone.close();
    await desk.close();
  });
});
