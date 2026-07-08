// F3: fatal control errors are terminal. A second tab joining with the SAME
// deviceId (A12) supersedes the first; the superseded tab must STOP — no
// reconnect loop, no ping-pong war stealing the identity back every backoff
// interval — and render a terminal panel whose only exit is the deliberate
// "Take over in this tab" action (which supersedes the other tab: honest,
// user-initiated semantics).

import { expect, type Page, test } from "@playwright/test";
import { deskState, joinAsRecorder, recorderState } from "./helpers/session";

const DEVICE_ID_KEY = "antiphon:device-id";

function recorderCount(peers: Array<{ role: string }> | undefined): number {
  return (peers ?? []).filter((p) => p.role === "recorder").length;
}

async function micReleased(phone: Page): Promise<boolean> {
  return await phone.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphon?: { controller: { audioTrack: MediaStreamTrack | null } };
      }
    ).__antiphon;
    return (hook?.controller.audioTrack ?? null) === null;
  });
}

test.describe("fatal control errors (F3)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("device supersede: old tab goes terminal (no rejoin war); take-over reverses it", async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phoneA = await (await browser.newContext()).newPage();
    await joinAsRecorder(phoneA, sessionId);
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

    // Second context, SAME device identity (the "duplicate tab" journey).
    const deviceId = await phoneA.evaluate((key) => localStorage.getItem(key), DEVICE_ID_KEY);
    expect(deviceId).toBeTruthy();
    const contextB = await browser.newContext();
    await contextB.addInitScript(
      ([key, id]) => localStorage.setItem(key as string, id as string),
      [DEVICE_ID_KEY, deviceId as string],
    );
    const phoneB = await contextB.newPage();
    await joinAsRecorder(phoneB, sessionId);

    // --- tab A: terminal supersede panel, capture stopped ------------------
    await expect(
      phoneA.getByText("This device reconnected in another tab — this tab has been disconnected."),
    ).toBeVisible({ timeout: 15_000 });
    await expect(phoneA.getByRole("button", { name: "Take over in this tab" })).toBeVisible();
    expect((await recorderState(phoneA))?.fatal?.code).toBe("superseded");
    // Mic + pipeline released: the successor tab owns the hardware story.
    await expect.poll(() => micReleased(phoneA), { timeout: 10_000 }).toBe(true);

    // --- stability probe: NO ping-pong ------------------------------------
    // The old bug re-dialed every 1-8s backoff tick, so 8 seconds of
    // sampling would catch a war. Tab A must stay halted, tab B must stay
    // joined, and the server must see exactly ONE stable recorder.
    for (let i = 0; i < 8; i++) {
      await phoneA.waitForTimeout(1_000);
      const a = await recorderState(phoneA);
      expect(a?.fatal?.code, `sample ${i}: A stays terminal`).toBe("superseded");
      expect(a?.signalingConnected, `sample ${i}: A stays disconnected`).toBe(false);
      const b = await recorderState(phoneB);
      expect(b?.fatal, `sample ${i}: B unaffected`).toBeNull();
      expect(b?.signalingConnected, `sample ${i}: B stays joined`).toBe(true);
      expect(
        recorderCount((await deskState(desk))?.session?.peers),
        `sample ${i}: one recorder in the room`,
      ).toBe(1);
    }
    // B's identity resumed A's peer (A12): same lane, not a fork.
    expect((await recorderState(phoneB))?.peerId).toBeTruthy();

    // --- deliberate take-over from tab A -----------------------------------
    await phoneA.getByRole("button", { name: "Take over in this tab" }).click();
    await expect(phoneA.getByText("joined", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => (await recorderState(phoneA))?.serverLink ?? "down", { timeout: 20_000 })
      .toBe("connected");
    expect((await recorderState(phoneA))?.fatal).toBeNull();

    // ...and now B is the superseded one, terminally.
    await expect(
      phoneB.getByText("This device reconnected in another tab — this tab has been disconnected."),
    ).toBeVisible({ timeout: 15_000 });
    expect(recorderCount((await deskState(desk))?.session?.peers)).toBe(1);

    await phoneA.close();
    await phoneB.close();
    await desk.close();
  });
});
