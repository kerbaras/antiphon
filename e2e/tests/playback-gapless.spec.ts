// W4-A — playback stutter deep-dive: signal-level proof that desk playback
// of an archived take is gapless and scheduled exactly once.
//
// The operator heard "stuttering" and suspected the encoder/chunker. The
// encode path is exonerated at the bitstream level (Rust roundtrip tests;
// a 1.44M-sample ramp through the real encoder+chunker decodes sample-exact
// under both ffmpeg and Chrome's decodeAudioData), so this spec pins the
// full journey around it with a live browser: fake-mic capture (a clipped
// pulse-burst beep every ~500 ms — onsets make any dropped or duplicated
// span a measurable interval error) → chunked FLAC → server archive →
// desk auto-load → REAL-TIME playback tapped at the master bus, plus the
// offline export render. Asserts:
//   1. the archived FLAC decodes to exactly the chunk-declared sample
//      count and its beep cadence is unbent (capture → archive gapless);
//   2. the tapped real-time output reproduces the archive's beep intervals
//      sample-tight (scheduling adds no seams, stalls, or restarts);
//   3. scheduleCount stays 1 for the whole run (no re-schedule storm);
//   4. the exported master WAV carries the same onsets at the same
//      positions (offline render parity — the TODO's "rendered output of
//      a known signal is gapless" checkbox).

import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { parseWav } from "./helpers/files";
import { expectTakeConverged, joinAsRecorder, startTake, stopTake } from "./helpers/session";

/** Beep onsets (sample indices) of a mono signal. Two passes: a 10 ms peak
 * envelope finds blocks where a beep starts after ≥240 ms of quiet (the
 * fake mic emits ~200 ms clipped pulse bursts every ~500 ms), then the
 * onset refines to the first sample exceeding 0.35 — sample-precise and
 * deterministic. Kept as source text so the page and Node analyses run
 * the IDENTICAL algorithm. */
const ONSETS_SRC = `(data) => {
  const B = 480;
  const blocks = Math.floor(data.length / B);
  const env = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) {
    let peak = 0;
    for (let i = b * B; i < (b + 1) * B; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    env[b] = peak;
  }
  const onsets = [];
  for (let b = 1; b < blocks; b++) {
    if (env[b] <= 0.35 || env[b - 1] > 0.35) continue;
    let quiet = true;
    for (let k = Math.max(0, b - 25); k < b - 1; k++) {
      if (env[k] >= 0.05) { quiet = false; break; }
    }
    if (!quiet) continue;
    for (let i = (b - 1) * B; i < (b + 1) * B; i++) {
      if (Math.abs(data[i]) > 0.35) { onsets.push(i); break; }
    }
  }
  return onsets;
}`;

/** The same detector, callable in Node for the exported WAV. */
const findOnsets = new Function(`return ${ONSETS_SRC}`)() as (
  data: Float32Array | number[],
) => number[];

interface ArchiveAnalysis {
  length: number;
  sampleRate: number;
  onsets: number[];
}

/** Decode the served FLAC in-page (Chrome's real decoder, at the archive's
 * own 48 kHz — no resample) and find its beep onsets. No naive click scan:
 * the fake beep is hard-clipped pulses, so sharp edges ARE the signal —
 * gaplessness is asserted through onset intervals, which any dropped or
 * duplicated span must bend. */
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
      return { length: data.length, sampleRate: audio.sampleRate, onsets: onsetsOf(data) };
    },
    { streamId, onsetsSrc: ONSETS_SRC },
  );
}

/** Channel-0 float samples of a 24-bit integer PCM WAV. */
function wavChannel0(bytes: Buffer): number[] {
  const info = parseWav(bytes);
  expect(info.bitDepth).toBe(24);
  const frameBytes = info.channels * 3;
  const frames = (bytes.length - 44) / frameBytes;
  const out: number[] = [];
  for (let i = 0; i < frames; i++) {
    const at = 44 + i * frameBytes;
    let v =
      (bytes[at] as number) | ((bytes[at + 1] as number) << 8) | ((bytes[at + 2] as number) << 16);
    if (v >= 1 << 23) v -= 1 << 24;
    out.push(v / (1 << 23));
  }
  return out;
}

test.describe("playback gapless (W4-A)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("archived take plays end-to-end with no seams and one schedule pass", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phone = await (await browser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId);
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

    // ~8 s take: ~15 beep periods — plenty of intervals to compare.
    const takeId = await startTake(desk);
    await desk.waitForTimeout(8_000);
    await stopTake(desk);
    const { serverStreams } = await expectTakeConverged(desk, sessionId, takeId, 1);
    const streamId = serverStreams[0]?.streamId as string;

    // The phone's capture pipeline reported no faults: what the mic gave
    // is what the archive holds.
    const ringFaults = await phone.evaluate(() => {
      const hook = (
        globalThis as unknown as {
          __antiphon?: { snapshot(): { ring: { droppedSamples: number } | null } | null };
        }
      ).__antiphon;
      return hook?.snapshot()?.ring?.droppedSamples ?? -1;
    });
    expect(ringFaults).toBe(0);

    // --- layer 1: the archive itself is gapless --------------------------
    const archive = await analyzeArchivedFlac(desk, streamId);
    // Chunk-header sample accounting matches the decoded reality exactly.
    const deskStreams = await desk.evaluate(() => {
      const hook = (
        globalThis as unknown as {
          __antiphonDesk?: {
            snapshot(): { deskStatus: Array<{ streamId: string; totalSamples: number }> } | null;
          };
        }
      ).__antiphonDesk;
      return hook?.snapshot()?.deskStatus ?? [];
    });
    const declared = deskStreams.find((s) => s.streamId === streamId)?.totalSamples ?? -1;
    expect(archive.length).toBe(declared);
    expect(archive.sampleRate).toBe(48_000);
    expect(archive.onsets.length).toBeGreaterThanOrEqual(8);
    // The fake device writes beeps on 10 ms buffer boundaries, so the
    // SOURCE cadence is 500 ms ± 10 ms (measured; not a pipeline fault). A
    // dropped/duplicated span of any audible size bends an interval past
    // that: assert every interval within ±15 ms of the median.
    const intervals = archive.onsets.slice(1).map((v, i) => v - (archive.onsets[i] as number));
    const median = [...intervals].sort((a, b) => a - b)[Math.floor(intervals.length / 2)] as number;
    for (const interval of intervals) {
      expect(Math.abs(interval - median)).toBeLessThanOrEqual(720); // 15 ms @ 48k
    }

    // --- layer 2: tap the live master bus and play the take through ------
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
      .toBe(takeId);

    const tap = await desk.evaluate(
      async ({ onsetsSrc }) => {
        interface PlayerInternals {
          play(fromSec?: number): void;
          snapshot(): { playing: boolean; scheduleCount: number; durationSec: number };
          ensureGraph(): AudioContext;
          masterAnalyser: AnalyserNode | null;
        }
        const hook = (globalThis as unknown as { __antiphonDesk?: { player: PlayerInternals } })
          .__antiphonDesk;
        if (!hook) throw new Error("no desk hook");
        const player = hook.player;
        // TS-private, runtime-public: build the graph, then tap the master
        // analyser (the node feeding ctx.destination) with a
        // ScriptProcessor. The processor is INSIDE the graph, so it sees
        // the exact rendered stream — output-device underruns can't fake
        // a seam, and machine load can't hide one.
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

        player.play(0);
        const t0 = performance.now();
        // Wait for the end-of-take auto-pause (with a safety cap).
        await new Promise<void>((resolve) => {
          const poll = () => {
            const snap = player.snapshot();
            if (
              (!snap.playing && performance.now() - t0 > 1_000) ||
              performance.now() - t0 > 20_000
            ) {
              resolve();
            } else setTimeout(poll, 100);
          };
          poll();
        });
        const finalSnap = player.snapshot();
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
        return {
          onsets: onsetsOf(data),
          contextRate: ctx.sampleRate,
          scheduleCount: finalSnap.scheduleCount,
          playing: finalSnap.playing,
        };
      },
      { onsetsSrc: ONSETS_SRC },
    );

    // One schedule pass for the entire take — the re-schedule-storm guard.
    expect(tap.playing).toBe(false);
    expect(tap.scheduleCount).toBe(1);

    // Every beep came out of the master bus, in order, at the archive's
    // own spacing (rate-normalized): any stall, seam, or restart bends an
    // interval or adds/drops an onset. The end-of-take auto-pause stops
    // sources 20 ms early BY DESIGN (QA F12) with raf granularity on top,
    // so an onset in the take's last 100 ms is legitimately uncertain —
    // compared only when the tap caught it. 5 ms interval tolerance.
    const takeEndSec = archive.length / archive.sampleRate;
    const certain = archive.onsets.filter((o) => o / archive.sampleRate < takeEndSec - 0.1);
    expect(tap.onsets.length).toBeGreaterThanOrEqual(certain.length);
    expect(tap.onsets.length).toBeLessThanOrEqual(archive.onsets.length);
    const ratio = tap.contextRate / archive.sampleRate;
    for (let i = 1; i < certain.length; i++) {
      const archiveInterval = ((certain[i] as number) - (certain[i - 1] as number)) * ratio;
      const tapInterval = (tap.onsets[i] as number) - (tap.onsets[i - 1] as number);
      expect(
        Math.abs(tapInterval - archiveInterval),
        `beep interval ${i} (tap ${tapInterval} vs archive ${archiveInterval})`,
      ).toBeLessThanOrEqual(0.005 * tap.contextRate);
    }

    // --- layer 3: the offline export render carries identical onsets -----
    const exportButton = desk.getByRole("button", { name: "Export ▾" });
    await expect(exportButton).toBeEnabled({ timeout: 30_000 });
    await exportButton.click();
    const masterItem = desk.getByRole("menuitem", { name: /master mix/i });
    await expect(masterItem).toBeEnabled({ timeout: 30_000 });
    const [download] = await Promise.all([desk.waitForEvent("download"), masterItem.click()]);
    const wav = await readFile(await download.path());
    const rendered = wavChannel0(wav);
    const renderedOnsets = findOnsets(rendered);
    // The render is offline and deterministic: whole take, no early stop —
    // every archive onset lands at its exact room-timeline position (both
    // 48 kHz; 1 ms tolerance covers the master-bus biquad-free path only
    // in float rounding).
    expect(renderedOnsets.length).toBe(archive.onsets.length);
    for (let i = 0; i < archive.onsets.length; i++) {
      expect(
        Math.abs((renderedOnsets[i] as number) - (archive.onsets[i] as number)),
        `rendered onset ${i}`,
      ).toBeLessThanOrEqual(48);
    }

    await phone.close();
    await desk.close();
  });
});
