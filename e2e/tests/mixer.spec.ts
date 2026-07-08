// F13 — mixer strip gain faders and pan knobs must be real sliders:
// keyboard-operable (arrows step, Home/End to the rails — the EQ knobs'
// conventions), double-click resets (fader → 0 dB; the pre-fix fader
// applied jump-to-click twice and landed at ~−27.5 dB instead), and the
// fader carries aria-valuetext mirroring the strip readout ("−∞ dB" at
// the bottom rail — aria-valuenow alone rounds and can't say −∞).
//
// Exercised on the MASTER strip of a bare desk: Fader/PanKnob are the
// same components on every lane strip (daw.tsx MixerStrip), the master
// renders without a phone or a take, and its edits flow through the same
// player setters (setMasterDb/setMasterPan) that drags commit through —
// eq.spec.ts covers the lane-strip flavor of these controls end to end.

import { expect, type Page, test } from "@playwright/test";

interface PlayerHook {
  __antiphonDesk?: {
    player: { snapshot(): { masterDb: number; masterPan: number } };
  };
}

async function masterDb(desk: Page): Promise<number | null> {
  return await desk.evaluate(
    () => (globalThis as unknown as PlayerHook).__antiphonDesk?.player.snapshot().masterDb ?? null,
  );
}

async function masterPan(desk: Page): Promise<number | null> {
  return await desk.evaluate(
    () => (globalThis as unknown as PlayerHook).__antiphonDesk?.player.snapshot().masterPan ?? null,
  );
}

test.describe("mixer strip controls (F13)", () => {
  test("gain fader: keyboard steps, rails, double-click reset, −∞ valuetext", async ({ page }) => {
    await page.goto(`/session/${crypto.randomUUID()}`);
    await expect(page.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const fader = page.getByRole("slider", { name: "MASTER gain" });
    await expect(fader).toHaveAttribute("aria-valuenow", "0");
    await expect(fader).toHaveAttribute("aria-valuetext", "0.0 dB");
    await expect(fader).toHaveAttribute("aria-valuemin", "-60");
    await expect(fader).toHaveAttribute("aria-valuemax", "6");

    // Arrows step 0.5 dB and commit through the player (the drag path).
    await fader.focus();
    await page.keyboard.press("ArrowUp");
    await expect(fader).toHaveAttribute("aria-valuenow", "0.5");
    await expect(fader).toHaveAttribute("aria-valuetext", "0.5 dB");
    expect(await masterDb(page)).toBe(0.5);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(fader).toHaveAttribute("aria-valuenow", "-0.5");
    await expect(fader).toHaveAttribute("aria-valuetext", "-0.5 dB");

    // Home/End hit the rails; the bottom rail reads −∞ (valuetext + the
    // strip's visible readout), not a rounded finite number.
    await page.keyboard.press("End");
    await expect(fader).toHaveAttribute("aria-valuenow", "6");
    await expect(fader).toHaveAttribute("aria-valuetext", "6.0 dB");
    await page.keyboard.press("Home");
    await expect(fader).toHaveAttribute("aria-valuenow", "-60");
    await expect(fader).toHaveAttribute("aria-valuetext", "−∞ dB");
    await expect(page.getByText("−∞ dB")).toBeVisible();
    expect(await masterDb(page)).toBe(-60);

    // Double-click resets to 0 dB. Pre-fix this applied jump-to-click
    // twice and parked the fader wherever the pointer sat (~−27.5 dB at
    // the track's center).
    await fader.dblclick();
    await expect(fader).toHaveAttribute("aria-valuenow", "0");
    await expect(fader).toHaveAttribute("aria-valuetext", "0.0 dB");
    expect(await masterDb(page)).toBe(0);

    // Single-click jump-to-click survives the dblclick suppression: a
    // click near the top of the track jumps toward the +6 rail.
    const box = await fader.boundingBox();
    if (!box) throw new Error("fader not visible");
    await page.mouse.click(box.x + box.width / 2, box.y + 6);
    expect(Number(await fader.getAttribute("aria-valuenow"))).toBeGreaterThan(2);
    await fader.dblclick();
    await expect(fader).toHaveAttribute("aria-valuenow", "0");
  });

  test("pan knob: keyboard steps, rails, double-click recenters", async ({ page }) => {
    await page.goto(`/session/${crypto.randomUUID()}`);
    await expect(page.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const knob = page.getByRole("slider", { name: "MASTER pan" });
    await expect(knob).toHaveAttribute("aria-valuenow", "0");
    await expect(knob).toHaveAttribute("aria-valuetext", "C");

    // Arrows step 0.05 on the drag's own grid (Right/Up pan right,
    // Left/Down pan left — the drag axes), committed via setMasterPan.
    await knob.focus();
    await page.keyboard.press("ArrowRight");
    await expect(knob).toHaveAttribute("aria-valuenow", "5");
    await expect(knob).toHaveAttribute("aria-valuetext", "R5");
    expect(await masterPan(page)).toBe(0.05);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(knob).toHaveAttribute("aria-valuenow", "-5");
    await expect(knob).toHaveAttribute("aria-valuetext", "L5");

    // Home/End hit the rails; Up steps right off the left rail.
    await page.keyboard.press("End");
    await expect(knob).toHaveAttribute("aria-valuenow", "100");
    await expect(knob).toHaveAttribute("aria-valuetext", "R100");
    await page.keyboard.press("Home");
    await expect(knob).toHaveAttribute("aria-valuenow", "-100");
    await expect(knob).toHaveAttribute("aria-valuetext", "L100");
    await page.keyboard.press("ArrowUp");
    await expect(knob).toHaveAttribute("aria-valuenow", "-95");

    // Double-click recenters (pre-existing behavior, kept).
    await knob.dblclick();
    await expect(knob).toHaveAttribute("aria-valuenow", "0");
    await expect(knob).toHaveAttribute("aria-valuetext", "C");
    expect(await masterPan(page)).toBe(0);
  });
});
