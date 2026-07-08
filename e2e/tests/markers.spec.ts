// W2-B — song markers & bookmarks.
//
// Two phones record a short take; once it converges and auto-loads, the
// desk operator bookmarks songs: a marker at the playhead (toolbar), one
// by double-clicking the ruler, an inline rename in the Songs panel. Each
// marker starts a song that runs to the next marker (or take end), and
// the Export ▾ menu renders each span as "NN <name>.wav" (verified
// structurally against the marker positions) plus an all-songs ZIP.
// Markers persist in localStorage per (session, take) and must survive a
// desk reload alongside the OPFS archive rebuild.

import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { parseWav, parseZip } from "./helpers/files";
import { expectTakeConverged, joinAsRecorder, startTake, stopTake } from "./helpers/session";

// ---- desk hook readers -------------------------------------------------------

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
  positionSec: number;
  durationSec: number;
}> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: {
          playerSnapshot(): {
            loadedTakeId: string | null;
            tracks: unknown[];
            positionSec: number;
            durationSec: number;
          } | null;
        };
      }
    ).__antiphonDesk;
    const snap = hook?.playerSnapshot();
    return {
      loadedTakeId: snap?.loadedTakeId ?? null,
      tracks: snap?.tracks.length ?? 0,
      positionSec: snap?.positionSec ?? -1,
      durationSec: snap?.durationSec ?? 0,
    };
  });
}

/** Wait until the take is decoded into the player (marker UI unlocks). */
async function expectTakeLoaded(desk: Page, takeId: string, tracks: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const snap = await playerSnap(desk);
        return `take=${snap.loadedTakeId === takeId} tracks=${snap.tracks}`;
      },
      { timeout: 30_000 },
    )
    .toBe(`take=true tracks=${tracks}`);
}

// Default zoom: 24 px/sec; the first take sits at +1 s on the arrangement.
const PX_PER_SEC = 24;
const TAKE_BASE_SEC = 1;

test.describe("song markers (W2-B)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("bookmark, rename, seek, per-song render, and survive a desk reload", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phoneA = await (await browser.newContext()).newPage();
    const phoneB = await (await browser.newContext()).newPage();
    await joinAsRecorder(phoneA, sessionId);
    await joinAsRecorder(phoneB, sessionId);
    await expect(desk.getByText("2 phones connected")).toBeVisible({ timeout: 15_000 });

    // --- a short two-phone take, recorded to convergence --------------------
    const takeId = await startTake(desk);
    await desk.waitForTimeout(4_000);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, takeId, 2);
    await expectTakeLoaded(desk, takeId, 2);

    // --- marker 1: toolbar button at the playhead (position 0) --------------
    const addButton = desk.getByRole("button", { name: "Add marker at playhead" });
    await expect(addButton).toBeEnabled({ timeout: 15_000 });
    await addButton.click();
    await expect(desk.getByRole("button", { name: "Marker Song 1", exact: true })).toBeVisible();

    // --- marker 2: double-click the ruler at take-time ≈2.5 s ---------------
    await desk
      .locator("[data-ruler]")
      .dblclick({ position: { x: (TAKE_BASE_SEC + 2.5) * PX_PER_SEC, y: 15 } });
    await expect(desk.getByRole("button", { name: "Marker Song 2", exact: true })).toBeVisible();

    const markers = await uiMarkers(desk);
    expect(markers).toHaveLength(2);
    const at1 = (markers[0] as UiMarker).atSec;
    const at2 = (markers[1] as UiMarker).atSec;
    expect(at1).toBeCloseTo(0, 1);
    expect(at2).toBeGreaterThan(2.2);
    expect(at2).toBeLessThan(2.8);

    // --- Songs panel: rows with timecode + span ------------------------------
    await desk.getByRole("button", { name: /^songs/i }).click();
    await expect(desk.getByRole("button", { name: "Song 1", exact: true })).toBeVisible();
    await expect(desk.getByRole("button", { name: "Song 2", exact: true })).toBeVisible();
    await expect(desk.getByText("▶ 00:00.0")).toBeVisible();

    // --- inline rename in the panel ------------------------------------------
    await desk.getByRole("button", { name: "Song 1", exact: true }).dblclick();
    await desk.getByRole("textbox", { name: "Rename song" }).fill("Kyrie");
    await desk.keyboard.press("Enter");
    await expect(desk.getByRole("button", { name: "Kyrie", exact: true })).toBeVisible();
    await expect(desk.getByRole("button", { name: "Marker Kyrie", exact: true })).toBeVisible();

    // --- click-to-seek: ruler flag and panel row move the playhead ----------
    await desk.getByRole("button", { name: "Marker Song 2", exact: true }).click();
    await expect
      .poll(async () => Math.abs((await playerSnap(desk)).positionSec - at2))
      .toBeLessThan(0.05);
    // The transport timecode readout followed the seek.
    await expect(desk.getByText(new RegExp(`^00:00:0${Math.floor(at2)}`))).toBeVisible();
    // M at an already-marked spot must NOT stack a third marker.
    await desk.keyboard.press("m");
    expect(await uiMarkers(desk)).toHaveLength(2);
    await desk.getByRole("button", { name: "Kyrie", exact: true }).click();
    await expect
      .poll(async () => Math.abs((await playerSnap(desk)).positionSec - at1))
      .toBeLessThan(0.05);

    // --- per-song master render: "NN <name>.wav" spanning marker→marker -----
    const exportButton = desk.getByRole("button", { name: "Export ▾" });
    await expect(exportButton).toBeEnabled({ timeout: 30_000 });
    await exportButton.click();
    const songItem = desk.getByRole("menuitem", { name: /^01 Kyrie/ });
    await expect(songItem).toBeEnabled({ timeout: 30_000 });
    const [songDownload] = await Promise.all([desk.waitForEvent("download"), songItem.click()]);
    expect(songDownload.suggestedFilename()).toBe("01 Kyrie.wav");
    const song = parseWav(await readFile(await songDownload.path()));
    expect(song.channels).toBe(2);
    expect(song.sampleRate).toBe(48_000);
    expect(song.bitDepth).toBe(24);
    // The song span is marker 1 → marker 2, sample-exact.
    expect(song.durationSec).toBeCloseTo(at2 - at1, 2);
    expect(song.hasSignal).toBe(true);

    // --- all songs in one ZIP -------------------------------------------------
    const takeDurationSec = (await playerSnap(desk)).durationSec;
    await expect(exportButton).toBeEnabled({ timeout: 30_000 }); // busy cleared
    await exportButton.click();
    const allItem = desk.getByRole("menuitem", { name: /^All songs/ });
    await expect(allItem).toBeEnabled({ timeout: 30_000 });
    const [zipDownload] = await Promise.all([desk.waitForEvent("download"), allItem.click()]);
    expect(zipDownload.suggestedFilename()).toMatch(/^take-\d{2}-songs\.zip$/);
    const entries = parseZip(await readFile(await zipDownload.path()));
    expect(entries.map((e) => e.name)).toEqual(["01 Kyrie.wav", "02 Song 2.wav"]);
    const wav1 = parseWav((entries[0] as { data: Buffer }).data);
    const wav2 = parseWav((entries[1] as { data: Buffer }).data);
    expect(wav1.durationSec).toBeCloseTo(at2 - at1, 2);
    // The last song runs from its marker to the take end.
    expect(wav2.durationSec).toBeCloseTo(takeDurationSec - at2, 2);
    expect(wav1.hasSignal).toBe(true);
    expect(wav2.hasSignal).toBe(true);

    // --- markers survive a desk reload (localStorage + OPFS rebuild) ---------
    await desk.reload();
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();
    await expectTakeLoaded(desk, takeId, 2);
    await expect(desk.getByRole("button", { name: "Marker Kyrie", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(desk.getByRole("button", { name: "Marker Song 2", exact: true })).toBeVisible();
    const reloaded = await uiMarkers(desk);
    expect(reloaded.map((m) => m.name)).toEqual(["Kyrie", "Song 2"]);
    expect((reloaded[0] as UiMarker).atSec).toBeCloseTo(at1, 5);
    expect((reloaded[1] as UiMarker).atSec).toBeCloseTo(at2, 5);
    await desk.getByRole("button", { name: /^songs/i }).click();
    await expect(desk.getByRole("button", { name: "Kyrie", exact: true })).toBeVisible();
    await expect(desk.getByRole("button", { name: "Song 2", exact: true })).toBeVisible();

    await phoneA.close();
    await phoneB.close();
    await desk.close();
  });
});
