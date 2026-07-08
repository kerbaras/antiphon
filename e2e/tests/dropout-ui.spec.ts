// F10 regression: the session-state React subscription used to memoize a
// no-op unsubscribe when the session was null at mount and never
// re-subscribed after joinSession created it — dropout/outage UI (and any
// real outage display) intermittently never updated. The store now
// registers listeners independently of the session's existence, so the
// outage state must reach the UI immediately, every single time.

import { expect, test } from "@playwright/test";
import { joinAsRecorder, recorderState } from "./helpers/session";

test.describe("session-state UI subscription (F10)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("the dropout button shows the outage UI within 1s, every time", async ({ browser }) => {
    test.setTimeout(120_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phone = await (await browser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId);

    const button = phone.getByRole("button", { name: /simulate 5s dropout/i });
    const outage = phone.getByText("network outage simulated — capture continues");
    for (let round = 0; round < 3; round++) {
      await expect(button, `round ${round}: button ready`).toBeEnabled({ timeout: 15_000 });
      await button.click();
      // THE F10 assertion: the outage state must reach the UI immediately —
      // not only if some unrelated re-render happens to repaint it.
      await expect(outage, `round ${round}: outage UI within 1s`).toBeVisible({ timeout: 1_000 });
      // Outage ends after 5s: UI recovers, links come back.
      await expect(outage, `round ${round}: outage clears`).toBeHidden({ timeout: 10_000 });
      await expect
        .poll(async () => (await recorderState(phone))?.serverLink ?? "down", {
          timeout: 20_000,
        })
        .toBe("connected");
    }

    await phone.close();
    await desk.close();
  });
});
