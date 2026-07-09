// W5-C — per-song exports + FLAC stems.
//
// Two phones record a short take; the desk drops two markers. The Export ▾
// Songs section then carries the whole per-song story on each row: click
// renders the song's master WAV (covered in markers.spec.ts), the
// hover-revealed chips render its stems ZIP and its project package. The
// Stems row gains a WAV/FLAC format toggle that applies to whole-take and
// per-song stems alike. Every artifact is read back with independent
// parsers (helpers/files.ts): ZIP walk + CRCs, WAV headers, a FLAC
// STREAMINFO bit-read — and each FLAC additionally PLAYS: the desk page
// decodeAudioData()s it and reports duration/channels/peak.

import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { parseFlacHeader, parseWav, parseZip } from "./helpers/files";
import { expectTakeConverged, joinAsRecorder, startTake, stopTake } from "./helpers/session";

// ---- desk hook readers (markers.spec.ts pattern) -----------------------------

interface UiMarker {
  id: string;
  name: string;
  atSec: number;
}

async function uiMarkers(desk: Page): Promise<UiMarker[]> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: { ui(): { markers: UiMarker[] } | null };
      }
    ).__antiphonDesk;
    return hook?.ui()?.markers ?? [];
  });
}

async function playerSnap(desk: Page): Promise<{
  loadedTakeId: string | null;
  tracks: number;
  takeDurationSec: number;
}> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: {
          playerSnapshot(): {
            loadedTakeId: string | null;
            tracks: unknown[];
            takeDurationSec: number;
          } | null;
        };
      }
    ).__antiphonDesk;
    const snap = hook?.playerSnapshot();
    return {
      loadedTakeId: snap?.loadedTakeId ?? null,
      tracks: snap?.tracks.length ?? 0,
      // W6-B: whole-take stems span the TAKE, not the session transport.
      takeDurationSec: snap?.takeDurationSec ?? 0,
    };
  });
}

/** Set the performer nickname through the join page (A13) — stem
 * filenames must carry it. */
async function renamePerformer(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: /edit/i }).click();
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
}

/** The decodability proof: hand the bytes to the DESK's own browser and
 * let Web Audio decode them — independent of both the Rust encoder and
 * the Node-side STREAMINFO reader. */
async function decodeInPage(
  desk: Page,
  bytes: Buffer,
): Promise<{ durationSec: number; channels: number; peak: number }> {
  return await desk.evaluate(async (b64) => {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const ctx = new OfflineAudioContext(1, 1, 48_000);
    const audio = await ctx.decodeAudioData(buf.buffer);
    let peak = 0;
    for (let ch = 0; ch < audio.numberOfChannels; ch++) {
      const data = audio.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        peak = Math.max(peak, Math.abs(data[i] as number));
      }
    }
    return { durationSec: audio.duration, channels: audio.numberOfChannels, peak };
  }, bytes.toString("base64"));
}

/** Open Export ▾ and wait for the render items to unlock. */
async function openExportMenu(desk: Page): Promise<void> {
  const exportButton = desk.getByRole("button", { name: "Export ▾" });
  await expect(exportButton).toBeEnabled({ timeout: 30_000 }); // busy cleared
  await exportButton.click();
}

// Default zoom: 24 px/sec; the first take sits at +1 s on the arrangement.
const PX_PER_SEC = 24;
const TAKE_BASE_SEC = 1;

test.describe("song exports (W5-C)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("per-song FLAC stems + project package; whole-take FLAC stems decode", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
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

    // --- a short two-phone take, recorded to convergence --------------------
    const takeId = await startTake(desk);
    await desk.waitForTimeout(4_000);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, takeId, 2);
    await expect
      .poll(
        async () => {
          const snap = await playerSnap(desk);
          return snap.loadedTakeId === takeId && snap.tracks === 2;
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    // --- two song markers: playhead (0) + ruler dblclick (~2.5 s) ------------
    const addButton = desk.getByRole("button", { name: "Add marker at playhead" });
    await expect(addButton).toBeEnabled({ timeout: 15_000 });
    await addButton.click();
    await desk
      .locator("[data-ruler]")
      .dblclick({ position: { x: (TAKE_BASE_SEC + 2.5) * PX_PER_SEC, y: 15 } });
    await expect(desk.getByRole("button", { name: "Marker Song 2", exact: true })).toBeVisible();
    const markers = await uiMarkers(desk);
    expect(markers).toHaveLength(2);
    const at1 = (markers[0] as UiMarker).atSec;
    const at2 = (markers[1] as UiMarker).atSec;
    const songSec = at2 - at1;

    // ---- 1. flip the stem format to FLAC (menu stays open) --------------------
    await openExportMenu(desk);
    // QA M-2: the radio pair announces its context, not bare "wav, checked".
    await expect(desk.getByRole("group", { name: "Stem format" })).toBeVisible();
    const wavRadio = desk.getByRole("menuitemradio", { name: "WAV" });
    const flacRadio = desk.getByRole("menuitemradio", { name: "FLAC" });
    await expect(wavRadio).toHaveAttribute("aria-checked", "true");
    await flacRadio.click();
    await expect(flacRadio).toHaveAttribute("aria-checked", "true");
    await expect(wavRadio).toHaveAttribute("aria-checked", "false");

    // ---- 2. per-song stems, FLAC: hover the song row for its chips ------------
    await desk.getByRole("menuitem", { name: /^01 Song 1/ }).hover();
    const songStems = desk.getByRole("menuitem", { name: "Export 01 Song 1 stems" });
    await expect(songStems).toBeEnabled({ timeout: 30_000 });
    const [stemsDownload] = await Promise.all([desk.waitForEvent("download"), songStems.click()]);
    expect(stemsDownload.suggestedFilename()).toBe("take-01 — 01 Song 1 — stems.zip");
    const stemEntries = parseZip(await readFile(await stemsDownload.path()));
    expect(stemEntries.map((e) => e.name).sort()).toEqual([
      expect.stringMatching(/^Alto-[0-9a-f]{8}\.flac$/),
      expect.stringMatching(/^Tenor-[0-9a-f]{8}\.flac$/),
    ]);
    for (const entry of stemEntries) {
      // Independent STREAMINFO read: mono 24-bit at the project rate, the
      // song span's length, total-samples finalized (never 0/unknown).
      const info = parseFlacHeader(entry.data);
      expect(info.channels).toBe(1);
      expect(info.sampleRate).toBe(48_000);
      expect(info.bitsPerSample).toBe(24);
      expect(info.totalSamples).toBeGreaterThan(0);
      expect(Math.abs(info.durationSec - songSec)).toBeLessThan(0.01);
      // And the real proof: the browser can PLAY it.
      const decoded = await decodeInPage(desk, entry.data);
      expect(decoded.channels).toBe(1);
      expect(Math.abs(decoded.durationSec - songSec)).toBeLessThan(0.01);
      expect(decoded.peak).toBeGreaterThan(0);
    }

    // ---- 3. per-song project package: manifest slices honestly ----------------
    await openExportMenu(desk);
    await desk.getByRole("menuitem", { name: /^01 Song 1/ }).hover();
    const songProject = desk.getByRole("menuitem", { name: "Export 01 Song 1 project package" });
    await expect(songProject).toBeEnabled({ timeout: 30_000 });
    const [projectDownload] = await Promise.all([
      desk.waitForEvent("download"),
      songProject.click(),
    ]);
    expect(projectDownload.suggestedFilename()).toBe("take-01 — 01 Song 1 — project.zip");
    const projectZip = parseZip(await readFile(await projectDownload.path()));
    expect(projectZip.map((e) => e.name).sort()).toEqual([
      "master.wav",
      "project.json",
      expect.stringMatching(/^stems\/Alto-[0-9a-f]{8}\.wav$/),
      expect.stringMatching(/^stems\/Tenor-[0-9a-f]{8}\.wav$/),
    ]);
    // Master + stems all render exactly the song span (package stems stay
    // WAV: the manifest/DAW interchange format is untouched by the toggle).
    const master = parseWav(
      (projectZip.find((e) => e.name === "master.wav") as { data: Buffer }).data,
    );
    expect(master.channels).toBe(2);
    expect(Math.abs(master.durationSec - songSec)).toBeLessThan(0.01);
    expect(master.hasSignal).toBe(true);
    for (const entry of projectZip.filter((e) => e.name.startsWith("stems/"))) {
      const stem = parseWav(entry.data);
      expect(stem.channels).toBe(1);
      expect(stem.durationSec).toBeCloseTo(master.durationSec, 6);
    }
    const manifest = JSON.parse(
      (projectZip.find((e) => e.name === "project.json") as { data: Buffer }).data.toString("utf8"),
    ) as {
      range: { startSec: number; endSec: number };
      markers: Array<{ name: string; atSec: number }>;
      songs: Array<{ index: number; name: string; startSec: number; endSec: number | null }>;
    };
    // The manifest declares the source range and rebases events onto the
    // exported timeline: marker 1 at 0; marker 2 (at endSec exactly — it
    // starts the NEXT song) sliced away, half-open.
    expect(manifest.range.startSec).toBeCloseTo(at1, 3);
    expect(manifest.range.endSec).toBeCloseTo(at2, 3);
    expect(manifest.markers).toHaveLength(1);
    expect(manifest.markers[0]?.name).toBe("Song 1");
    expect(manifest.markers[0]?.atSec).toBeCloseTo(0, 6);
    expect(manifest.songs).toEqual([
      { id: expect.any(String), index: 1, name: "Song 1", startSec: 0, endSec: null },
    ]);

    // ---- 4. whole-take stems honor the sticky FLAC choice ---------------------
    const takeDurationSec = (await playerSnap(desk)).takeDurationSec;
    await openExportMenu(desk);
    // QA M-2: the hover chips are focusable BEFORE the reveal (opacity
    // overlay, not display:none), so Shift+Tab from the row below lands on
    // the last song's project chip — and that focus reveals it.
    await desk.getByRole("menuitem", { name: /^All songs/ }).focus();
    await desk.keyboard.press("Shift+Tab");
    const backwardChip = desk.getByRole("menuitem", { name: "Export 02 Song 2 project package" });
    await expect(backwardChip).toBeFocused();
    // …the reveal is on the chips' wrapper (opacity + pointer-events).
    await expect(backwardChip.locator("..")).toHaveCSS("opacity", "1");
    const stemsItem = desk.getByRole("menuitem", { name: /^stems/i });
    await expect(stemsItem).toBeEnabled({ timeout: 30_000 });
    const [takeStemsDownload] = await Promise.all([
      desk.waitForEvent("download"),
      stemsItem.click(),
    ]);
    expect(takeStemsDownload.suggestedFilename()).toMatch(/^take-\d{2}-stems\.zip$/);
    const takeStems = parseZip(await readFile(await takeStemsDownload.path()));
    expect(takeStems.map((e) => e.name).sort()).toEqual([
      expect.stringMatching(/^Alto-[0-9a-f]{8}\.flac$/),
      expect.stringMatching(/^Tenor-[0-9a-f]{8}\.flac$/),
    ]);
    for (const entry of takeStems) {
      const info = parseFlacHeader(entry.data);
      expect(info.channels).toBe(1);
      expect(info.sampleRate).toBe(48_000);
      expect(Math.abs(info.durationSec - takeDurationSec)).toBeLessThan(0.05);
      const decoded = await decodeInPage(desk, entry.data);
      expect(Math.abs(decoded.durationSec - takeDurationSec)).toBeLessThan(0.05);
      expect(decoded.peak).toBeGreaterThan(0);
    }

    await phoneA.close();
    await phoneB.close();
    await desk.close();
  });
});
