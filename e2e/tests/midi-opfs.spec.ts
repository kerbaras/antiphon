// W5-D — captured MIDI persists in OPFS, not localStorage.
//
// The unit suite covers the JSONL codec and migration orchestration against
// in-memory stores; this spec is the real-OPFS proof in chromium:
// a take's events land as antiphon-midi/<session>/<take>.jsonl (and NOT as
// a localStorage key), survive a reload from there, a pre-seeded legacy
// localStorage document migrates on first load (key deleted after), and
// the .mid export is unchanged by any of it.

import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { parseMidi } from "./helpers/files";
import { deskMidiState, emitMidi, installFakeMidi, takeEventCount } from "./helpers/midi";
import { expectTakeConverged, joinAsRecorder, startTake, stopTake } from "./helpers/session";

/** The take's OPFS JSONL text, or null when the file doesn't exist. */
async function opfsMidiText(desk: Page, sessionId: string, takeId: string): Promise<string | null> {
  return await desk.evaluate(
    async ({ sessionId, takeId }) => {
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await (await root.getDirectoryHandle("antiphon-midi")).getDirectoryHandle(
          sessionId,
        );
        const file = await (await dir.getFileHandle(`${takeId}.jsonl`)).getFile();
        return await file.text();
      } catch {
        return null;
      }
    },
    { sessionId, takeId },
  );
}

/** Per-take MIDI localStorage keys (prefs key uses a different prefix). */
async function midiLocalStorageKeys(desk: Page): Promise<string[]> {
  return await desk.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith("antiphon:midi:")),
  );
}

async function armFakeMidi(desk: Page): Promise<void> {
  await desk.getByRole("button", { name: /add midi input/i }).click();
  await expect(desk.getByRole("combobox", { name: "MIDI input device" })).toBeVisible();
  await desk.getByRole("button", { name: "Use input" }).click();
  await expect
    .poll(async () => (await deskMidiState(desk))?.phase ?? "off", { timeout: 10_000 })
    .toBe("live");
}

test.describe("desk MIDI persistence via OPFS (W5-D)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("events land in OPFS (not localStorage), survive reload, legacy localStorage migrates, .mid intact", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const sessionId = crypto.randomUUID();

    const context = await browser.newContext();
    await installFakeMidi(context);
    const desk = await context.newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();
    await armFakeMidi(desk);

    const phone = await (await browser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId);
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

    // --- capture a take: 4 events, 2 note spans ------------------------------
    const take = await startTake(desk);
    await expect
      .poll(async () => (await deskMidiState(desk))?.capturing ?? false, { timeout: 15_000 })
      .toBe(true);
    await emitMidi(desk, [0x90, 60, 100]); // C4 on
    await desk.waitForTimeout(400);
    await emitMidi(desk, [0x80, 60, 64]); // C4 off
    await emitMidi(desk, [0x90, 64, 90]); // E4 on
    await desk.waitForTimeout(300);
    await emitMidi(desk, [0x90, 64, 0]); // E4 off (vel-0 convention)
    await expect
      .poll(async () => (await deskMidiState(desk))?.liveEventCount ?? 0, { timeout: 10_000 })
      .toBe(4);
    await desk.waitForTimeout(1_000);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, take, 1);

    // --- storage honesty: OPFS holds the events, localStorage holds NOTHING --
    await expect
      .poll(async () => opfsMidiText(desk, sessionId, take), { timeout: 10_000 })
      .not.toBeNull();
    const jsonl = (await opfsMidiText(desk, sessionId, take)) as string;
    const lines = jsonl.trimEnd().split("\n");
    expect(JSON.parse(lines[0] as string)).toEqual({ antiphonMidiJsonl: 1, overflow: false });
    expect(lines).toHaveLength(5); // header + 4 events
    expect(await midiLocalStorageKeys(desk)).toEqual([]);

    // --- reload leg 1: the lane re-renders from OPFS alone -------------------
    await desk.reload();
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();
    await expect(desk.locator("[data-midi-lane]")).toBeVisible({ timeout: 30_000 });
    await expect(desk.locator("[data-midi-note]")).toHaveCount(2);
    await expect(desk.getByText("4 ev")).toBeVisible();
    expect(await midiLocalStorageKeys(desk)).toEqual([]); // never touched localStorage

    // --- .mid export from the OPFS-hydrated events is unchanged --------------
    const exportButton = desk.getByRole("button", { name: "Export ▾" });
    await expect(exportButton).toBeEnabled({ timeout: 30_000 });
    await exportButton.click();
    const midiItem = desk.getByRole("menuitem", { name: /^MIDI \(\.mid\)/ });
    await expect(midiItem).toBeEnabled();
    const [download] = await Promise.all([desk.waitForEvent("download"), midiItem.click()]);
    const mid = parseMidi(await readFile(await download.path()));
    expect(mid.format).toBe(0);
    expect(mid.tpqn).toBe(480);
    expect(mid.events).toHaveLength(4);
    expect(new Set(mid.events.map((e) => e.status & 0xf0))).toEqual(new Set([0x80, 0x90]));

    // --- migration leg: fabricate the pre-W5-D state for this very take ------
    // (legacy localStorage document present, no OPFS file), as a desk that
    // recorded before the OPFS move would find on its next visit.
    const legacyDoc = JSON.stringify({
      v: 1,
      events: [
        { atSec: 0.1, status: 0x90, data1: 48, data2: 80 }, // C3 on
        { atSec: 0.9, status: 0x80, data1: 48, data2: 0 }, // C3 off
        { atSec: 1.2, status: 0xc0, data1: 7, data2: 0 }, // program change
      ],
      overflow: false,
    });
    await desk.evaluate(
      async ({ sessionId, takeId, doc }) => {
        localStorage.setItem(`antiphon:midi:${sessionId}:${takeId}`, doc);
        const root = await navigator.storage.getDirectory();
        const dir = await (await root.getDirectoryHandle("antiphon-midi")).getDirectoryHandle(
          sessionId,
        );
        await dir.removeEntry(`${takeId}.jsonl`);
      },
      { sessionId, takeId: take, doc: legacyDoc },
    );

    // --- reload leg 2: first load migrates — events served, key gone, file back
    await desk.reload();
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();
    await expect(desk.locator("[data-midi-lane]")).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => takeEventCount(desk, take), { timeout: 10_000 }).toBe(3);
    await expect(desk.locator("[data-midi-note]")).toHaveCount(1); // the C3 span
    await expect.poll(async () => midiLocalStorageKeys(desk), { timeout: 10_000 }).toEqual([]); // read → written to OPFS → key deleted
    const migrated = (await opfsMidiText(desk, sessionId, take)) as string;
    expect(migrated).not.toBeNull();
    expect(migrated.trimEnd().split("\n")).toHaveLength(4); // header + 3 migrated events
  });
});
