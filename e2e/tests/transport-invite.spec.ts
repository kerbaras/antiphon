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
