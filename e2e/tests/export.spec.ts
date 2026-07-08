// W2-A — mixdown render + export.
//
// Two phones record a short take; once it converges and auto-loads, the
// desk's Export ▾ menu renders the master mix (OfflineAudioContext →
// 24-bit/48 kHz stereo WAV) and the per-lane stems (aligned mono WAVs in a
// STORE ZIP). The downloads are read back in Node and verified
// structurally: RIFF/WAVE headers, plausible durations, ZIP central
// directory offsets + CRCs, and nickname-bearing stem filenames.

import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { expectTakeConverged, joinAsRecorder, startTake, stopTake } from "./helpers/session";

// ---- file-format readers (independent of the app's writers) ----------------

interface WavInfo {
  channels: number;
  sampleRate: number;
  bitDepth: number;
  durationSec: number;
  /** True when at least one PCM byte is nonzero (audio actually landed). */
  hasSignal: boolean;
}

function parseWav(bytes: Buffer): WavInfo {
  expect(bytes.subarray(0, 4).toString("latin1")).toBe("RIFF");
  expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
  expect(bytes.subarray(8, 12).toString("latin1")).toBe("WAVE");
  expect(bytes.subarray(12, 16).toString("latin1")).toBe("fmt ");
  expect(bytes.readUInt16LE(20)).toBe(1); // integer PCM
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  const bitDepth = bytes.readUInt16LE(34);
  expect(bytes.subarray(36, 40).toString("latin1")).toBe("data");
  const dataSize = bytes.readUInt32LE(40);
  expect(bytes.length).toBe(44 + dataSize);
  const blockAlign = channels * (bitDepth / 8);
  expect(bytes.readUInt16LE(32)).toBe(blockAlign);
  const data = bytes.subarray(44);
  return {
    channels,
    sampleRate,
    bitDepth,
    durationSec: dataSize / blockAlign / sampleRate,
    hasSignal: data.some((b) => b !== 0),
  };
}

/** Reference CRC-32 (IEEE, bitwise) to check the ZIP's stored CRCs. */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Walk EOCD → central directory → local headers of a STORE-only ZIP,
 * asserting the structural invariants along the way. */
function parseZip(zip: Buffer): Array<{ name: string; data: Buffer }> {
  const eocd = zip.length - 22; // single disk, no archive comment
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  expect(centralOffset + centralSize).toBe(eocd);

  const entries: Array<{ name: string; data: Buffer }> = [];
  let cursor = centralOffset;
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    expect(zip.readUInt16LE(cursor + 10)).toBe(0); // STORE
    const crc = zip.readUInt32LE(cursor + 16);
    const size = zip.readUInt32LE(cursor + 24);
    expect(zip.readUInt32LE(cursor + 20)).toBe(size); // stored === raw
    const nameLen = zip.readUInt16LE(cursor + 28);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");

    // The central directory must point at a matching local header.
    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    expect(zip.readUInt32LE(localOffset + 14)).toBe(crc);
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = zip.subarray(dataStart, dataStart + size);
    expect(crc32(data)).toBe(crc);
    entries.push({ name, data });
    cursor += 46 + nameLen;
  }
  expect(cursor).toBe(centralOffset + centralSize);
  return entries;
}

// ---- journey ---------------------------------------------------------------

/** Set the performer nickname through the join page's Performer panel
 * (A13) — stem filenames must carry it. */
async function renamePerformer(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: /edit/i }).click();
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
}

test.describe("export (W2-A)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("master WAV and stems ZIP render from a converged take", async ({ browser }) => {
    test.setTimeout(180_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phoneA = await (await browser.newContext()).newPage();
    const phoneB = await (await browser.newContext()).newPage();
    await joinAsRecorder(phoneA, sessionId);
    await joinAsRecorder(phoneB, sessionId);
    await renamePerformer(phoneA, "Alto");
    await renamePerformer(phoneB, "Tenor");
    await expect(desk.getByText("2 phones connected")).toBeVisible({ timeout: 15_000 });

    // --- a short take, chirped so the loaded take auto-aligns -------------
    const takeId = await startTake(desk);
    await desk.getByRole("button", { name: "Chirp" }).click();
    await expect(desk.getByText(/chirp emitted/i)).toBeVisible();
    await desk.waitForTimeout(4_000);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, takeId, 2);

    // --- master mix WAV ----------------------------------------------------
    // The menu button unlocks on convergence; the render item additionally
    // waits for playback readiness (take decoded + aligned).
    const exportButton = desk.getByRole("button", { name: "Export ▾" });
    await expect(exportButton).toBeEnabled({ timeout: 30_000 });
    await exportButton.click();
    const masterItem = desk.getByRole("menuitem", { name: /master mix/i });
    await expect(masterItem).toBeEnabled({ timeout: 30_000 });
    const [masterDownload] = await Promise.all([desk.waitForEvent("download"), masterItem.click()]);
    expect(masterDownload.suggestedFilename()).toMatch(/^take-\d{2}-master\.wav$/);
    const master = parseWav(await readFile(await masterDownload.path()));
    expect(master.channels).toBe(2);
    expect(master.sampleRate).toBe(48_000);
    expect(master.bitDepth).toBe(24);
    // ~4 s recorded; alignment may trim under a chirp-repeat of head.
    expect(master.durationSec).toBeGreaterThan(2);
    expect(master.durationSec).toBeLessThan(30);
    expect(master.hasSignal).toBe(true);

    // --- stems ZIP ----------------------------------------------------------
    await expect(exportButton).toBeEnabled({ timeout: 30_000 }); // busy cleared
    await exportButton.click();
    const stemsItem = desk.getByRole("menuitem", { name: /^stems/i });
    await expect(stemsItem).toBeEnabled({ timeout: 30_000 });
    const [stemsDownload] = await Promise.all([desk.waitForEvent("download"), stemsItem.click()]);
    expect(stemsDownload.suggestedFilename()).toMatch(/^take-\d{2}-stems\.zip$/);
    const entries = parseZip(await readFile(await stemsDownload.path()));

    // One aligned mono WAV per lane, filename carrying the nickname.
    expect(entries.map((e) => e.name).sort()).toEqual([
      expect.stringMatching(/^Alto-[0-9a-f]{8}\.wav$/),
      expect.stringMatching(/^Tenor-[0-9a-f]{8}\.wav$/),
    ]);
    for (const entry of entries) {
      const stem = parseWav(entry.data);
      expect(stem.channels).toBe(1);
      expect(stem.sampleRate).toBe(48_000);
      expect(stem.bitDepth).toBe(24);
      // Stems share the master's timeline so lanes line up at 0 on import.
      expect(Math.abs(stem.durationSec - master.durationSec)).toBeLessThan(0.05);
      expect(stem.hasSignal).toBe(true);
    }
  });
});
