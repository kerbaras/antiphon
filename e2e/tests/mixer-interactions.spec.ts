// W4-E — mixer interaction batch, end to end:
//   1. Strip names rename inline on the mixer (same A13 peer-update path
//      as the sidebar title: server persists, roster echo updates BOTH).
//   2. Wheel over a strip trims that strip's fader (master included):
//      ~1 dB per notch, alt for 0.1 dB fine moves, clamped to the fader
//      range, horizontal gestures left to the dock's overflow-x scroll.
//   3. Clicking a lane (sidebar header or mixer strip) selects it in both
//      surfaces; S solos / M mutes the selected lane — never while typing.
//   4. Right-click opens the lane context menu: Move up/down reorders
//      through the shared doc (persists across a desk reload), Solo/Mute
//      toggle the strip, Delete stages the lane's clips behind the F2
//      confirm dialog.

import { expect, type Page, test } from "@playwright/test";
import {
  deskState,
  deskStatus,
  expectTakeConverged,
  joinAsRecorder,
  recorderState,
  renamePeerFromDesk,
  startTake,
  stopTake,
} from "./helpers/session";

// ---- desk hook readers -------------------------------------------------------

interface PlayerHook {
  __antiphonDesk?: {
    player: {
      snapshot(): {
        masterDb: number;
        loadedTakeId: string | null;
        channels: Array<{ key: string; gainDb: number; muted: boolean; soloed: boolean }>;
      };
    };
    ui(): {
      lanes: Array<{ key: string; name: string }>;
      markers: Array<{ id: string }>;
      playheadSec: number | null;
    } | null;
  };
}

async function masterDb(desk: Page): Promise<number | null> {
  return await desk.evaluate(
    () => (globalThis as unknown as PlayerHook).__antiphonDesk?.player.snapshot().masterDb ?? null,
  );
}

async function channelStrip(
  desk: Page,
  key: string,
): Promise<{ gainDb: number; muted: boolean; soloed: boolean } | null> {
  return await desk.evaluate((channelKey) => {
    const strip = (globalThis as unknown as PlayerHook).__antiphonDesk?.player
      .snapshot()
      .channels.find((c) => c.key === channelKey);
    return strip ? { gainDb: strip.gainDb, muted: strip.muted, soloed: strip.soloed } : null;
  }, key);
}

/** Track rows in render order (the mixer strips mirror rows 1:1). */
async function laneOrder(desk: Page): Promise<string[]> {
  return await desk.evaluate(() => {
    const hook = (globalThis as unknown as PlayerHook).__antiphonDesk;
    return (hook?.ui()?.lanes ?? []).map((l) => l.name);
  });
}

async function markerCount(desk: Page): Promise<number> {
  return await desk.evaluate(
    () => (globalThis as unknown as PlayerHook).__antiphonDesk?.ui()?.markers.length ?? 0,
  );
}

async function loadedTakeId(desk: Page): Promise<string | null> {
  return await desk.evaluate(
    () =>
      (globalThis as unknown as PlayerHook).__antiphonDesk?.player.snapshot().loadedTakeId ?? null,
  );
}

/** The rendered playhead (W4-C: a bare-surface click parks a pin here even
 * with nothing loaded) — the W4-C×W4-E seam probe: lane-HEADER presses are
 * selection/menu gestures and must never move it. */
async function uiPlayhead(desk: Page): Promise<number | null> {
  return await desk.evaluate(
    () => (globalThis as unknown as PlayerHook).__antiphonDesk?.ui()?.playheadSec ?? null,
  );
}

// ---- 2 · wheel-to-fader (master strip: no phone, no take needed) ---------------

test.describe("wheel over a mixer strip trims its fader (W4-E)", () => {
  test("notch steps, alt fine, range clamp, horizontal passthrough", async ({ page }) => {
    await page.goto(`/session/${crypto.randomUUID()}`);
    await expect(page.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const strip = page.locator('[data-mixer-strip="MASTER"]');
    const fader = page.getByRole("slider", { name: "MASTER gain" });
    await expect(fader).toHaveAttribute("aria-valuenow", "0");
    await strip.hover();

    // One notch up = +1 dB; three notches down = −3 dB net −2.
    await page.mouse.wheel(0, -100);
    await expect(fader).toHaveAttribute("aria-valuenow", "1");
    expect(await masterDb(page)).toBe(1);
    await page.mouse.wheel(0, 300);
    await expect(fader).toHaveAttribute("aria-valuenow", "-2");

    // Alt = fine: 0.1 dB per notch — and the strip readout follows live.
    await page.keyboard.down("Alt");
    await page.mouse.wheel(0, -100);
    await page.keyboard.up("Alt");
    await expect(fader).toHaveAttribute("aria-valuenow", "-1.9");
    await expect(page.getByText("-1.9 dB")).toBeVisible();

    // Horizontal-dominant gestures are NOT gain: they belong to the
    // dock's overflow-x scroll and must leave the fader alone.
    await page.mouse.wheel(240, 20);
    await expect(fader).toHaveAttribute("aria-valuenow", "-1.9");

    // Clamped to the fader's real range: bottom rail reads −∞, top +6.
    await page.mouse.wheel(0, 10_000);
    await expect(fader).toHaveAttribute("aria-valuenow", "-60");
    await expect(fader).toHaveAttribute("aria-valuetext", "−∞ dB");
    await expect(page.getByText("−∞ dB")).toBeVisible();
    await page.mouse.wheel(0, -10_000);
    await expect(fader).toHaveAttribute("aria-valuenow", "6");
    expect(await masterDb(page)).toBe(6);
  });
});

// ---- 1+3 · rename from the mixer, click-select, S/M keys -----------------------

test.describe("mixer rename + lane selection (W4-E)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("strip rename persists via peer-update; click selects; S/M key the lane", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phone = await (await browser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId);
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });
    const peerId = (await recorderState(phone))?.peerId as string;
    await renamePeerFromDesk(desk, peerId, "Alice");

    // --- rename from the MIXER strip: double-click the title, type, Enter.
    // (Editor lookups scope to the strip: the sidebar's hover pencil
    // carries the same accessible name.)
    const strip = desk.locator('[data-mixer-strip="Alice"]');
    await expect(strip).toBeVisible();
    await strip.getByTitle("Double-click to rename").dblclick();
    const editor = strip.getByLabel("Rename Alice");
    await editor.fill("Alicia");
    await editor.press("Enter");
    // The A13 roster echo lands: server-persisted label, BOTH surfaces.
    await expect
      .poll(
        async () =>
          ((await deskState(desk))?.session?.peers ?? []).find((p) => p.peerId === peerId)
            ?.deviceInfo.label ?? null,
        { timeout: 15_000 },
      )
      .toBe("Alicia");
    await expect(desk.locator('[data-mixer-strip="Alicia"]')).toBeVisible();
    await expect(desk.locator(`[data-lane-header="${peerId}"]`).getByText("Alicia")).toBeVisible();

    // --- Escape cancels a rename draft (no peer-update fires).
    const renamed = desk.locator('[data-mixer-strip="Alicia"]');
    await renamed.getByTitle("Double-click to rename").dblclick();
    await renamed.getByLabel("Rename Alicia").fill("Junk");
    await desk.keyboard.press("Escape");
    await expect(desk.locator('[data-mixer-strip="Alicia"]')).toBeVisible();
    expect(
      ((await deskState(desk))?.session?.peers ?? []).find((p) => p.peerId === peerId)?.deviceInfo
        .label,
    ).toBe("Alicia");

    // --- click the strip: the lane selects in BOTH surfaces.
    const header = desk.locator(`[data-lane-header="${peerId}"]`);
    await desk.locator('[data-mixer-strip="Alicia"]').getByTitle("Double-click to rename").click();
    await expect(desk.locator('[data-mixer-strip="Alicia"]')).toHaveAttribute(
      "data-selected",
      "true",
    );
    await expect(header).toHaveAttribute("data-selected", "true");

    // --- S solos, M mutes the selected lane (toggles).
    await desk.keyboard.press("s");
    await expect.poll(async () => (await channelStrip(desk, peerId))?.soloed).toBe(true);
    await desk.keyboard.press("s");
    await expect.poll(async () => (await channelStrip(desk, peerId))?.soloed).toBe(false);
    await desk.keyboard.press("m");
    await expect.poll(async () => (await channelStrip(desk, peerId))?.muted).toBe(true);
    await desk.keyboard.press("m");
    await expect.poll(async () => (await channelStrip(desk, peerId))?.muted).toBe(false);

    // --- typing in a text field never trips the shortcuts.
    await desk
      .locator('[data-mixer-strip="Alicia"]')
      .getByTitle("Double-click to rename")
      .dblclick();
    await desk.keyboard.type("sm");
    expect((await channelStrip(desk, peerId))?.soloed).toBe(false);
    expect((await channelStrip(desk, peerId))?.muted).toBe(false);
    await desk.keyboard.press("Escape"); // cancel the draft

    // --- Escape clears the selection.
    await desk.keyboard.press("Escape");
    await expect(desk.locator('[data-mixer-strip="Alicia"]')).toHaveAttribute(
      "data-selected",
      "false",
    );
    await expect(header).toHaveAttribute("data-selected", "false");

    // --- clicking the sidebar header selects too (VU column: no buttons)
    // — and NEVER seeks: headers are sticky chrome, not lane surface
    // (W4-C×W4-E seam) — a bare-surface click would park a pin even with
    // nothing loaded, so the playhead must stay absent here.
    await header.click({ position: { x: 224, y: 33 } });
    await expect(header).toHaveAttribute("data-selected", "true");
    await expect(desk.locator('[data-mixer-strip="Alicia"]')).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(await uiPlayhead(desk)).toBeNull();
    await expect(desk.locator("[data-playhead]")).toHaveCount(0);

    await phone.close();
    await desk.close();
  });
});

// ---- 4 · lane context menu ------------------------------------------------------

test.describe("lane context menu (W4-E)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("move up/down persists through the doc; solo/mute toggle; delete runs the F2 confirm", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phoneA = await (await browser.newContext()).newPage();
    await joinAsRecorder(phoneA, sessionId);
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });
    const peerA = (await recorderState(phoneA))?.peerId as string;
    const phoneB = await (await browser.newContext()).newPage();
    await joinAsRecorder(phoneB, sessionId);
    await expect(desk.getByText("2 phones connected")).toBeVisible({ timeout: 15_000 });
    const peerB = (await recorderState(phoneB))?.peerId as string;
    await renamePeerFromDesk(desk, peerA, "Alice");
    await renamePeerFromDesk(desk, peerB, "Bob");
    await expect.poll(async () => await laneOrder(desk)).toEqual(["Alice", "Bob"]);

    // Right-click target on a strip: the TITLE row — the strip's center
    // would land on the fader, whose pointerdown jump-to-click is not what
    // these cases are about.
    const stripMenu = (name: string) =>
      desk.locator(`[data-mixer-strip="${name}"]`).getByTitle("Double-click to rename");

    // --- Move up from Bob's mixer strip: order flips, menu closes.
    await stripMenu("Bob").click({ button: "right" });
    const menu = desk.getByRole("menu");
    await expect(menu).toBeVisible();
    // Bob is last: Move down is honestly disabled, with the reason.
    const moveDown = desk.getByRole("menuitem", { name: "Move down" });
    await expect(moveDown).toBeDisabled();
    await expect(moveDown).toHaveAttribute("title", "Already the last lane");

    // --- ONE-gesture re-anchor (QA MINOR-1): right-clicking another lane
    // while a menu is open closes the old menu AND opens that lane's at
    // the cursor — no dismiss-then-click-again dance. (force: the
    // backdrop legitimately covers the strip; the forward is the point.)
    await stripMenu("Alice").click({ button: "right", force: true });
    await expect(desk.getByRole("menu", { name: "Alice lane menu" })).toBeVisible();
    await stripMenu("Bob").click({ button: "right", force: true });
    await expect(desk.getByRole("menu", { name: "Bob lane menu" })).toBeVisible();

    await desk.getByRole("menuitem", { name: "Move up" }).click();
    await expect(menu).toHaveCount(0);
    await expect.poll(async () => await laneOrder(desk)).toEqual(["Bob", "Alice"]);
    // Right-click also selected the lane (the highlight anchors the menu).
    await expect(desk.locator(`[data-lane-header="${peerB}"]`)).toHaveAttribute(
      "data-selected",
      "true",
    );

    // --- now Bob is first: Move up disabled; Escape dismisses. (The
    // sidebar header is the other right-click surface — VU column spot,
    // clear of the header's buttons.)
    await desk
      .locator(`[data-lane-header="${peerB}"]`)
      .click({ button: "right", position: { x: 224, y: 33 } });
    await expect(desk.getByRole("menuitem", { name: "Move up" })).toBeDisabled();
    // W4-C×W4-E seam: the header right-click opened a MENU and nothing
    // else — no parked seek pin (W4-C parks one on bare-surface clicks
    // even with nothing loaded) and no marquee rectangle.
    expect(await uiPlayhead(desk)).toBeNull();
    await expect(desk.locator("[data-playhead]")).toHaveCount(0);
    await expect(desk.locator(".bg-accent\\/10")).toHaveCount(0); // marquee overlay
    await desk.keyboard.press("Escape");
    await expect(desk.getByRole("menu")).toHaveCount(0);

    // --- Solo via the menu (menuitemcheckbox reflects the strip state).
    // Accessible names carry the mono hints ("Solo S") — match by prefix.
    await stripMenu("Alice").click({ button: "right" });
    await desk.getByRole("menuitemcheckbox", { name: /^Solo/ }).click();
    await expect.poll(async () => (await channelStrip(desk, peerA))?.soloed).toBe(true);
    await stripMenu("Alice").click({ button: "right" });
    await expect(desk.getByRole("menuitemcheckbox", { name: /^Solo/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await desk.keyboard.press("Escape");

    // --- Mute via the KEYBOARD path: focus opens on the first enabled
    // item; arrows walk enabled items only; Enter activates. From Alice
    // (second lane, no clips yet): Move up → Solo → Mute.
    await desk
      .locator(`[data-lane-header="${peerA}"]`)
      .click({ button: "right", position: { x: 224, y: 33 } });
    await expect(desk.getByRole("menuitem", { name: "Move up" })).toBeFocused();
    await expect(desk.getByRole("menuitem", { name: /^Delete/ })).toBeDisabled();
    await desk.keyboard.press("ArrowDown"); // Solo (Move down disabled, skipped)
    await desk.keyboard.press("ArrowDown"); // Mute
    await expect(desk.getByRole("menuitemcheckbox", { name: /^Mute/ })).toBeFocused();
    await desk.keyboard.press("Enter");
    await expect(desk.getByRole("menu")).toHaveCount(0);
    await expect.poll(async () => (await channelStrip(desk, peerA))?.muted).toBe(true);

    // --- record a short take so Delete has something to stage.
    const takeId = await startTake(desk);
    await desk.waitForTimeout(2_500);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, takeId, 2);

    // --- Delete from Bob's strip: stages 1 clip behind the F2 dialog.
    const streamsBefore = (await deskStatus(desk)).length;
    await stripMenu("Bob").click({ button: "right" });
    const del = desk.getByRole("menuitem", { name: /^Delete/ });
    await expect(del).toContainText("1 clip");
    await del.click();
    const dialog = desk.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Delete 1 clip" }).click();
    await expect
      .poll(async () => (await deskStatus(desk)).length, { timeout: 20_000 })
      .toBe(streamsBefore - 1);

    // --- the moved order came from the shared doc: a cold reload
    // rebuilds [Bob, Alice], not the frozen join order.
    await desk.reload();
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();
    await expect
      .poll(async () => await laneOrder(desk), { timeout: 20_000 })
      .toEqual(["Bob", "Alice"]);

    // --- a dying lane takes its selection with it (QA MINOR-2): no stale
    // selectedLaneKey silently flipping M's meaning. Select Bob (clipless
    // but connected), prove M is lane-scoped; then his phone leaves — the
    // lane drops, the ring clears WITH it, and M is marker-drop again.
    await expect.poll(async () => await loadedTakeId(desk), { timeout: 20_000 }).toBe(takeId); // the take auto-reloads: markers usable for the M check
    await stripMenu("Bob").click();
    await expect(desk.locator('[data-mixer-strip="Bob"]')).toHaveAttribute("data-selected", "true");
    await desk.keyboard.press("m");
    await expect.poll(async () => (await channelStrip(desk, peerB))?.muted).toBe(true);
    expect(await markerCount(desk)).toBe(0); // M muted — it did NOT drop a marker
    await phoneB.close();
    await expect.poll(async () => await laneOrder(desk), { timeout: 20_000 }).toEqual(["Alice"]);
    // Selection STATE cleared, not just its rendering — no ring anywhere.
    await expect(desk.locator('[data-selected="true"]')).toHaveCount(0);
    // With nothing selected, M means marker-drop again — immediately.
    await desk.keyboard.press("m");
    await expect.poll(async () => await markerCount(desk)).toBe(1);

    await phoneA.close();
    await desk.close();
  });
});
