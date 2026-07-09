// W4-D — transport + invite consolidation (operator dogfooding findings).
//
// (1) The main transport control is ONE context-aware button: ▶ Play when
//     idle (honestly disabled until a take is loaded), ■ Stop take while a
//     take rolls, ⏸ Pause while playing — driven here through a real
//     record → stop → converge/auto-load → play → pause journey, asserting
//     at every step that the sibling faces do NOT exist.
// (2) The avatar-stack "+" replaced both the Share button and the sidebar
//     "Invite performer" toggle: it opens an anchored popover with the join
//     QR + link + copy (clipboard-verified), dismissed by Esc (focus back
//     on the "+") and by click-away.
// (3) QA MAJOR regression: while the popover is open, the desk's global
//     shortcuts must yield to the dialog — Space on the auto-focused Copy
//     button copies natively (no playback behind the card), M drops no
//     marker.

import { expect, type Page, test } from "@playwright/test";
import { expectTakeConverged, joinAsRecorder, startTake, stopTake } from "./helpers/session";

test.skip(({ browserName }) => browserName !== "chromium", "fake mic / desktop desk journeys");

/** Player truth through the desk hook (endstop.spec's pattern). */
async function enginePlaying(desk: Page): Promise<boolean> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: { player: { snapshot(): { playing: boolean } } };
      }
    ).__antiphonDesk;
    return hook?.player.snapshot().playing ?? false;
  });
}

test("one transport button: Play → Stop take → Play → Pause across a take", async ({ browser }) => {
  test.setTimeout(120_000);
  const sessionId = crypto.randomUUID();

  const context = await browser.newContext();
  // The clipboard grant serves the popover-open Space check further down.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const desk = await context.newPage();
  await desk.goto(`/session/${sessionId}`);
  await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

  const play = desk.getByRole("button", { name: "Play", exact: true });
  const pause = desk.getByRole("button", { name: "Pause", exact: true });
  const stop = desk.getByRole("button", { name: "Stop take", exact: true });

  // Idle, empty session: the button reads Play and is honestly disabled —
  // nothing is loaded to play. Its other faces don't exist anywhere.
  await expect(play).toBeVisible();
  await expect(play).toBeDisabled();
  await expect(pause).toHaveCount(0);
  await expect(stop).toHaveCount(0);

  const phone = await (await browser.newContext()).newPage();
  await joinAsRecorder(phone, sessionId);
  await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

  // Record: the same slot turns into an enabled Stop (the shared stopTake
  // helper — and every legacy spec through it — clicks THIS button).
  const takeId = await startTake(desk);
  await expect(stop).toBeEnabled();
  await expect(play).toHaveCount(0);
  await expect(pause).toHaveCount(0);
  await desk.waitForTimeout(2_000);

  // Stop → converge → auto-load: the slot reads Play again, enabled now.
  await stopTake(desk);
  await expectTakeConverged(desk, sessionId, takeId, 1);
  await expect(play).toBeEnabled({ timeout: 30_000 });
  await expect(stop).toHaveCount(0);

  // Play: the slot becomes Pause (accent-active), Record disables —
  // playback and recording stay mutually exclusive.
  await play.click();
  await expect(pause).toBeVisible();
  await expect(play).toHaveCount(0);
  await expect(desk.getByRole("button", { name: "Record take" })).toBeDisabled();

  // Pause: back to an enabled Play, transport idle.
  await pause.click();
  await expect(play).toBeEnabled();
  await expect(pause).toHaveCount(0);

  // QA MAJOR: with a take LOADED and the invite popover open, Space on the
  // auto-focused Copy button must be the native button click — clipboard
  // gets the join URL, and playback does NOT start behind the dialog (the
  // global shortcut handler exempts [role="dialog"] targets).
  await desk.getByRole("button", { name: "Invite performer", exact: true }).click();
  const dialog = desk.getByRole("dialog", { name: "Invite performers" });
  await expect(dialog.getByRole("button", { name: "Copy link" })).toBeFocused();
  await desk.keyboard.press("Space");
  await expect(dialog.getByRole("button", { name: "Copied!" })).toBeVisible();
  const copied = await desk.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(`${new URL(desk.url()).origin}/join/${sessionId}`);
  expect(await enginePlaying(desk)).toBe(false);
  await expect(pause).toHaveCount(0);

  // M while the dialog owns focus drops no song marker either.
  const markerCount = () =>
    desk.evaluate(() => {
      const hook = (
        globalThis as unknown as { __antiphonDesk?: { ui(): { markers: unknown[] } | null } }
      ).__antiphonDesk;
      return hook?.ui()?.markers.length ?? 0;
    });
  const markersBefore = await markerCount();
  await desk.keyboard.press("KeyM");
  expect(await markerCount()).toBe(markersBefore);
  await desk.keyboard.press("Escape");

  // W5-B — Space-vs-loading parity (twice QA-flagged): wedge the player
  // into a decode that never finishes (an assemble promise that never
  // resolves), exactly what a slow take load looks like. ▶ disables — and
  // Space must be a no-op through the same gate (playActionReady). Before
  // the fix this Space started the OLD take playing behind the disabled
  // button.
  await desk.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.(); // Esc parked focus on the "+"
    const hook = (
      globalThis as unknown as {
        __antiphonDesk: {
          player: {
            load(
              takeId: string,
              streamIds: string[],
              assemble: () => Promise<ArrayBuffer | null>,
            ): Promise<boolean>;
          };
        };
      }
    ).__antiphonDesk;
    void hook.player.load("w5b-wedged-take", ["w5b-wedged-stream"], () => new Promise(() => {}));
  });
  await expect(play).toBeDisabled();
  await desk.keyboard.press("Space");
  await desk.waitForTimeout(400); // a beat for the would-be toggle to surface
  expect(await enginePlaying(desk), "Space is a no-op exactly when ▶ is disabled").toBe(false);

  await phone.close();
  await desk.close();
});

test("the + invite popover: QR + link, copy feedback, Esc/click-away dismiss", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const desk = await context.newPage();
  const sessionId = crypto.randomUUID();
  await desk.goto(`/session/${sessionId}`);
  await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

  // The Share button and the sidebar "+ Invite performer" toggle are gone:
  // the avatar-stack "+" is the ONE invite affordance. (The Performers tab
  // keeps its always-on QR card for the wall-poster case — selected
  // explicitly, not assumed as the default, then asserted so the popover's
  // QR provably isn't counted twice.)
  await expect(desk.getByRole("button", { name: "Share" })).toHaveCount(0);
  await expect(desk.getByRole("button", { name: /\+ Invite performer/ })).toHaveCount(0);
  const invite = desk.getByRole("button", { name: "Invite performer", exact: true });
  await expect(invite).toBeVisible();
  await desk.getByRole("button", { name: /^performers/i }).click();
  await expect(desk.locator('svg[aria-label="Join QR code"]')).toHaveCount(1);

  // Open: QR + join link, focus straight on the one action in the card.
  const dialog = desk.getByRole("dialog", { name: "Invite performers" });
  await expect(dialog).toHaveCount(0);
  await invite.click();
  await expect(dialog).toBeVisible();
  await expect(invite).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.locator('svg[aria-label="Join QR code"]')).toBeVisible();
  await expect(dialog.getByText(`/join/${sessionId}`)).toBeVisible();
  const copy = dialog.getByRole("button", { name: "Copy link" });
  await expect(copy).toBeFocused();

  // Copy: the clipboard carries the join URL; the button says so, briefly.
  await copy.click();
  await expect(dialog.getByRole("button", { name: "Copied!" })).toBeVisible();
  const copied = await desk.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(`${new URL(desk.url()).origin}/join/${sessionId}`);

  // Esc dismisses and hands focus back to the "+" that opened it.
  await desk.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(invite).toBeFocused();
  await expect(invite).toHaveAttribute("aria-expanded", "false");

  // Click-away (the backdrop) dismisses too.
  await invite.click();
  await expect(dialog).toBeVisible();
  await desk.getByRole("button", { name: "Close invite popover" }).click();
  await expect(dialog).toHaveCount(0);

  await desk.close();
});

// W5-B — the W4-D parked nit: at ≤1000px the open popover stacks straight
// over the performers tab's wall-poster QR — two loud QRs read as a choice
// that doesn't exist. The poster now yields while the popover is open
// (dimmed + desaturated + aria-hidden, geometry stable) and returns when it
// closes. Guarded at 1000 and at full width — the popover is the primary
// invite surface everywhere, not just where the two happen to overlap.
for (const width of [1000, 1280]) {
  test(`the wall-poster QR yields to the open invite popover at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const sessionId = crypto.randomUUID();
    await page.goto(`/session/${sessionId}`);
    await expect(page.getByRole("button", { name: "Record take" })).toBeVisible();
    await page.getByRole("button", { name: /^performers/i }).click();

    const poster = page.locator("[data-qr-yielding]");
    await expect(poster).toHaveAttribute("data-qr-yielding", "false");

    await page.getByRole("button", { name: "Invite performer", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Invite performers" });
    await expect(dialog.locator('svg[aria-label="Join QR code"]')).toBeVisible();
    await expect(poster).toHaveAttribute("data-qr-yielding", "true");
    await expect(poster).toHaveAttribute("aria-hidden", "true");
    // The dim is real (0.2 after the 150ms transition), not just declared.
    await expect
      .poll(async () => await poster.evaluate((el) => getComputedStyle(el).opacity))
      .toBe("0.2");

    // Evidence screenshot for design review (the QA finding was visual).
    await page.screenshot({ path: test.info().outputPath(`dual-qr-${width}.png`) });

    // Closing the popover brings the poster back to full strength.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(poster).toHaveAttribute("data-qr-yielding", "false");
    await expect
      .poll(async () => await poster.evaluate((el) => getComputedStyle(el).opacity))
      .toBe("1");
  });
}
