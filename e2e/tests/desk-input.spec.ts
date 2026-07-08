// W2-D — desk hardware inputs.
//
// The desk embeds a recorder built from the same CaptureController +
// RecorderSession machinery the phone uses: on the wire it is just another
// recorder peer. This journey proves the whole loop: the operator picks an
// input (chromium's fake device), the lane goes live with honest capture
// flags and a level meter, a take with 1 phone + the desk input converges
// at BOTH sinks, the stems export carries the desk lane, and — after a desk
// reload — one click resumes the SAME lane via the derived stable deviceId
// (A12): the server hands back the identical peerId for take 2.

import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { parseWav, parseZip } from "./helpers/files";
import {
  deskState,
  expectTakeConverged,
  joinAsRecorder,
  serverTakeStreams,
  startTake,
  stopTake,
} from "./helpers/session";

// ---- desk-input page hook readers -------------------------------------------

interface DeskInputSnapshot {
  phase: "off" | "picking" | "starting" | "live";
  laneLabel: string | null;
  peerId: string | null;
  streamId: string | null;
  recording: boolean;
  peak: number;
  flags: {
    echoCancellation: boolean | string | undefined;
    noiseSuppression: boolean | string | undefined;
    autoGainControl: boolean | string | undefined;
  } | null;
  unplugged: boolean;
}

interface DeskInputSessionSnapshot {
  peerId: string | null;
  serverLink: "connected" | "connecting" | "down";
  deskLink: "connected" | "connecting" | "down" | "absent";
  streamId: string | null;
}

async function deskInputState(desk: Page): Promise<DeskInputSnapshot | null> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDeskInput?: { snapshot(): DeskInputSnapshot | null };
      }
    ).__antiphonDeskInput;
    return hook?.snapshot() ?? null;
  });
}

async function deskInputSession(desk: Page): Promise<DeskInputSessionSnapshot | null> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDeskInput?: { sessionState(): DeskInputSessionSnapshot | null };
      }
    ).__antiphonDeskInput;
    return hook?.sessionState() ?? null;
  });
}

/** Live METER telemetry for a stream, as the desk's mixer meters see it. */
async function liveLevel(desk: Page, streamId: string): Promise<number> {
  return await desk.evaluate((id) => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: {
          snapshot(): { liveLevels: Record<string, { peak: number }> } | null;
        };
      }
    ).__antiphonDesk;
    return hook?.snapshot()?.liveLevels[id]?.peak ?? 0;
  }, streamId);
}

test.describe("desk hardware input (W2-D)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("desk input records with a phone, converges at both sinks, exports, and resumes its lane after a reload (A12)", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    // --- enable the desk input: permission probe → picker → live lane ------
    await desk.getByRole("button", { name: /add desk input/i }).click();
    const picker = desk.getByRole("combobox", { name: "Desk input device" });
    await expect(picker).toBeVisible();
    // Permission granted (fake UI): device labels are real, not blanks.
    await expect(picker.locator("option").first()).not.toHaveText(/^Input \d+$/);
    await desk.getByRole("button", { name: "Use input" }).click();
    await expect
      .poll(async () => (await deskInputState(desk))?.phase ?? "off", { timeout: 20_000 })
      .toBe("live");

    // Same honesty as the phone page: EC/NS/AGC all OFF.
    const flags = (await deskInputState(desk))?.flags;
    expect(flags?.echoCancellation).toBe(false);
    expect(flags?.noiseSuppression).toBe(false);
    expect(flags?.autoGainControl).toBe(false);
    await expect(desk.getByText("EC OFF")).toBeVisible();

    // The embedded recorder reaches both sinks like any phone would — the
    // desk leg is an ordinary P2P channel that ICE resolves to the same
    // machine (the sink-path decision under test: loopback, not a special
    // server-replication mode).
    await expect
      .poll(async () => (await deskInputSession(desk))?.serverLink ?? "down", { timeout: 20_000 })
      .toBe("connected");
    await expect
      .poll(async () => (await deskInputSession(desk))?.deskLink ?? "down", { timeout: 20_000 })
      .toBe("connected");

    // --- one phone joins; the desk input is NOT counted as a phone ---------
    const phone = await (await browser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId);
    await expect(desk.getByText(/1 phone connected · desk input/)).toBeVisible({
      timeout: 15_000,
    });

    // --- take 1: phone + desk input --------------------------------------
    const take1 = await startTake(desk);
    await expect
      .poll(async () => (await deskInputState(desk))?.recording ?? false, { timeout: 15_000 })
      .toBe(true);
    const streamId1 = (await deskInputSession(desk))?.streamId as string;
    expect(streamId1).toBeTruthy();
    // The lane meters run on live METER telemetry, like any recorder's.
    await expect
      .poll(async () => liveLevel(desk, streamId1), { timeout: 15_000 })
      .toBeGreaterThan(0);
    await desk.waitForTimeout(3_000);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, take1, 2);

    // Lane carries the default nickname derived from the picked device.
    await expect(desk.getByText(/^Room mic \(/).first()).toBeVisible();

    // --- stems export includes the desk lane ------------------------------
    const exportButton = desk.getByRole("button", { name: "Export ▾" });
    await expect(exportButton).toBeEnabled({ timeout: 30_000 });
    await exportButton.click();
    const stemsItem = desk.getByRole("menuitem", { name: /^stems/i });
    await expect(stemsItem).toBeEnabled({ timeout: 30_000 });
    const [stemsDownload] = await Promise.all([desk.waitForEvent("download"), stemsItem.click()]);
    const entries = parseZip(await readFile(await stemsDownload.path()));
    expect(entries).toHaveLength(2);
    const deskStem = entries.find((e) => /^Room-mic-/.test(e.name));
    expect(deskStem, `desk lane stem among ${entries.map((e) => e.name).join(", ")}`).toBeDefined();
    if (deskStem) {
      const wav = parseWav(deskStem.data);
      expect(wav.channels).toBe(1);
      expect(wav.sampleRate).toBe(48_000);
      expect(wav.hasSignal).toBe(true);
    }

    // --- reload: one click resumes the SAME lane (A12) ---------------------
    const peerBefore = (await deskInputSession(desk))?.peerId as string;
    expect(peerBefore).toBeTruthy();
    await desk.reload();
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();
    const resumeButton = desk.getByRole("button", { name: /resume desk input/i });
    await expect(resumeButton).toBeVisible({ timeout: 15_000 });
    await resumeButton.click();
    await expect
      .poll(async () => (await deskInputState(desk))?.phase ?? "off", { timeout: 20_000 })
      .toBe("live");
    // The derived deviceId is stable, so the server resumes the peer.
    await expect
      .poll(async () => (await deskInputSession(desk))?.peerId ?? null, { timeout: 20_000 })
      .toBe(peerBefore);
    await expect
      .poll(async () => (await deskInputSession(desk))?.serverLink ?? "down", { timeout: 20_000 })
      .toBe("connected");

    // --- take 2 after the resume lands on the same lane --------------------
    // (the phone reconnected to the reloaded desk on its own)
    await expect
      .poll(
        async () =>
          ((await deskState(desk))?.session?.peers ?? []).filter((p) => p.role === "recorder")
            .length,
        { timeout: 20_000 },
      )
      .toBe(2);
    const take2 = await startTake(desk);
    await expect
      .poll(async () => (await deskInputState(desk))?.recording ?? false, { timeout: 15_000 })
      .toBe(true);
    const streamId2 = (await deskInputSession(desk))?.streamId as string;
    await desk.waitForTimeout(2_500);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, take2, 2);

    // The archive maps BOTH takes' desk-input streams to the one peer —
    // the lane resumed instead of forking.
    const server1 = await serverTakeStreams(desk, sessionId, take1);
    const server2 = await serverTakeStreams(desk, sessionId, take2);
    expect(server1.find((s) => s.streamId === streamId1)?.peerId).toBe(peerBefore);
    expect(server2.find((s) => s.streamId === streamId2)?.peerId).toBe(peerBefore);

    // And the UI shows one desk-input lane, still nicknamed.
    await expect(desk.getByText(/^Room mic \(/).first()).toBeVisible();
  });
});
