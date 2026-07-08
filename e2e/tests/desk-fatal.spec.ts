// F3 (desk flavor, wave-2 wiring): the DATA layer already halts the desk's
// signaling on a fatal supersede (DeskSessionState.fatal) — this spec pins
// the missing UI: a terminal, kit-styled panel that explains the supersede,
// never auto-reconnects, and whose only exit is the deliberate
// "Take over in this tab" action (mirrors the phone's semantics in
// fatal.spec.ts).

import { expect, test } from "@playwright/test";
import { deskState } from "./helpers/session";

const DEVICE_ID_KEY = "antiphon:device-id";

const SUPERSEDE_COPY = "This desk reconnected in another tab — this tab has been disconnected.";

test.describe("desk fatal supersede (F3 UI)", () => {
  test("superseded desk renders a terminal panel; take-over reverses it", async ({ browser }) => {
    test.setTimeout(120_000);
    const sessionId = crypto.randomUUID();

    const deskA = await (await browser.newContext()).newPage();
    await deskA.goto(`/session/${sessionId}`);
    await expect(deskA.getByText("ANTIPHON", { exact: true })).toBeVisible();
    await expect
      .poll(async () => (await deskState(deskA))?.signalingConnected ?? false, {
        timeout: 15_000,
      })
      .toBe(true);

    // Second desk tab with the SAME device identity (A12 supersede).
    const deviceId = await deskA.evaluate((key) => localStorage.getItem(key), DEVICE_ID_KEY);
    expect(deviceId).toBeTruthy();
    const contextB = await browser.newContext();
    await contextB.addInitScript(
      ([key, id]) => localStorage.setItem(key as string, id as string),
      [DEVICE_ID_KEY, deviceId as string],
    );
    const deskB = await contextB.newPage();
    await deskB.goto(`/session/${sessionId}`);
    await expect(deskB.getByText("ANTIPHON", { exact: true })).toBeVisible();

    // --- desk A: terminal panel, honest copy, no dismiss affordance -------
    await expect(deskA.getByText(SUPERSEDE_COPY)).toBeVisible({ timeout: 15_000 });
    await expect(deskA.getByRole("button", { name: "Take over in this tab" })).toBeVisible();
    expect((await deskState(deskA))?.fatal?.code).toBe("superseded");

    // --- stability probe: terminal means terminal (no reconnect war) ------
    for (let i = 0; i < 6; i++) {
      await deskA.waitForTimeout(1_000);
      const a = await deskState(deskA);
      expect(a?.fatal?.code, `sample ${i}: A stays terminal`).toBe("superseded");
      expect(a?.signalingConnected, `sample ${i}: A stays disconnected`).toBe(false);
      const b = await deskState(deskB);
      expect(b?.fatal, `sample ${i}: B unaffected`).toBeNull();
      expect(b?.signalingConnected, `sample ${i}: B stays joined`).toBe(true);
    }

    // --- deliberate take-over from desk A ----------------------------------
    await deskA.getByRole("button", { name: "Take over in this tab" }).click();
    await expect(deskA.getByText(SUPERSEDE_COPY)).toBeHidden({ timeout: 15_000 });
    await expect
      .poll(async () => (await deskState(deskA))?.signalingConnected ?? false, {
        timeout: 20_000,
      })
      .toBe(true);
    expect((await deskState(deskA))?.fatal).toBeNull();

    // ...and now B is the superseded one, terminally.
    await expect(deskB.getByText(SUPERSEDE_COPY)).toBeVisible({ timeout: 15_000 });
    expect((await deskState(deskB))?.fatal?.code).toBe("superseded");

    await deskA.close();
    await deskB.close();
  });
});
