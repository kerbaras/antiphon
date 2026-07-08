// W2-C — per-track 3-band EQ (low shelf 120 Hz / sweepable mid peak /
// high shelf 8 kHz, ±12 dB, per strip + master).
//
// One phone records a short take; once it converges and auto-loads, the
// mixer strip's EQ block is exercised end to end: controls respond to
// drag/keyboard/double-click; an engaged-at-defaults EQ renders a master
// WAV byte-identical to a bypassed one (bit-transparency through the real
// biquads); a boosted EQ audibly moves the track's post-strip analyser
// versus true bypass; a boosted export differs from a bypassed export in
// bytes and RMS; and strip EQ survives a take switch like gain/pan do.
//
// Spectrum note: Chromium's fake mic (BeepingSource) emits 20 ms bursts of
// a 400 Hz pulse train every 500 ms — energy sits at 400 Hz + harmonics,
// far above the 120 Hz low shelf's corner. The provable band is therefore
// the MID peak swept down to ~400 Hz; the low shelf is boosted alongside
// (it catches the burst envelope's low-frequency energy and is the export
// comparison the workstream calls for), but the level assertions lean on
// the mid band.

import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { expectTakeConverged, joinAsRecorder, startTake, stopTake } from "./helpers/session";

// ---- WAV readers ------------------------------------------------------------
// Deliberately duplicated from export.spec.ts (a parallel workstream owns
// that file): a minimal 24-bit PCM slice + RMS, no full structural parse —
// export.spec.ts already pins the container format.

function wavPcm(bytes: Buffer): Buffer {
  expect(bytes.subarray(0, 4).toString("latin1")).toBe("RIFF");
  expect(bytes.subarray(36, 40).toString("latin1")).toBe("data");
  expect(bytes.readUInt16LE(34)).toBe(24); // bit depth
  return bytes.subarray(44, 44 + bytes.readUInt32LE(40));
}

/** RMS of all 24-bit samples, normalized to 0..1 full scale. */
function wavRms(bytes: Buffer): number {
  const pcm = wavPcm(bytes);
  let sumSq = 0;
  const count = Math.floor(pcm.length / 3);
  for (let i = 0; i < count; i++) {
    const s = pcm.readIntLE(i * 3, 3) / 0x800000;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / Math.max(1, count));
}

// ---- drivers ----------------------------------------------------------------

/** Set the performer nickname (A13) so the mixer strip carries a stable
 * accessible name for the EQ controls. */
async function renamePerformer(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: /edit/i }).click();
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
}

interface PlayerHook {
  __antiphonDesk?: {
    player: {
      snapshot(): {
        loadedTakeId: string | null;
        playing: boolean;
        tracks: Array<{ level: number }>;
        channels: Array<{ key: string; eq: { lowDb: number; midDb: number; midHz: number } }>;
      };
    };
  };
}

async function loadedTakeId(desk: Page): Promise<string | null> {
  return await desk.evaluate(
    () =>
      (globalThis as unknown as PlayerHook).__antiphonDesk?.player.snapshot().loadedTakeId ?? null,
  );
}

/** Max post-strip analyser peak (post-EQ by construction) over `ms` of
 * playback, sampled in-page every 5 ms — player.snapshot() reads the
 * meter loop's per-frame levels, so 20 ms beeps can't slip between the
 * desk UI's throttled notifies. */
async function maxTrackLevel(desk: Page, ms: number): Promise<number> {
  return await desk.evaluate(async (windowMs) => {
    const hook = (globalThis as unknown as PlayerHook).__antiphonDesk;
    let max = 0;
    const end = performance.now() + windowMs;
    while (performance.now() < end) {
      const level = hook?.player.snapshot().tracks[0]?.level ?? 0;
      if (level > max) max = level;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return max;
  }, ms);
}

async function exportMasterWav(desk: Page): Promise<Buffer> {
  const exportButton = desk.getByRole("button", { name: /Export ▾|Rendering/ });
  await expect(desk.getByRole("button", { name: "Export ▾" })).toBeEnabled({ timeout: 30_000 });
  await desk.getByRole("button", { name: "Export ▾" }).click();
  const item = desk.getByRole("menuitem", { name: /master mix/i });
  await expect(item).toBeEnabled({ timeout: 30_000 });
  const [download] = await Promise.all([desk.waitForEvent("download"), item.click()]);
  const bytes = await readFile(await download.path());
  await expect(exportButton).toBeEnabled({ timeout: 30_000 }); // busy cleared
  return bytes;
}

// ---- journey ---------------------------------------------------------------

test.describe("per-track EQ (W2-C)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("EQ controls, true bypass, transparent defaults, export parity", async ({ browser }) => {
    test.setTimeout(240_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phone = await (await browser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId);
    await renamePerformer(phone, "Alto");
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

    // --- a ~6 s take, converged and auto-loaded ---------------------------
    const takeId = await startTake(desk);
    await desk.waitForTimeout(6_000);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, takeId, 1);
    await expect.poll(() => loadedTakeId(desk), { timeout: 30_000 }).toBe(takeId);

    // --- controls render at flat defaults and respond ---------------------
    const low = desk.getByRole("slider", { name: "Alto EQ low" });
    const mid = desk.getByRole("slider", { name: "Alto EQ mid", exact: true });
    const high = desk.getByRole("slider", { name: "Alto EQ high" });
    const midFreq = desk.getByRole("slider", { name: "Alto EQ mid frequency" });
    const bypass = desk.getByRole("button", { name: "Alto EQ bypass" });
    await expect(low).toHaveAttribute("aria-valuenow", "0");
    await expect(mid).toHaveAttribute("aria-valuenow", "0");
    await expect(high).toHaveAttribute("aria-valuenow", "0");
    await expect(midFreq).toHaveAttribute("aria-valuenow", "1000");
    await expect(bypass).toHaveAttribute("aria-pressed", "false");

    // Keyboard: arrows step 0.5 dB.
    await low.focus();
    await desk.keyboard.press("ArrowUp");
    await expect(low).toHaveAttribute("aria-valuenow", "0.5");
    await desk.keyboard.press("ArrowDown");
    await expect(low).toHaveAttribute("aria-valuenow", "0");

    // Pointer: vertical drag boosts, double-click resets.
    const box = await high.boundingBox();
    if (!box) throw new Error("high knob not visible");
    await desk.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await desk.mouse.down();
    await desk.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 24, { steps: 4 });
    await desk.mouse.up();
    const dragged = Number(await high.getAttribute("aria-valuenow"));
    expect(dragged).toBeGreaterThan(0);
    await high.dblclick();
    await expect(high).toHaveAttribute("aria-valuenow", "0");

    // Mid frequency sweeps down on a log scale (6 × 1/24 ≈ 400 Hz).
    await midFreq.focus();
    for (let i = 0; i < 6; i++) await desk.keyboard.press("ArrowDown");
    const sweptHz = Number(await midFreq.getAttribute("aria-valuenow"));
    expect(sweptHz).toBeGreaterThan(360);
    expect(sweptHz).toBeLessThan(440);
    await midFreq.dblclick();
    await expect(midFreq).toHaveAttribute("aria-valuenow", "1000");

    // The master strip carries the same section.
    const masterLow = desk.getByRole("slider", { name: "MASTER EQ low" });
    await expect(masterLow).toHaveAttribute("aria-valuenow", "0");
    await masterLow.focus();
    await desk.keyboard.press("ArrowUp");
    await expect(masterLow).toHaveAttribute("aria-valuenow", "0.5");
    await desk.keyboard.press("ArrowDown");
    await expect(masterLow).toHaveAttribute("aria-valuenow", "0");

    // --- engaged-at-defaults is bit-transparent ----------------------------
    // Same take rendered with the EQ chain in the signal path (flat) and
    // with true bypass: 0 dB biquads are exact identities, so the WAVs
    // must be byte-identical — the EQ cannot color a mix nobody touched.
    const flatEngaged = await exportMasterWav(desk);
    await bypass.click();
    await expect(bypass).toHaveAttribute("aria-pressed", "true");
    const flatBypassed = await exportMasterWav(desk);
    expect(flatEngaged.equals(flatBypassed)).toBe(true);

    // --- boosted low shelf changes the export ------------------------------
    // (Strip still bypassed: band edits pre-set the filters silently.)
    await low.focus();
    await desk.keyboard.press("End");
    await expect(low).toHaveAttribute("aria-valuenow", "12");
    await bypass.click(); // engage
    await expect(bypass).toHaveAttribute("aria-pressed", "false");
    const boosted = await exportMasterWav(desk);
    expect(boosted.equals(flatBypassed)).toBe(false);
    // +12 dB below 120 Hz doubles the beep train's RMS (the burst envelope
    // carries real low-frequency energy); assert half that margin.
    expect(wavRms(boosted)).toBeGreaterThan(wavRms(flatBypassed) * 1.2);

    // --- live A/B: analyser level vs true bypass ---------------------------
    // Crank the mid peak onto the beep fundamental (~400 Hz) for a level
    // change no meter can miss, then compare max post-strip peaks across a
    // bypassed and an engaged stretch of the same playback.
    await midFreq.focus();
    for (let i = 0; i < 6; i++) await desk.keyboard.press("ArrowDown");
    await mid.focus();
    await desk.keyboard.press("End");
    await expect(mid).toHaveAttribute("aria-valuenow", "12");
    await bypass.click(); // bypass ON
    await desk.getByRole("button", { name: "Play", exact: true }).click();
    const bypassedPeak = await maxTrackLevel(desk, 1_800);
    await bypass.click(); // EQ back in, live edge swap
    await desk.waitForTimeout(250); // biquad state + smoothing settle
    const engagedPeak = await maxTrackLevel(desk, 1_800);
    await desk.getByRole("button", { name: "Pause", exact: true }).click();
    // Measured ≈0.7 vs ≈3.1 (4.4×); assert a third of that margin.
    expect(bypassedPeak).toBeGreaterThan(0.1); // beeps actually metered
    expect(engagedPeak).toBeGreaterThan(bypassedPeak * 1.5);

    // --- strip EQ survives a take switch (lane-keyed, like gain/pan) -------
    const take2 = await startTake(desk);
    await desk.waitForTimeout(2_500);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, take2, 1);
    await expect.poll(() => loadedTakeId(desk), { timeout: 30_000 }).toBe(take2);
    await expect(low).toHaveAttribute("aria-valuenow", "12");
    await expect(mid).toHaveAttribute("aria-valuenow", "12");
    const keptHz = Number(await midFreq.getAttribute("aria-valuenow"));
    expect(keptHz).toBeGreaterThan(360);
    expect(keptHz).toBeLessThan(440);
    await expect(bypass).toHaveAttribute("aria-pressed", "false");
  });
});
