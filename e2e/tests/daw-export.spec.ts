// W3-B — DAW project exports.
//
// Two phones record a chirped take; once it converges and auto-aligns, the
// Export ▾ menu's Projects section packages the take for real DAWs:
//   - Project package: aligned stems + master mix + schema-versioned
//     project.json (lane names, mixer incl. EQ, markers/songs, comments,
//     alignment + drift metadata).
//   - Ableton Live: "<take> Project.zip" holding a real .als (gzipped XML,
//     verified structurally: Live 12 header, one arrangement AudioTrack
//     per stem, project-relative sample refs, 120 BPM beat math, markers
//     as locators) plus the stems under Samples/Imported/.
//   - Logic / generic: the project package plus IMPORT-GUIDE.md.
// Every artifact is read back in Node with independent parsers
// (helpers/files.ts): ZIP walk + CRCs, WAV headers, gunzip + a hand-rolled
// XML well-formedness check. Opening the set in a real Live install is a
// manual step by design — see als.ts.

import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { sineWav } from "./helpers/align";
import { gunzipAls, parseWav, parseXmlTree, parseZip, xmlGet, xmlValue } from "./helpers/files";
import { expectTakeConverged, joinAsRecorder, startTake, stopTake } from "./helpers/session";

// Deterministic-decline mics (W6-C QA): the ruler-coordinate marker math
// below assumes the take's room-zero anchor is 0, but the default beep
// grid stochastically crosses the content-accept bar (helpers/align.ts
// sineWav rationale) — and an applied verdict now honestly shifts the
// ruler mapping right by the anchor, so a rare false accept moved the
// dblclick marker out of range. The sine declines by construction; every
// assertion (manifest chirp field included — declined is still a recorded
// measurement) stays strict.
const sinePath = path.join(os.tmpdir(), `antiphon-daw-export-sine-${process.pid}.wav`);
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

async function loadedTake(desk: Page): Promise<{ takeId: string | null; tracks: number }> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: {
          playerSnapshot(): { loadedTakeId: string | null; tracks: unknown[] } | null;
        };
      }
    ).__antiphonDesk;
    const snap = hook?.playerSnapshot();
    return { takeId: snap?.loadedTakeId ?? null, tracks: snap?.tracks.length ?? 0 };
  });
}

/** Set the performer nickname through the join page (A13) — stems, DAW
 * track names and the manifest's lanes must all carry it. */
async function renamePerformer(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: /edit/i }).click();
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
}

/** Open Export ▾, download via one Projects menu item, check the name. */
async function exportVia(desk: Page, item: RegExp, fileName: string): Promise<Buffer> {
  const exportButton = desk.getByRole("button", { name: "Export ▾" });
  await expect(exportButton).toBeEnabled({ timeout: 30_000 }); // busy cleared
  await exportButton.click();
  const menuItem = desk.getByRole("menuitem", { name: item });
  await expect(menuItem).toBeEnabled({ timeout: 30_000 });
  const [download] = await Promise.all([desk.waitForEvent("download"), menuItem.click()]);
  expect(download.suggestedFilename()).toBe(fileName);
  return await readFile(await download.path());
}

// Default zoom: 24 px/sec; the first take sits at +1 s on the arrangement.
const PX_PER_SEC = 24;
const TAKE_BASE_SEC = 1;

// project.json shape under test (mirrors project-manifest.ts).
interface Manifest {
  format: string;
  version: number;
  sessionId: string;
  takeId: string;
  sampleRate: number;
  bitDepth: number;
  range: { startSec: number; endSec: number };
  master: { file: string; gainDb: number; pan: number; eq: { bypassed: boolean } };
  stems: Array<{
    file: string;
    streamId: string;
    lane: { key: string; name: string; peerId: string | null };
    mixer: { gainDb: number; pan: number; muted: boolean; soloed: boolean; eq: { midHz: number } };
    chirp: { lagSamples: number; confidence: number; applied: boolean } | null;
    drift: { ppm: number; isReference: boolean } | null;
    baked: { headSec: number; ratio: number; clipDelaySec: number };
  }>;
  markers: Array<{ id: string; name: string; atSec: number }>;
  songs: Array<{ index: number; name: string; startSec: number; endSec: number | null }>;
  comments: unknown[];
}

test.describe("DAW project exports (W3-B)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("project package, Ableton Live project, and Logic stems package", async ({ browser }) => {
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

    // --- a short chirped take (auto-aligns on load) --------------------------
    const takeId = await startTake(desk);
    await desk.getByRole("button", { name: "Chirp" }).click();
    await expect(desk.getByText(/chirp emitted/i)).toBeVisible();
    await desk.waitForTimeout(4_000);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, takeId, 2);
    await expect
      .poll(
        async () => {
          const snap = await loadedTake(desk);
          return snap.takeId === takeId && snap.tracks === 2;
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
    const markerSecs = markers.map((m) => m.atSec);

    // ---- 1. Project package --------------------------------------------------
    const projectZip = parseZip(await exportVia(desk, /^Project package/, "take-01-project.zip"));
    const names = projectZip.map((e) => e.name).sort();
    expect(names).toEqual([
      "master.wav",
      "project.json",
      expect.stringMatching(/^stems\/Alto-[0-9a-f]{8}\.wav$/),
      expect.stringMatching(/^stems\/Tenor-[0-9a-f]{8}\.wav$/),
    ]);

    const master = parseWav(
      (projectZip.find((e) => e.name === "master.wav") as { data: Buffer }).data,
    );
    expect(master.channels).toBe(2);
    expect(master.sampleRate).toBe(48_000);
    expect(master.bitDepth).toBe(24);
    expect(master.durationSec).toBeGreaterThan(2);
    expect(master.durationSec).toBeLessThan(30);
    expect(master.hasSignal).toBe(true);

    for (const entry of projectZip.filter((e) => e.name.startsWith("stems/"))) {
      const stem = parseWav(entry.data);
      expect(stem.channels).toBe(1);
      expect(stem.sampleRate).toBe(48_000);
      expect(stem.bitDepth).toBe(24);
      // Stems and master render the same range in one export — identical length.
      expect(stem.durationSec).toBeCloseTo(master.durationSec, 6);
      expect(stem.hasSignal).toBe(true);
    }

    const manifest = JSON.parse(
      (projectZip.find((e) => e.name === "project.json") as { data: Buffer }).data.toString("utf8"),
    ) as Manifest;
    expect(manifest.format).toBe("antiphon/project");
    expect(manifest.version).toBe(1);
    expect(manifest.sessionId).toBe(sessionId);
    expect(manifest.takeId).toBe(takeId);
    expect(manifest.sampleRate).toBe(48_000);
    expect(manifest.bitDepth).toBe(24);
    expect(manifest.range.startSec).toBe(0);
    expect(manifest.range.endSec).toBeCloseTo(master.durationSec, 3);
    expect(manifest.master.file).toBe("master.wav");
    expect(manifest.master.gainDb).toBe(0);
    // One stem per lane, joined to nickname + untouched-mixer defaults.
    expect(manifest.stems.map((s) => s.lane.name).sort()).toEqual(["Alto", "Tenor"]);
    for (const stem of manifest.stems) {
      expect(stem.file).toBe(`stems/${stem.lane.name}-${stem.streamId.slice(0, 8)}.wav`);
      expect(projectZip.some((e) => e.name === stem.file)).toBe(true);
      expect(stem.lane.peerId).not.toBeNull();
      expect(stem.mixer).toMatchObject({ gainDb: 0, pan: 0, muted: false, soloed: false });
      expect(stem.mixer.eq.midHz).toBe(1_000);
      // The chirp ran on this take: a correlation result must be recorded.
      expect(stem.chirp).not.toBeNull();
      expect(stem.baked.clipDelaySec).toBe(0);
      expect(stem.baked.ratio).toBeGreaterThan(0.99);
      expect(stem.baked.ratio).toBeLessThan(1.01);
    }
    // Markers + derived songs, exactly as the desk shows them.
    expect(manifest.markers.map((m) => m.atSec)).toEqual(markerSecs);
    expect(manifest.songs.map((s) => [s.index, s.startSec, s.endSec])).toEqual([
      [1, markerSecs[0], markerSecs[1]],
      [2, markerSecs[1], null],
    ]);

    // ---- 2. Ableton Live project ----------------------------------------------
    const liveZip = parseZip(await exportVia(desk, /^Ableton Live/, "take-01 Project.zip"));
    const alsEntry = liveZip.find((e) => e.name === "take-01.als");
    expect(alsEntry).toBeDefined();
    const sampleNames = liveZip
      .filter((e) => e.name.startsWith("Samples/Imported/"))
      .map((e) => e.name)
      .sort();
    expect(sampleNames).toEqual([
      expect.stringMatching(/^Samples\/Imported\/Alto-[0-9a-f]{8}\.wav$/),
      expect.stringMatching(/^Samples\/Imported\/Tenor-[0-9a-f]{8}\.wav$/),
    ]);
    expect(liveZip).toHaveLength(3); // the .als + exactly the two stems
    for (const name of sampleNames) {
      const wav = parseWav((liveZip.find((e) => e.name === name) as { data: Buffer }).data);
      expect(wav.channels).toBe(1);
      expect(wav.sampleRate).toBe(48_000);
      expect(wav.hasSignal).toBe(true);
    }

    // The .als gunzips to well-formed XML with the researched structure.
    const als = parseXmlTree(gunzipAls((alsEntry as { data: Buffer }).data));
    expect(als.tag).toBe("Ableton");
    expect(als.attrs.MajorVersion).toBe("5");
    expect(als.attrs.MinorVersion).toBe("12.0_12049");
    expect(als.attrs.Creator).toBe("Antiphon");

    const tracks = xmlGet(als, "LiveSet", "Tracks").children;
    expect(tracks.map((t) => t.tag)).toEqual(["AudioTrack", "AudioTrack"]);
    const trackNames = tracks.map((t) => xmlValue(t, "Name", "EffectiveName")).sort();
    expect(trackNames).toEqual(["Alto", "Tenor"]);
    for (const track of tracks) {
      const clip = xmlGet(
        track,
        "DeviceChain",
        "MainSequencer",
        "Sample",
        "ArrangerAutomation",
        "Events",
        "AudioClip",
      );
      // Aligned stems: every clip starts at 0 and spans duration × 2 beats
      // (fixed 120 BPM), unwarped so the audio plays bit-faithfully.
      expect(clip.attrs.Time).toBe("0");
      expect(xmlValue(clip, "CurrentStart")).toBe("0");
      expect(Number(xmlValue(clip, "CurrentEnd"))).toBeCloseTo(master.durationSec * 2, 3);
      expect(xmlValue(clip, "IsWarped")).toBe("false");
      // Sample refs are project-relative and point at REAL zip entries.
      const ref = xmlGet(clip, "SampleRef", "FileRef");
      expect(xmlValue(ref, "RelativePathType")).toBe("3");
      const relPath = xmlValue(ref, "RelativePath");
      expect(sampleNames).toContain(relPath);
      const sampleEntry = liveZip.find((e) => e.name === relPath) as { data: Buffer };
      expect(Number(xmlValue(ref, "OriginalFileSize"))).toBe(sampleEntry.data.length);
      // Unity mixer as the desk had it.
      expect(Number(xmlValue(track, "DeviceChain", "Mixer", "Volume", "Manual"))).toBeCloseTo(1, 6);
      expect(xmlValue(track, "DeviceChain", "Mixer", "Speaker", "Manual")).toBe("true");
    }
    // Live needs a tempo for beat placement: the fixed 120 BPM.
    expect(xmlValue(als, "LiveSet", "MainTrack", "DeviceChain", "Mixer", "Tempo", "Manual")).toBe(
      "120",
    );
    // Markers became locators at atSec × 2 beats.
    const locators = xmlGet(als, "LiveSet", "Locators", "Locators").children;
    expect(locators).toHaveLength(2);
    expect(locators.map((l) => Number(xmlValue(l, "Time")))).toEqual(markerSecs.map((s) => s * 2));
    expect(locators.map((l) => xmlValue(l, "Name"))).toEqual(["Song 1", "Song 2"]);

    // ---- 3. Logic / generic stems package --------------------------------------
    const logicZip = parseZip(
      await exportVia(desk, /^Logic \/ generic/, "take-01-logic-stems.zip"),
    );
    const logicNames = logicZip.map((e) => e.name).sort();
    expect(logicNames).toEqual([
      "IMPORT-GUIDE.md",
      "master.wav",
      "project.json",
      expect.stringMatching(/^stems\/Alto-[0-9a-f]{8}\.wav$/),
      expect.stringMatching(/^stems\/Tenor-[0-9a-f]{8}\.wav$/),
    ]);
    const guide = (
      logicZip.find((e) => e.name === "IMPORT-GUIDE.md") as { data: Buffer }
    ).data.toString("utf8");
    expect(guide).toContain("Logic Pro has no documented project format");
    expect(guide).toContain("stems/*.wav");
    // The guide lists each stem by lane name and every song marker.
    expect(guide).toContain("Alto");
    expect(guide).toContain("Tenor");
    expect(guide).toContain("01 Song 1");
    expect(guide).toContain("02 Song 2");

    await phoneA.close();
    await phoneB.close();
    await desk.close();
  });
});
