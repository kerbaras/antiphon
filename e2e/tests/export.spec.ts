// W2-A — mixdown render + export.
//
// Two phones record a short take; once it converges and auto-loads, the
// desk's Export ▾ menu renders the master mix (OfflineAudioContext →
// 24-bit/48 kHz stereo WAV) and the per-lane stems (aligned mono WAVs in a
// STORE ZIP). The downloads are read back in Node and verified
// structurally (helpers/files.ts): RIFF/WAVE headers, plausible durations,
// ZIP central directory offsets + CRCs, and nickname-bearing stem filenames.

import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { parseWav, parseZip } from "./helpers/files";
import { expectTakeConverged, joinAsRecorder, startTake, stopTake } from "./helpers/session";

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
