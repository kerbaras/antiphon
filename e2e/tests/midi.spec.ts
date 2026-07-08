// W3-C — MIDI capture at the desk.
//
// FEASIBILITY: Chromium ships no fake-MIDI-device launch flag — nothing like
// --use-fake-device-for-media-stream exists for Web MIDI (its fake MIDI
// managers live only in browser-internal unit tests), and Playwright can at
// most grant the "midi" permission to an empty input list. So this journey
// injects a scripted MIDIAccess double through the module's documented test
// hook (__antiphonFakeMidi, read by use-desk-midi.ts before touching
// navigator) and drives it from the test. The model and .mid writer carry
// the deep coverage in unit tests; this spec proves the UI-visible loop:
// pick input → armed lane → take captures timestamped events → MIDI lane
// renders under the audio rows → .mid downloads and parses → one-click
// resume after a reload feeds the next take (A12 continuity).

import { readFile } from "node:fs/promises";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { parseMidi } from "./helpers/files";
import { expectTakeConverged, joinAsRecorder, startTake, stopTake } from "./helpers/session";

// ---- fake Web MIDI + page hook readers ----------------------------------------

interface DeskMidiSnapshot {
  phase: "off" | "picking" | "live";
  input: { id: string; label: string } | null;
  capturing: boolean;
  liveEventCount: number;
  overflowed: boolean;
  resumeLabel: string | null;
  revision: number;
}

/** Install the scripted MIDIAccess double before any page script runs; one
 * input ("Fake Keys 61"), with a window-level emitter the test drives.
 * Runs per navigation, so the fake survives the reload leg. */
async function installFakeMidi(context: BrowserContext) {
  await context.addInitScript(() => {
    type MidiListener = (e: { data: Uint8Array; timeStamp: number }) => void;
    const listeners = new Set<MidiListener>();
    const input = {
      id: "fake-keys",
      name: "Fake Keys 61",
      manufacturer: "Antiphon E2E",
      state: "connected",
      addEventListener: (_type: string, listener: MidiListener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: MidiListener) => {
        listeners.delete(listener);
      },
    };
    const g = globalThis as unknown as Record<string, unknown>;
    g.__antiphonFakeMidi = {
      inputs: new Map([[input.id, input]]),
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    g.__antiphonFakeMidiEmit = (bytes: number[]) => {
      // timeStamp in the performance.now() domain, like real MIDIMessageEvents.
      for (const l of listeners) l({ data: new Uint8Array(bytes), timeStamp: performance.now() });
    };
  });
}

async function deskMidiState(desk: Page): Promise<DeskMidiSnapshot | null> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDeskMidi?: { snapshot(): DeskMidiSnapshot | null };
      }
    ).__antiphonDeskMidi;
    return hook?.snapshot() ?? null;
  });
}

async function takeEventCount(desk: Page, takeId: string): Promise<number> {
  return await desk.evaluate((id) => {
    const hook = (
      globalThis as unknown as {
        __antiphonDeskMidi?: { takeMidi(takeId: string): { events: unknown[] } | null };
      }
    ).__antiphonDeskMidi;
    return hook?.takeMidi(id)?.events.length ?? 0;
  }, takeId);
}

async function emitMidi(desk: Page, bytes: number[]): Promise<void> {
  await desk.evaluate((b) => {
    (
      globalThis as unknown as { __antiphonFakeMidiEmit?: (bytes: number[]) => void }
    ).__antiphonFakeMidiEmit?.(b);
  }, bytes);
}

test.describe("desk MIDI capture (W3-C)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("captures a take's MIDI, renders the lane, exports a valid .mid, and resumes after reload (A12)", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const sessionId = crypto.randomUUID();

    const context = await browser.newContext();
    await installFakeMidi(context);
    const desk = await context.newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    // --- arm the MIDI lane: probe → picker → live --------------------------
    await desk.getByRole("button", { name: /add midi input/i }).click();
    const picker = desk.getByRole("combobox", { name: "MIDI input device" });
    await expect(picker).toBeVisible();
    await expect(picker.locator("option").first()).toHaveText("Fake Keys 61 — Antiphon E2E");
    await desk.getByRole("button", { name: "Use input" }).click();
    await expect
      .poll(async () => (await deskMidiState(desk))?.phase ?? "off", { timeout: 10_000 })
      .toBe("live");
    await expect(desk.getByText("data lane — export to your DAW")).toBeVisible();

    // --- one phone provides the audio stream the take needs ----------------
    const phone = await (await browser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId);
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

    // --- take 1: play while rolling ----------------------------------------
    const take1 = await startTake(desk);
    await expect
      .poll(async () => (await deskMidiState(desk))?.capturing ?? false, { timeout: 15_000 })
      .toBe(true);
    // One of each captured kind, plus two that must be dropped (sysex,
    // realtime) — spaced so the take timeline spreads the note spans.
    await emitMidi(desk, [0xc0, 5]); // program change
    await emitMidi(desk, [0x90, 60, 100]); // C4 on
    await desk.waitForTimeout(400);
    await emitMidi(desk, [0xb0, 64, 127]); // sustain on
    await emitMidi(desk, [0xe0, 0x00, 0x50]); // pitch bend
    await emitMidi(desk, [0xf0, 0x7e, 0xf7]); // sysex — dropped
    await emitMidi(desk, [0xf8]); // clock — dropped
    await desk.waitForTimeout(400);
    await emitMidi(desk, [0x80, 60, 64]); // C4 off
    await emitMidi(desk, [0x90, 64, 90]); // E4 on
    await desk.waitForTimeout(300);
    await emitMidi(desk, [0x90, 64, 0]); // E4 off (vel-0 convention)
    await emitMidi(desk, [0xb0, 64, 0]); // sustain off
    await expect
      .poll(async () => (await deskMidiState(desk))?.liveEventCount ?? 0, { timeout: 10_000 })
      .toBe(8);
    await desk.waitForTimeout(1_000);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, take1, 1);

    // --- the MIDI lane appears under the audio rows -------------------------
    await expect(desk.locator("[data-midi-lane]")).toBeVisible({ timeout: 20_000 });
    await expect(desk.locator("[data-midi-note]")).toHaveCount(2); // C4 + E4 spans
    await expect(desk.getByText("8 ev")).toBeVisible();

    // --- .mid export downloads and parses ------------------------------------
    const exportButton = desk.getByRole("button", { name: "Export ▾" });
    await expect(exportButton).toBeEnabled({ timeout: 30_000 });
    await exportButton.click();
    const midiItem = desk.getByRole("menuitem", { name: /^MIDI \(\.mid\)/ });
    await expect(midiItem).toBeEnabled();
    const [download] = await Promise.all([desk.waitForEvent("download"), midiItem.click()]);
    expect(download.suggestedFilename()).toMatch(/^take-\d{2}\.mid$/);
    const mid = parseMidi(await readFile(await download.path()));
    expect(mid.format).toBe(0);
    expect(mid.trackCount).toBe(1);
    expect(mid.tpqn).toBe(480);
    expect(mid.tempoUsPerQuarter).toBe(500_000); // 120 BPM contract in-file
    expect(mid.events).toHaveLength(8);
    // Every captured kind made it; the dropped kinds did not.
    const kinds = new Set(mid.events.map((e) => e.status & 0xf0));
    expect([...kinds].sort()).toEqual([0x80, 0x90, 0xb0, 0xc0, 0xe0]);
    // The waits between emissions are visible as advancing ticks.
    const noteOnTicks = mid.events.filter((e) => (e.status & 0xf0) === 0x90).map((e) => e.tick);
    expect(noteOnTicks[1] as number).toBeGreaterThan(noteOnTicks[0] as number);
    const first = mid.events[0];
    expect(first?.status).toBe(0xc0);
    expect(first?.data).toEqual([5]);

    // --- reload: lane persists (localStorage), one-click resume (A12) -------
    await desk.reload();
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();
    // The stored take re-renders its lane before any MIDI re-arming.
    await expect(desk.locator("[data-midi-lane]")).toBeVisible({ timeout: 30_000 });
    await expect(desk.locator("[data-midi-note]")).toHaveCount(2);
    const resume = desk.getByRole("button", { name: /resume midi input/i });
    await expect(resume).toBeVisible();
    await expect(desk.getByText("Fake Keys 61 — Antiphon E2E")).toBeVisible();
    await resume.click();
    await expect
      .poll(async () => (await deskMidiState(desk))?.phase ?? "off", { timeout: 10_000 })
      .toBe("live");
    expect((await deskMidiState(desk))?.input?.id).toBe("fake-keys");

    // --- take 2 on the resumed input captures again --------------------------
    const take2 = await startTake(desk);
    await expect
      .poll(async () => (await deskMidiState(desk))?.capturing ?? false, { timeout: 15_000 })
      .toBe(true);
    await emitMidi(desk, [0x90, 48, 80]);
    await desk.waitForTimeout(300);
    await emitMidi(desk, [0x80, 48, 0]);
    await expect
      .poll(async () => (await deskMidiState(desk))?.liveEventCount ?? 0, { timeout: 10_000 })
      .toBe(2);
    await desk.waitForTimeout(1_000);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, take2, 1);
    await expect.poll(async () => takeEventCount(desk, take2), { timeout: 10_000 }).toBe(2);
    // Takes keep separate event stores.
    expect(await takeEventCount(desk, take1)).toBe(8);
  });
});
