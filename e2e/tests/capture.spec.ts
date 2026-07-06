// Capture-path proof in a real browser: fake mic → worklet → SAB ring →
// WASM encoder worker → chunked take → local FLAC reassembly. Runs on
// Chromium (fake-device flags); real-iPhone verification follows
// docs/ios-capture-runbook.md.

import { expect, test } from "@playwright/test";

interface HookSnapshot {
  contextSampleRate: number | null;
  flags: {
    echoCancellation: boolean | string | undefined;
    noiseSuppression: boolean | string | undefined;
    autoGainControl: boolean | string | undefined;
  } | null;
  stats: {
    state: string;
    nextSeq: number;
    finalSeq: number | null;
    samplesIn: number;
    gaps: Array<[number, number]>;
  } | null;
  ring: { droppedSamples: number; capacity: number } | null;
  peak: number;
  localChunks: number;
  finalSeq: number | null;
}

declare global {
  interface Window {
    __antiphon?: { snapshot(): HookSnapshot | null };
  }
}

function snapshot(page: import("@playwright/test").Page): Promise<HookSnapshot | null> {
  return page.evaluate(() => window.__antiphon?.snapshot() ?? null);
}

test.describe("capture path", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("records a local take: chunks, no gaps, no drops, playable flac", async ({ page }) => {
    await page.goto(`/join/${crypto.randomUUID()}`);
    await page.getByRole("button", { name: /enable microphone/i }).click();

    // Pipeline up: capture flags honored (fake device applies constraints).
    await expect(page.getByRole("button", { name: /record/i })).toBeVisible();
    const before = await snapshot(page);
    expect(before?.contextSampleRate).toBeGreaterThan(8_000);
    expect(before?.flags?.echoCancellation).not.toBe(true);
    expect(before?.flags?.noiseSuppression).not.toBe(true);
    expect(before?.flags?.autoGainControl).not.toBe(true);

    await page.getByRole("button", { name: /record/i }).click();
    await expect.poll(async () => (await snapshot(page))?.stats?.state).toBe("streaming");

    // Capture ~2.5s — enough for several 500ms chunks.
    await page.waitForTimeout(2_500);
    const during = await snapshot(page);
    expect(during?.stats?.samplesIn).toBeGreaterThan(
      ((during?.contextSampleRate ?? 48_000) * 3) / 2,
    );
    expect(during?.peak).toBeGreaterThan(0.01); // the fake mic sings

    await page.getByRole("button", { name: /stop/i }).click();
    // Local sink acks synchronously → take reaches CLOSED, not just DRAINING.
    await expect.poll(async () => (await snapshot(page))?.stats?.state).toBe("closed");

    const after = await snapshot(page);
    expect(after?.finalSeq).toBeGreaterThanOrEqual(3);
    expect(after?.stats?.gaps).toEqual([]);
    expect(after?.ring?.droppedSamples).toBe(0);
    // Payload chunks 1..=final all retained for export.
    expect(after?.localChunks).toBe(after?.finalSeq);

    // Exported FLAC is structurally sound: fLaC magic + frame sync after
    // the 42-byte bootstrap; size in a plausible lossless range.
    const flac = await page.evaluate(async () => {
      const hook = (
        window as unknown as {
          __antiphon: { controller: { exportLocalFlac(): Promise<ArrayBuffer | null> } };
        }
      ).__antiphon;
      const buf = await hook.controller.exportLocalFlac();
      return buf ? Array.from(new Uint8Array(buf.slice(0, 46))).concat(buf.byteLength) : null;
    });
    expect(flac).not.toBeNull();
    const bytes = flac as number[];
    const total = bytes.pop() as number;
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("fLaC");
    expect(bytes[42]).toBe(0xff); // first FLAC frame sync byte
    expect((bytes[43] as number) & 0xfc).toBe(0xf8);
    expect(total).toBeGreaterThan(1_000);
  });

  test("take state machine survives a second take on the same page", async ({ page }) => {
    await page.goto(`/join/${crypto.randomUUID()}`);
    await page.getByRole("button", { name: /enable microphone/i }).click();
    await page.getByRole("button", { name: /record/i }).click();
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: /stop/i }).click();
    await expect.poll(async () => (await snapshot(page))?.stats?.state).toBe("closed");
    // The engine is per-take; a new local take re-arms cleanly.
    await page.getByRole("button", { name: /record/i }).click();
    await expect.poll(async () => (await snapshot(page))?.stats?.state).toBe("streaming");
    await page.getByRole("button", { name: /stop/i }).click();
    await expect.poll(async () => (await snapshot(page))?.stats?.state).toBe("closed");
  });
});
