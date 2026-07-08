// F3 fold (wave-2 wiring): the error strip's data layer already caps,
// expires (30 s TTL) and exposes dismissError(index) — this spec pins the
// missing UI: EVERY live error renders (QA: only the last showed) and each
// entry carries its own × dismiss.
//
// The trigger is a real, deterministic control-plane refusal: streams-delete
// against the ACTIVE take (server guard: "cannot delete streams of the
// active take") — no fixture streams needed, the refusal fires on takeId.

import { expect, type Page, test } from "@playwright/test";
import { deskState, startTake, stopTake } from "./helpers/session";

/** Ask the server to delete a (fabricated) stream of the given take —
 * refused with the non-fatal `take-active` error while the take rolls. */
async function requestActiveTakeDelete(desk: Page, takeId: string): Promise<void> {
  await desk.evaluate((tid) => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: {
          session: {
            deleteStreams(refs: Array<{ takeId: string; streamId: string }>): void;
          };
        };
      }
    ).__antiphonDesk;
    hook?.session.deleteStreams([{ takeId: tid, streamId: crypto.randomUUID() }]);
  }, takeId);
}

test.describe("error strip dismiss (F3 UI)", () => {
  test("multiple errors are visible; each dismisses independently", async ({ browser }) => {
    test.setTimeout(90_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();
    await expect
      .poll(async () => (await deskState(desk))?.signalingConnected ?? false, { timeout: 15_000 })
      .toBe(true);

    const takeId = await startTake(desk);

    // Two refusals → two live errors in the session state...
    await requestActiveTakeDelete(desk, takeId);
    await expect
      .poll(async () => ((await deskState(desk))?.errors ?? []).length, { timeout: 10_000 })
      .toBe(1);
    await requestActiveTakeDelete(desk, takeId);
    await expect
      .poll(async () => ((await deskState(desk))?.errors ?? []).length, { timeout: 10_000 })
      .toBe(2);

    // ...and BOTH render on the strip (QA: only the last used to show),
    // each with its own dismiss control.
    const entries = desk.getByTestId("desk-error");
    await expect(entries).toHaveCount(2);
    await expect(entries.first()).toContainText("take-active");
    const dismissers = desk.getByRole("button", { name: /dismiss error/i });
    await expect(dismissers).toHaveCount(2);

    // Dismissing one drops exactly that entry — state and UI agree.
    await dismissers.first().click();
    await expect(entries).toHaveCount(1);
    expect(((await deskState(desk))?.errors ?? []).length).toBe(1);

    await dismissers.first().click();
    await expect(entries).toHaveCount(0);
    expect(((await deskState(desk))?.errors ?? []).length).toBe(0);

    await stopTake(desk);
    await desk.close();
  });
});
