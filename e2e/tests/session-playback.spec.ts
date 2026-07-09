// W6-B — session-wide transport & render, signal-level proof.
//
// The operator's asks: (1) "play should reproduce non-stop and respect
// silences between takes with no clips — not by takes"; (2) "master render
// should render the entire session, not the take you are in."
//
// Two takes are recorded back-to-back (fake mic: clipped pulse-burst beeps
// every ~500 ms — playback-gapless's onset grammar). The desk lays them out
// at their room offsets with the 2 s inter-take gap. Fixture-safety note
// (W6-C merge): the beep grid's stochastic content-accept (helpers/align.ts
// sineWav rationale) CANNOT touch this spec — every take here has ONE lane,
// and the content fallback needs two tracks to correlate, so the verdict is
// declined-by-construction: head-trims stay 0, the W6-C anchor stays 0, and
// every onset/position assertion below is verdict-insensitive. The beeps
// stay because the tap assertions NEED onsets. Asserts, with the
// master-bus tap from W4-A:
//   1. Play from take 1's head runs THROUGH its end, through the silent
//      gap, into take 2, and end-stops only at the SESSION end — both
//      takes' beep cadences land at their room offsets, the boundary
//      interval included, and the gap is genuinely silent;
//   2. exactly ONE boundary handoff schedule: scheduleCount == 2 (the
//      initial pass + the look-ahead mount of take 2) — the honest W6-B
//      evolution of playback-gapless's scheduleCount == 1;
//   3. a seek into the GAP plays silence, then take 2 starts ON TIME (its
//      room offset), with a single schedule pass (the window was mounted);
//   4. Export ▾ "Master mix" renders the ENTIRE session: duration = first
//      clip start → last take end, both takes' onsets at their room
//      offsets, zeros between;
//   5. "Loaded take mix" still renders the selected take alone — the
//      per-take capability is not silently removed.
// Plus the QA merge-round regressions: comments and the current-song
// highlight clamp to the SELECTED take while the session playhead sits in
// a neighbor (M-1/M-2), and a paused seek into an unmounted take
// pre-mounts it through seek()'s own look-ahead kick (M-3).

import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { parseWav } from "./helpers/files";
import { findOnsets, ONSETS_SRC, wavChannel0 } from "./helpers/onsets";
import { expectTakeConverged, joinAsRecorder, startTake, stopTake } from "./helpers/session";

const SAMPLE_RATE = 48_000;
// The desk's arrangement constants (track-model.ts): first take at +1 s,
// TAKE_GAP_SECONDS = 2 between takes.
const TAKE_BASE_SEC = 1;
const TAKE_GAP_SEC = 2;

interface ArchiveAnalysis {
  length: number;
  onsets: number[];
}

/** Decode the served FLAC in-page (48 kHz, no resample) and find onsets. */
async function analyzeArchivedFlac(desk: Page, streamId: string): Promise<ArchiveAnalysis> {
  return await desk.evaluate(
    async ({ streamId, onsetsSrc }) => {
      const res = await fetch(`/api/streams/${streamId}/flac`);
      if (!res.ok) throw new Error(`flac fetch ${res.status}`);
      const bytes = await res.arrayBuffer();
      const ctx = new OfflineAudioContext(1, 1, 48_000);
      const audio = await ctx.decodeAudioData(bytes);
      const data = audio.getChannelData(0);
      const onsetsOf = new Function(`return ${onsetsSrc}`)() as (d: Float32Array) => number[];
      return { length: data.length, onsets: onsetsOf(data) };
    },
    { streamId, onsetsSrc: ONSETS_SRC },
  );
}

/** Stream ids + total samples straight from the desk's sink status. */
async function deskSamples(
  desk: Page,
): Promise<Array<{ streamId: string; takeId: string; totalSamples: number }>> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: {
          snapshot(): {
            deskStatus: Array<{ streamId: string; takeId: string; totalSamples: number }>;
          } | null;
        };
      }
    ).__antiphonDesk;
    return hook?.snapshot()?.deskStatus ?? [];
  });
}

interface PlayerInternals {
  play(fromSec?: number): void;
  pause(): void;
  snapshot(): {
    playing: boolean;
    positionSec: number;
    durationSec: number;
    scheduleCount: number;
    mountedTakeIds: string[];
    loadedTakeId: string | null;
  };
  ensureGraph(): AudioContext;
  masterAnalyser: AnalyserNode | null;
}

interface TapResult {
  onsets: number[];
  contextRate: number;
  scheduleCount: number;
  playing: boolean;
  positionSec: number;
  durationSec: number;
  mountedTakeIds: string[];
  /** Peak of |signal| inside the requested quiet window (tap seconds). */
  quietPeak: number;
}

/** Tap the live master bus through a ScriptProcessor (inside the graph —
 * output-device underruns can't fake a seam), play from `fromSec`, wait
 * for the end-of-session auto-pause (or `maxWaitMs`), return onsets +
 * transport state. `quietWindowSec` measures silence inside the tap. */
async function tapPlayback(
  desk: Page,
  fromSec: number,
  maxWaitMs: number,
  quietWindowSec: [number, number],
  stopAfterMs?: number,
): Promise<TapResult> {
  return await desk.evaluate(
    async ({ onsetsSrc, fromSec, maxWaitMs, quietWindowSec, stopAfterMs }) => {
      const hook = (globalThis as unknown as { __antiphonDesk?: { player: PlayerInternals } })
        .__antiphonDesk;
      if (!hook) throw new Error("no desk hook");
      const player = hook.player;
      const ctx = player.ensureGraph();
      const analyser = player.masterAnalyser;
      if (!analyser) throw new Error("no master analyser");
      const proc = ctx.createScriptProcessor(4096, 2, 1);
      const slabs: Float32Array[] = [];
      proc.onaudioprocess = (e) => {
        slabs.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      const mute = ctx.createGain();
      mute.gain.value = 0;
      analyser.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);

      player.play(fromSec);
      const t0 = performance.now();
      await new Promise<void>((resolve) => {
        const poll = () => {
          const snap = player.snapshot();
          const elapsed = performance.now() - t0;
          if (stopAfterMs !== undefined && elapsed > stopAfterMs) {
            resolve();
          } else if ((!snap.playing && elapsed > 1_000) || elapsed > maxWaitMs) {
            resolve();
          } else setTimeout(poll, 100);
        };
        poll();
      });
      const finalSnap = player.snapshot();
      // A timed tap leaves the transport rolling — park it so the spec's
      // follow-up (renders) starts from a quiet desk.
      if (stopAfterMs !== undefined) player.pause();
      analyser.disconnect(proc);
      proc.disconnect();
      const total = slabs.reduce((n, s) => n + s.length, 0);
      const data = new Float32Array(total);
      let off = 0;
      for (const s of slabs) {
        data.set(s, off);
        off += s.length;
      }
      const onsetsOf = new Function(`return ${onsetsSrc}`)() as (d: Float32Array) => number[];
      let quietPeak = 0;
      const q0 = Math.max(0, Math.floor((quietWindowSec[0] as number) * ctx.sampleRate));
      const q1 = Math.min(total, Math.floor((quietWindowSec[1] as number) * ctx.sampleRate));
      for (let i = q0; i < q1; i++) {
        quietPeak = Math.max(quietPeak, Math.abs(data[i] as number));
      }
      return {
        onsets: onsetsOf(data),
        contextRate: ctx.sampleRate,
        scheduleCount: finalSnap.scheduleCount,
        playing: finalSnap.playing,
        positionSec: finalSnap.positionSec,
        durationSec: finalSnap.durationSec,
        mountedTakeIds: finalSnap.mountedTakeIds,
        quietPeak,
      };
    },
    { onsetsSrc: ONSETS_SRC, fromSec, maxWaitMs, quietWindowSec, stopAfterMs },
  );
}

test.describe("session playback & render (W6-B)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("plays through the boundary with gap silence; session master renders both takes at their offsets", async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phone = await (await browser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId);
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

    // --- two takes back-to-back (~5 s and ~4 s), both converged --------------
    const streamOf: Record<string, string> = {};
    const takeIds: string[] = [];
    for (const durationMs of [5_000, 4_000]) {
      const takeId = await startTake(desk);
      takeIds.push(takeId);
      await expect(phone.getByText("recording", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await desk.waitForTimeout(durationMs);
      await stopTake(desk);
      const { deskStreams } = await expectTakeConverged(desk, sessionId, takeId, 1);
      streamOf[takeId] = deskStreams[0]?.streamId as string;
    }
    const [take1, take2] = takeIds as [string, string];

    // --- arrangement geometry, EXACTLY as the desk derives it ----------------
    // (track-model.ts: slot duration = max(totalSamples/rate, 1.5); the
    // second take starts after the first plus the 2 s gap.)
    const samples = await deskSamples(desk);
    const totalOf = (takeId: string) =>
      samples.find((s) => s.takeId === takeId)?.totalSamples ?? -1;
    const dur1 = Math.max(totalOf(take1) / SAMPLE_RATE, 1.5);
    const dur2 = totalOf(take2) / SAMPLE_RATE;
    const base1 = TAKE_BASE_SEC;
    const base2 = base1 + dur1 + TAKE_GAP_SEC;
    const sessionEnd = base2 + dur2;

    // Archive truths: each take's beep onsets (48 kHz sample indices).
    const archive1 = await analyzeArchivedFlac(desk, streamOf[take1] as string);
    const archive2 = await analyzeArchivedFlac(desk, streamOf[take2] as string);
    expect(archive1.onsets.length).toBeGreaterThanOrEqual(6);
    expect(archive2.onsets.length).toBeGreaterThanOrEqual(5);

    // --- select take 1 explicitly (the transport plays the SESSION either
    // way; selection is the editing cursor and stays sticky) ------------------
    await desk.locator(`[data-clip="${streamOf[take1]}"]`).dblclick();
    await expect
      .poll(
        async () =>
          await desk.evaluate(() => {
            const hook = (
              globalThis as unknown as {
                __antiphonDesk?: {
                  playerSnapshot(): { loadedTakeId: string | null; tracks: unknown[] } | null;
                };
              }
            ).__antiphonDesk;
            const snap = hook?.playerSnapshot();
            return snap?.tracks.length ? snap.loadedTakeId : null;
          }),
        { timeout: 30_000 },
      )
      .toBe(take1);

    // === 1+2 · continuous play-through with the boundary tap =================
    // The gap on the tap timeline (played from base1): take 1's audio ends
    // at dur1, take 2 begins at base2 − base1. Probe the middle for silence.
    const gapStart = dur1;
    const gapEnd = base2 - base1;
    const tap = await tapPlayback(desk, base1, 30_000, [gapStart + 0.4, gapEnd - 0.4]);

    // End-stop fired at the SESSION end, engine parked there.
    expect(tap.playing).toBe(false);
    expect(Math.abs(tap.positionSec - tap.durationSec)).toBeLessThan(0.05);
    expect(Math.abs(tap.durationSec - sessionEnd)).toBeLessThan(0.1);
    // One initial schedule + exactly one boundary handoff — no storms.
    expect(tap.scheduleCount).toBe(2);
    // The mount window held both takes (selected take 1 + played take 2).
    expect([...tap.mountedTakeIds].sort()).toEqual([take1, take2].sort());
    // The inter-take gap is true silence at the master bus.
    expect(tap.quietPeak).toBeLessThan(0.05);

    // Every onset of BOTH takes came out, in order, at the room offsets.
    // Take 2's tail is auto-pause-uncertain exactly like W4-A's end rule,
    // so its last-100 ms onsets are compared only if captured.
    const ratio = tap.contextRate / SAMPLE_RATE;
    const expectedTap: number[] = [
      ...archive1.onsets.map((o) => o * ratio),
      ...archive2.onsets.map((o) => (o / SAMPLE_RATE + gapEnd) * tap.contextRate),
    ];
    const certainCount =
      archive1.onsets.length + archive2.onsets.filter((o) => o / SAMPLE_RATE < dur2 - 0.1).length;
    expect(tap.onsets.length).toBeGreaterThanOrEqual(certainCount);
    expect(tap.onsets.length).toBeLessThanOrEqual(expectedTap.length);
    // Intervals (offset-free — the tap's capture origin is arbitrary):
    // every consecutive pair, INCLUDING the boundary-spanning one, must
    // match the room-timeline spacing. 10 ms tolerance: the handoff is
    // scheduled on the same context clock grid as the initial pass.
    for (let i = 1; i < tap.onsets.length; i++) {
      const measured = (tap.onsets[i] as number) - (tap.onsets[i - 1] as number);
      const expected = (expectedTap[i] as number) - (expectedTap[i - 1] as number);
      expect(
        Math.abs(measured - expected),
        `onset interval ${i} (tap ${measured} vs room ${expected})`,
      ).toBeLessThanOrEqual(0.01 * tap.contextRate);
    }

    // === 3 · seek into the GAP: silence, then take 2 starts ON TIME ==========
    const gapMid = base2 - 1; // one second of gap before take 2's head
    const tap2 = await tapPlayback(desk, gapMid, 20_000, [0, 0.9], 3_500);
    // Resume with the window already mounted: ONE schedule pass, no churn.
    expect(tap2.scheduleCount).toBe(1);
    expect(tap2.quietPeak).toBeLessThan(0.05);
    expect(tap2.onsets.length).toBeGreaterThanOrEqual(1);
    // First beep lands at (base2 − gapMid) + its offset within the take —
    // the tap starts at play, so this one IS absolute. 60 ms tolerance:
    // the 0.06 s schedule pre-roll consumes tap time before audio rolls.
    const expectedFirst =
      (base2 - gapMid + (archive2.onsets[0] as number) / SAMPLE_RATE) * tap2.contextRate;
    expect(Math.abs((tap2.onsets[0] as number) - expectedFirst)).toBeLessThanOrEqual(
      0.08 * tap2.contextRate,
    );

    // === QA M-1/M-2 · take-scoped surfaces clamp to the take ==================
    // The transport is parked INSIDE take 2 (≈ base2 + 2.5) while take 1
    // stays selected — the exact repro: take-scoped tools must not follow
    // the session playhead beyond their take's span.
    const uiState = () =>
      desk.evaluate(() => {
        const hook = (
          globalThis as unknown as {
            __antiphonDesk?: {
              ui(): {
                comments: Array<{ atSec: number }>;
                currentSongId: string | null;
              } | null;
              playerSnapshot(): { positionSec: number } | null;
            };
          }
        ).__antiphonDesk;
        return {
          comments: hook?.ui()?.comments ?? [],
          currentSongId: hook?.ui()?.currentSongId ?? null,
          positionSec: hook?.playerSnapshot()?.positionSec ?? -1,
        };
      });
    expect((await uiState()).positionSec).toBeGreaterThan(base1 + dur1); // beyond take 1
    // M-1: a composed comment clamps to the take end — never minted beyond
    // the span into the shared doc, never drawn over the neighbor take.
    // (N opens the composer now — the Split tool owns C, W7-B.)
    await desk.keyboard.press("n");
    const composer = desk.getByLabel("Comment text");
    await expect(composer).toBeFocused();
    await composer.fill("clamped to the take edge");
    await composer.press("Enter");
    await expect.poll(async () => (await uiState()).comments.length).toBe(1);
    const commentAt = (await uiState()).comments[0]?.atSec as number;
    expect(Math.abs(commentAt - dur1)).toBeLessThan(0.01); // the nearest take edge
    // M-2: no "current song" while the session position sits outside the
    // take. Song 1 spans the whole take (marker at 0), highlighted at the
    // take head, dark once the playhead has rolled past the take's end.
    await desk.evaluate((sec) => {
      const hook = (
        globalThis as unknown as { __antiphonDesk?: { player: { seek(s: number): void } } }
      ).__antiphonDesk;
      hook?.player.seek(sec);
    }, base1);
    const addMarker = desk.getByRole("button", { name: "Add marker at playhead" });
    await expect(addMarker).toBeEnabled({ timeout: 15_000 });
    await addMarker.click();
    await expect.poll(async () => (await uiState()).currentSongId).not.toBeNull();
    await desk.evaluate((sec) => {
      const hook = (
        globalThis as unknown as { __antiphonDesk?: { player: { seek(s: number): void } } }
      ).__antiphonDesk;
      hook?.player.seek(sec);
    }, base2 + 1);
    await expect.poll(async () => (await uiState()).currentSongId).toBeNull();

    // === 4 · Export ▾ "Master mix" = the ENTIRE session ======================
    const exportButton = desk.getByRole("button", { name: "Export ▾" });
    await expect(exportButton).toBeEnabled({ timeout: 30_000 });
    await exportButton.click();
    const masterItem = desk.getByRole("menuitem", { name: /^Master mix/ });
    await expect(masterItem).toBeEnabled({ timeout: 30_000 });
    const [sessionDownload] = await Promise.all([
      desk.waitForEvent("download"),
      masterItem.click(),
    ]);
    expect(sessionDownload.suggestedFilename()).toMatch(/^session-[0-9a-f]{8}-master\.wav$/);
    const sessionWavBytes = await readFile(await sessionDownload.path());
    const sessionInfo = parseWav(sessionWavBytes);
    expect(sessionInfo.channels).toBe(2);
    expect(sessionInfo.sampleRate).toBe(SAMPLE_RATE);
    // Session length: first clip start → last take end (the leading
    // arrangement second is desk furniture and is NOT rendered).
    expect(Math.abs(sessionInfo.durationSec - (sessionEnd - base1))).toBeLessThan(0.05);
    const sessionPcm = wavChannel0(sessionWavBytes);
    const sessionOnsets = findOnsets(sessionPcm);
    const expectedRender = [
      ...archive1.onsets,
      ...archive2.onsets.map((o) => o + Math.round((base2 - base1) * SAMPLE_RATE)),
    ];
    expect(sessionOnsets.length).toBe(expectedRender.length);
    for (let i = 0; i < expectedRender.length; i++) {
      expect(
        Math.abs((sessionOnsets[i] as number) - (expectedRender[i] as number)),
        `session render onset ${i}`,
      ).toBeLessThanOrEqual(48); // 1 ms @ 48 kHz — offline determinism
    }
    // The gap renders as literal zeros (not just quiet).
    const zeroFrom = Math.round((gapStart + 0.4) * SAMPLE_RATE);
    const zeroTo = Math.round((gapEnd - 0.4) * SAMPLE_RATE);
    let gapPeak = 0;
    for (let i = zeroFrom; i < zeroTo; i++) {
      gapPeak = Math.max(gapPeak, Math.abs(sessionPcm[i] as number));
    }
    expect(gapPeak).toBe(0);

    // === 5 · "Loaded take mix" stays the per-take render =====================
    await expect(exportButton).toBeEnabled({ timeout: 30_000 }); // busy cleared
    await exportButton.click();
    const takeItem = desk.getByRole("menuitem", { name: /^Loaded take mix/ });
    await expect(takeItem).toBeEnabled({ timeout: 30_000 });
    const [takeDownload] = await Promise.all([desk.waitForEvent("download"), takeItem.click()]);
    expect(takeDownload.suggestedFilename()).toBe("take-01-master.wav");
    const takeWavBytes = await readFile(await takeDownload.path());
    expect(Math.abs(parseWav(takeWavBytes).durationSec - dur1)).toBeLessThan(0.05);
    const takeOnsets = findOnsets(wavChannel0(takeWavBytes));
    expect(takeOnsets.length).toBe(archive1.onsets.length);
    for (let i = 0; i < takeOnsets.length; i++) {
      expect(
        Math.abs((takeOnsets[i] as number) - (archive1.onsets[i] as number)),
        `take render onset ${i}`,
      ).toBeLessThanOrEqual(48);
    }

    // === QA M-3 · a PAUSED seek into an unmounted take pre-mounts it ==========
    // Select take 2 (promote releases take 1's mount), then seek — still
    // paused — back into take 1's span: the seek's own look-ahead kick
    // decodes it without any meter loop running, so the eventual resume
    // starts complete at the target instead of losing the head to the
    // 500 ms window poll.
    await desk.locator(`[data-clip="${streamOf[take2]}"]`).dblclick();
    await expect
      .poll(
        async () =>
          await desk.evaluate(() => {
            const hook = (
              globalThis as unknown as {
                __antiphonDesk?: {
                  playerSnapshot(): {
                    loadedTakeId: string | null;
                    mountedTakeIds: string[];
                  } | null;
                };
              }
            ).__antiphonDesk;
            const snap = hook?.playerSnapshot();
            return `${snap?.loadedTakeId} mounted=${[...(snap?.mountedTakeIds ?? [])].sort().join(",")}`;
          }),
        { timeout: 30_000 },
      )
      .toBe(`${take2} mounted=${take2}`); // take 1 released by the promote
    await desk.evaluate((sec) => {
      const hook = (
        globalThis as unknown as { __antiphonDesk?: { player: { seek(s: number): void } } }
      ).__antiphonDesk;
      hook?.player.seek(sec);
    }, base1 + 1);
    await expect
      .poll(
        async () =>
          await desk.evaluate(() => {
            const hook = (
              globalThis as unknown as {
                __antiphonDesk?: {
                  playerSnapshot(): { playing: boolean; mountedTakeIds: string[] } | null;
                };
              }
            ).__antiphonDesk;
            const snap = hook?.playerSnapshot();
            return `playing=${snap?.playing} mounted=${[...(snap?.mountedTakeIds ?? [])].sort().join(",")}`;
          }),
        { timeout: 15_000 },
      )
      .toBe(`playing=false mounted=${[take1, take2].sort().join(",")}`);

    await phone.close();
    await desk.close();
  });
});
