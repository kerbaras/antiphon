// W4-F — phone mic picker.
//
// Chromium's fake-device stack exposes three audio inputs ("Fake Default
// Audio Input" + "Fake Audio Input 1/2"), so the picker genuinely renders
// and switches. Proven here: the select shows the live device and swaps
// the capture pipeline in place (meter keeps flowing, flags stay honest),
// the choice persists across a reload (localStorage → requested at start),
// a STALE persisted id falls back to the default mic instead of hard-
// failing (the iOS deviceId-rotation story), switching is locked while a
// take rolls, and a between-takes switch stamps the NEW device into the
// next take's seq-0 stream header (deviceDesc on the server archive).

import { expect, type Page, test } from "@playwright/test";
import {
  expectTakeConverged,
  joinAsRecorder,
  recorderState,
  serverTakeStreams,
  startTake,
  stopTake,
} from "./helpers/session";

const MIC_PREF_KEY = "antiphon:mic-input";

interface CaptureFlagsSnapshot {
  deviceLabel: string;
  deviceId: string | undefined;
  echoCancellation: boolean | string | undefined;
  noiseSuppression: boolean | string | undefined;
  autoGainControl: boolean | string | undefined;
}

interface HookSnapshot {
  contextSampleRate: number | null;
  flags: CaptureFlagsSnapshot | null;
  peak: number;
  error: string | null;
  ring: { droppedSamples: number } | null;
  stats: { state: string } | null;
  takeOpen: boolean;
}

/** Structural view of the page-hook controller the adversarial test drives. */
interface HookController {
  arm(options: { takeId: Uint8Array; streamId: Uint8Array; retainLocal?: boolean }): void;
  stopTake(): void;
  switchDevice(deviceId: string): Promise<void>;
  teardown(): Promise<void>;
  audioTrack: MediaStreamTrack | null;
}

interface AntiphonHook {
  controller: HookController;
  snapshot(): HookSnapshot | null;
}

function snapshot(page: Page): Promise<HookSnapshot | null> {
  return page.evaluate(() => {
    const hook = (globalThis as unknown as { __antiphon?: { snapshot(): HookSnapshot | null } })
      .__antiphon;
    return hook?.snapshot() ?? null;
  });
}

async function deviceLabel(page: Page): Promise<string | null> {
  return (await snapshot(page))?.flags?.deviceLabel ?? null;
}

test.describe("phone mic picker (W4-F)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("picker switches the live pipeline, persists across reload, and a stale saved id falls back to default", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto("/rehearse");
    await page.getByRole("button", { name: /enable microphone/i }).click();
    await expect(page.getByRole("button", { name: /record/i })).toBeVisible();

    // The picker renders (>1 input) and shows the live device.
    const picker = page.getByRole("combobox", { name: "Microphone" });
    await expect(picker).toBeVisible();
    await expect(picker).toBeEnabled();
    expect(await deviceLabel(page)).toBe("Fake Default Audio Input");
    await expect(picker.locator("option")).not.toHaveCount(1);

    // Switch: flags follow, the meter keeps metering the (new) live input,
    // and the sacred constraints survive re-acquisition.
    await picker.selectOption({ label: "Fake Audio Input 2" });
    await expect.poll(() => deviceLabel(page)).toBe("Fake Audio Input 2");
    await expect.poll(async () => (await snapshot(page))?.peak ?? 0).toBeGreaterThan(0.01);
    const flags = (await snapshot(page))?.flags;
    expect(flags?.echoCancellation).not.toBe(true);
    expect(flags?.noiseSuppression).not.toBe(true);
    expect(flags?.autoGainControl).not.toBe(true);
    expect((await snapshot(page))?.error).toBeNull();

    // The choice is persisted…
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), MIC_PREF_KEY);
    expect(JSON.parse(stored ?? "{}")).toMatchObject({ label: "Fake Audio Input 2" });

    // …and the pipeline still records a clean take after the swap.
    await page.getByRole("button", { name: /record/i }).click();
    await expect.poll(async () => (await snapshot(page))?.stats?.state).toBe("streaming");
    await page.waitForTimeout(1_000);
    await page.getByRole("button", { name: /stop/i }).click();
    await expect.poll(async () => (await snapshot(page))?.stats?.state).toBe("closed");
    expect((await snapshot(page))?.ring?.droppedSamples).toBe(0);

    // Reload: the persisted device is requested at start.
    await page.reload();
    await page.getByRole("button", { name: /enable microphone/i }).click();
    await expect(page.getByRole("button", { name: /record/i })).toBeVisible();
    await expect.poll(() => deviceLabel(page)).toBe("Fake Audio Input 2");

    // Stale persisted id (iOS rotates them): capture must still start, on
    // the default mic — never a hard fail, never a dead join page.
    await page.evaluate(
      (key) =>
        window.localStorage.setItem(
          key,
          JSON.stringify({ deviceId: "rotated-away", label: "Ghost Mic" }),
        ),
      MIC_PREF_KEY,
    );
    await page.reload();
    await page.getByRole("button", { name: /enable microphone/i }).click();
    await expect(page.getByRole("button", { name: /record/i })).toBeVisible();
    await expect.poll(() => deviceLabel(page)).toBe("Fake Default Audio Input");

    // F3: the dead preference is re-persisted to the live input — the next
    // visit must not pay the doomed exact-id getUserMedia again.
    await expect
      .poll(async () => {
        const raw = await page.evaluate((key) => window.localStorage.getItem(key), MIC_PREF_KEY);
        return (JSON.parse(raw ?? "{}") as { label?: string }).label ?? null;
      })
      .toBe("Fake Default Audio Input");
  });

  test("switching is locked while a take rolls; a between-takes switch lands in the next stream header", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phone = await (await browser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId);
    const picker = phone.getByRole("combobox", { name: "Microphone" });
    await expect(picker).toBeEnabled();

    // Take 1 on the default mic: the picker locks, with the reason on
    // screen, for the whole take (armed → streaming → stop).
    const take1 = await startTake(desk);
    await expect
      .poll(async () => (await recorderState(phone))?.activeTakeId ?? null, { timeout: 15_000 })
      .not.toBeNull();
    await expect(picker).toBeDisabled();
    await expect(phone.getByText(/mic locked while a take is rolling/i)).toBeVisible();
    await phone.waitForTimeout(1_500);
    await stopTake(desk);
    await expect
      .poll(async () => (await recorderState(phone))?.activeTakeId ?? null, { timeout: 15_000 })
      .toBeNull();
    await expect(picker).toBeEnabled({ timeout: 15_000 });
    await expectTakeConverged(desk, sessionId, take1, 1);

    // Between takes: switch. Take 2's seq-0 stream header (deviceDesc,
    // archived by the server) must carry the NEW device.
    await picker.selectOption({ label: "Fake Audio Input 2" });
    await expect.poll(() => deviceLabel(phone)).toBe("Fake Audio Input 2");

    const take2 = await startTake(desk);
    await phone.waitForTimeout(1_500);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, take2, 1);

    const headerDeviceDesc = async (takeId: string): Promise<string | null> => {
      const streams = (await serverTakeStreams(desk, sessionId, takeId)) as Array<{
        deviceDesc?: string | null;
      }>;
      return streams[0]?.deviceDesc ?? null;
    };
    await expect.poll(() => headerDeviceDesc(take1)).toContain("Fake Default Audio Input");
    await expect.poll(() => headerDeviceDesc(take2)).toContain("Fake Audio Input 2");

    // W5-B — the desk SURFACES the archived mic, per take. Take 2 is the
    // latest complete take, so it auto-loads: the lane header's provenance
    // chip tooltips take 2's deviceDesc.
    const chip = desk.locator("[data-take-mic]");
    await expect(chip).toHaveAttribute("data-take-mic", /Fake Audio Input 2/, {
      timeout: 30_000,
    });
    await expect(chip).toHaveAttribute("title", /Mic on the loaded take/);

    // Loading take 1 (explicit double-click) swaps the claim — the tooltip
    // is take-scoped truth, not a "latest device" cache.
    const take1Stream = (await serverTakeStreams(desk, sessionId, take1))[0]?.streamId as string;
    await desk.locator(`[data-clip="${take1Stream}"]`).dblclick();
    await expect(chip).toHaveAttribute("data-take-mic", /Fake Default Audio Input/, {
      timeout: 30_000,
    });

    // The sinks panel spells the same field out per stream, in words.
    await desk.getByRole("button", { name: /^sinks/i }).click();
    await expect(desk.getByText(/browser · Fake Default Audio Input/).first()).toBeVisible();
    await expect(desk.getByText(/browser · Fake Audio Input 2/).first()).toBeVisible();

    // QA F1 — the orphan case. Take 3 rolls on Input 2; mid-take the phone
    // reloads with the mic preference cleared (identity preserved — same
    // localStorage), so the A6 rejoin arms a FRESH stream on the DEFAULT
    // mic while the truncated orphan carries Input 2. The lane's mic claim
    // must be the AUDIBLE stream's — the orphan never loads, and worker
    // enumeration order must never decide whose mic the chip shows.
    const take3 = await startTake(desk);
    await expect(phone.getByText("recording", { exact: true })).toBeVisible({ timeout: 15_000 });
    const orphanStreamId = (await recorderState(phone))?.streamId as string;
    await phone.waitForTimeout(1_500);
    await phone.evaluate((key) => window.localStorage.removeItem(key), MIC_PREF_KEY);
    await phone.reload();
    await phone.getByRole("button", { name: /enable microphone/i }).click();
    await expect(phone.getByText("recording", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => deviceLabel(phone)).toBe("Fake Default Audio Input");
    const freshStreamId = (await recorderState(phone))?.streamId as string;
    expect(freshStreamId).toBeTruthy();
    expect(freshStreamId).not.toBe(orphanStreamId);
    await phone.waitForTimeout(1_500);
    await stopTake(desk);
    await expectTakeConverged(desk, sessionId, take3, 1, { onlyStreamIds: [freshStreamId] });

    // Server truth: two streams on one lane, two different mics.
    const take3Streams = await serverTakeStreams(desk, sessionId, take3);
    expect(take3Streams).toHaveLength(2);
    expect(take3Streams.find((s) => s.streamId === orphanStreamId)?.deviceDesc).toContain(
      "Fake Audio Input 2",
    );
    expect(take3Streams.find((s) => s.streamId === freshStreamId)?.deviceDesc).toContain(
      "Fake Default Audio Input",
    );

    // The orphan keeps take 3 from auto-selecting (it never completes) —
    // load it the operator's way, double-clicking the audible clip.
    await desk.locator(`[data-clip="${freshStreamId}"]`).dblclick();
    await expect(chip).toHaveAttribute("data-take-mic", /Fake Default Audio Input/, {
      timeout: 30_000,
    });
    expect(
      await chip.getAttribute("data-take-mic"),
      "the orphan's mic never becomes the lane's claim",
    ).not.toContain("Fake Audio Input 2");
  });

  // QA F1/F2 regression — the races the first review bounced. All three
  // interleaves drive the real controller through the page hook:
  //  (a) arm() then switchDevice(): the guard must read the SYNCHRONOUS
  //      takeOpen latch, not ~250ms-lagged worker stats — and the UI select
  //      must disable off the same latch, immediately.
  //  (b) TOCTOU: arm() lands while switchDevice()'s getUserMedia is in
  //      flight — the switch must re-check after the await, retire the
  //      fresh tracks, and never swap the rolling take's device.
  //  (c) stale stopped: stop(take1)+arm(take2) in ONE task — take 1's
  //      "stopped" (answering a stop that predates take 2's arm) must not
  //      wipe take 2's latch; the release is generation-matched.
  //  (d) teardown() while the switch's getUserMedia is in flight — the
  //      fulfillment must not repopulate a hot mic on a dead controller;
  //      every acquired track ends up readyState "ended".
  test("adversarial races: arm-during-switch and teardown-during-switch never swap a rolling take or leak a hot mic", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto("/rehearse");
    await page.getByRole("button", { name: /enable microphone/i }).click();
    const picker = page.getByRole("combobox", { name: "Microphone" });
    await expect(picker).toBeEnabled();
    // Ring diagnostics flow only once the encoder worker is up ("ready"
    // precedes the first stats tick), so the arms below take the direct
    // path — the take genuinely opens and can be stopped to "closed".
    await expect.poll(async () => (await snapshot(page))?.ring !== null).toBe(true);

    // ---- (a) sequential: arm, then switch — no stats wait ----------------
    const seq = await page.evaluate(async () => {
      const hook = (globalThis as unknown as { __antiphon: AntiphonHook }).__antiphon;
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === "audioinput" && d.deviceId !== "default",
      );
      const rid = () => crypto.getRandomValues(new Uint8Array(16));
      hook.controller.arm({ takeId: rid(), streamId: rid(), retainLocal: true });
      const takeOpenSync = hook.snapshot()?.takeOpen ?? false;
      const outcome = await hook.controller.switchDevice(inputs[0]?.deviceId ?? "").then(
        () => "fulfilled",
        (e: unknown) => `rejected: ${String(e)}`,
      );
      return { takeOpenSync, outcome, deviceAfter: hook.snapshot()?.flags?.deviceLabel ?? null };
    });
    expect(seq.takeOpenSync, "takeOpen latches synchronously at arm()").toBe(true);
    expect(seq.outcome).toContain("rejected");
    expect(seq.outcome).toContain("take is open");
    expect(seq.deviceAfter).toBe("Fake Default Audio Input");
    // The UI gates on the same latch: disabled without waiting for stats.
    await expect(picker).toBeDisabled();
    await expect(page.getByText(/mic locked while a take is rolling/i)).toBeVisible();
    await page.evaluate(() =>
      (globalThis as unknown as { __antiphon: AntiphonHook }).__antiphon.controller.stopTake(),
    );
    await expect.poll(async () => (await snapshot(page))?.stats?.state).toBe("closed");
    await expect.poll(async () => (await snapshot(page))?.takeOpen).toBe(false);
    await expect(picker).toBeEnabled();

    // ---- (b) TOCTOU: arm lands during the switch's in-flight acquire -----
    const toctou = await page.evaluate(async () => {
      const hook = (globalThis as unknown as { __antiphon: AntiphonHook }).__antiphon;
      const md = navigator.mediaDevices;
      const real = md.getUserMedia.bind(md);
      const patchable = md as { getUserMedia: typeof md.getUserMedia };
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const captured: MediaStream[] = [];
      patchable.getUserMedia = async (constraints) => {
        await gate;
        const stream = await real(constraints);
        captured.push(stream);
        return stream;
      };
      const inputs = (await md.enumerateDevices()).filter(
        (d) => d.kind === "audioinput" && d.deviceId !== "default",
      );
      const switchP = hook.controller.switchDevice(inputs[0]?.deviceId ?? "").then(
        () => "fulfilled",
        (e: unknown) => `rejected: ${String(e)}`,
      );
      const rid = () => crypto.getRandomValues(new Uint8Array(16));
      hook.controller.arm({ takeId: rid(), streamId: rid(), retainLocal: true });
      release();
      const outcome = await switchP;
      patchable.getUserMedia = real;
      return {
        outcome,
        deviceAfter: hook.snapshot()?.flags?.deviceLabel ?? null,
        capturedTracks: captured.flatMap((s) => s.getTracks().map((t) => t.readyState)),
      };
    });
    expect(toctou.outcome).toContain("rejected");
    expect(toctou.outcome).toContain("take opened during the switch");
    expect(toctou.deviceAfter, "the rolling take's device never changes").toBe(
      "Fake Default Audio Input",
    );
    // The freshly-acquired stream was retired on the spot.
    expect(toctou.capturedTracks.length).toBeGreaterThan(0);
    expect(toctou.capturedTracks.every((s) => s === "ended")).toBe(true);
    // The take itself is unharmed: it streams, then closes cleanly.
    await expect.poll(async () => (await snapshot(page))?.stats?.state).toBe("streaming");
    await page.evaluate(() =>
      (globalThis as unknown as { __antiphon: AntiphonHook }).__antiphon.controller.stopTake(),
    );
    await expect.poll(async () => (await snapshot(page))?.stats?.state).toBe("closed");

    // ---- (c) stale stopped: stop(t1)+arm(t2) in one task ------------------
    // Take 1's "stopped" answers a stop that predates take 2's arm — inside
    // the worker's stop round-trip (a batched take-stop+take-start pair,
    // e.g. a reconnect flush or a desk quick re-record). The latch release
    // is generation-matched, so take 2 stays locked and unswappable.
    const stale = await page.evaluate(async () => {
      const hook = (globalThis as unknown as { __antiphon: AntiphonHook }).__antiphon;
      const rid = () => crypto.getRandomValues(new Uint8Array(16));
      hook.controller.arm({ takeId: rid(), streamId: rid(), retainLocal: true });
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (hook.snapshot()?.stats?.state === "streaming") {
            clearInterval(timer);
            resolve();
          }
        }, 50);
      });
      // The adversarial pair: same task, no awaits in between.
      hook.controller.stopTake();
      hook.controller.arm({ takeId: rid(), streamId: rid(), retainLocal: true });
      const latchRightAfterArm = hook.snapshot()?.takeOpen ?? false;
      // Plenty of time for take 1's stale "stopped" to land (~5-50ms trip).
      await new Promise((r) => setTimeout(r, 1_000));
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === "audioinput" && d.deviceId !== "default",
      );
      const switchOutcome = await hook.controller.switchDevice(inputs[0]?.deviceId ?? "").then(
        () => "fulfilled",
        (e: unknown) => `rejected: ${String(e)}`,
      );
      return {
        latchRightAfterArm,
        latchDuringTake2: hook.snapshot()?.takeOpen ?? false,
        stateDuringTake2: hook.snapshot()?.stats?.state ?? null,
        switchOutcome,
        deviceAfter: hook.snapshot()?.flags?.deviceLabel ?? null,
      };
    });
    expect(stale.latchRightAfterArm).toBe(true);
    expect(stale.stateDuringTake2, "take 2 genuinely rolls").toBe("streaming");
    expect(stale.latchDuringTake2, "take 1's stale stopped must not wipe take 2's latch").toBe(
      true,
    );
    expect(stale.switchOutcome).toContain("rejected");
    expect(stale.deviceAfter, "no device swap inside rolling take 2").toBe(
      "Fake Default Audio Input",
    );
    await expect(picker).toBeDisabled();
    // Take 2's OWN stop still releases the latch (generation matches).
    await page.evaluate(() =>
      (globalThis as unknown as { __antiphon: AntiphonHook }).__antiphon.controller.stopTake(),
    );
    await expect.poll(async () => (await snapshot(page))?.stats?.state).toBe("closed");
    await expect.poll(async () => (await snapshot(page))?.takeOpen).toBe(false);
    await expect(picker).toBeEnabled();

    // ---- (d) teardown during the switch's in-flight acquire --------------
    const torn = await page.evaluate(async () => {
      const hook = (globalThis as unknown as { __antiphon: AntiphonHook }).__antiphon;
      const md = navigator.mediaDevices;
      const real = md.getUserMedia.bind(md);
      const patchable = md as { getUserMedia: typeof md.getUserMedia };
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const captured: MediaStream[] = [];
      patchable.getUserMedia = async (constraints) => {
        await gate;
        const stream = await real(constraints);
        captured.push(stream);
        return stream;
      };
      const inputs = (await md.enumerateDevices()).filter(
        (d) => d.kind === "audioinput" && d.deviceId !== "default",
      );
      const switchP = hook.controller.switchDevice(inputs[0]?.deviceId ?? "").then(
        () => "fulfilled",
        (e: unknown) => `rejected: ${String(e)}`,
      );
      await hook.controller.teardown();
      release();
      const outcome = await switchP;
      patchable.getUserMedia = real;
      return {
        outcome,
        contextAfter: hook.snapshot()?.contextSampleRate ?? null,
        trackAfterTeardown: hook.controller.audioTrack?.readyState ?? null,
        capturedTracks: captured.flatMap((s) => s.getTracks().map((t) => t.readyState)),
      };
    });
    expect(torn.outcome).toContain("rejected");
    expect(torn.outcome).toContain("pipeline closed");
    expect(torn.contextAfter, "snapshot stays torn down").toBeNull();
    expect(torn.trackAfterTeardown, "no track survives on the controller").toBeNull();
    expect(torn.capturedTracks.length).toBeGreaterThan(0);
    expect(
      torn.capturedTracks.every((s) => s === "ended"),
      "every acquired track ends readyState ended — no hot mic",
    ).toBe(true);
  });
});
