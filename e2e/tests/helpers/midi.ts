// Fake Web MIDI drivers shared by midi.spec.ts (W3-C capture journey) and
// midi-opfs.spec.ts (W5-D persistence). Chromium ships no fake-MIDI-device
// launch flag — nothing like --use-fake-device-for-media-stream exists for
// Web MIDI (its fake MIDI managers live only in browser-internal unit
// tests), and Playwright can at most grant the "midi" permission to an
// empty input list. So these helpers inject a scripted MIDIAccess double
// through the module's documented test hook (__antiphonFakeMidi, read by
// use-desk-midi.ts before touching navigator) and drive it from the test.

import type { BrowserContext, Page } from "@playwright/test";

export interface DeskMidiSnapshot {
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
 * Runs per navigation, so the fake survives reload legs. */
export async function installFakeMidi(context: BrowserContext): Promise<void> {
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

export async function deskMidiState(desk: Page): Promise<DeskMidiSnapshot | null> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDeskMidi?: { snapshot(): DeskMidiSnapshot | null };
      }
    ).__antiphonDeskMidi;
    return hook?.snapshot() ?? null;
  });
}

export async function takeEventCount(desk: Page, takeId: string): Promise<number> {
  return await desk.evaluate((id) => {
    const hook = (
      globalThis as unknown as {
        __antiphonDeskMidi?: { takeMidi(takeId: string): { events: unknown[] } | null };
      }
    ).__antiphonDeskMidi;
    return hook?.takeMidi(id)?.events.length ?? 0;
  }, takeId);
}

export async function emitMidi(desk: Page, bytes: number[]): Promise<void> {
  await desk.evaluate((b) => {
    (
      globalThis as unknown as { __antiphonFakeMidiEmit?: (bytes: number[]) => void }
    ).__antiphonFakeMidiEmit?.(b);
  }, bytes);
}
