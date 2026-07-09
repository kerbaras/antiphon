// W7-B — split playback parity, signal-level proof (the audible half of
// split.spec.ts; separate file because launchOptions are per-file and this
// needs Chromium's DEFAULT beep-grid fake mic).
//
// One beep-grid lane (clipped pulse bursts every ~500 ms — playback-
// gapless's onset grammar): a fresh split cut MID-BEEP plays seamlessly
// across the abutting boundary — the master-bus tap's onset cadence stays
// interval-exact vs the archive, in ONE schedule pass (both regions in a
// single scheduling walk) — and the exported master mix carries identical
// onsets (render parity through the same planRegionSource). ONE lane means
// the content-align fallback has nothing to correlate against → declined
// by construction (session-playback's fixture-safety note), so shift and
// anchor are 0 and the cut position maps 1:1 to source seconds.

import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { findOnsets, ONSETS_SRC, wavChannel0 } from "./helpers/onsets";
import {
  type DeskStreamStatus,
  expectTakeConverged,
  joinAsRecorder,
  startTake,
  stopTake,
} from "./helpers/session";

const PX_PER_SEC = 24; // default zoom

interface UiRegion {
  id: string;
  startSec: number;
  sourceOffsetSec: number;
  durationSec: number;
}

async function uiRegions(desk: Page): Promise<Record<string, UiRegion[]>> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: { ui(): { regions: Record<string, UiRegion[]> } | null };
      }
    ).__antiphonDesk;
    return hook?.ui()?.regions ?? {};
  });
}

async function expectTakeLoaded(desk: Page, takeId: string, tracks: number): Promise<void> {
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
          return `take=${snap?.loadedTakeId ?? null} tracks=${snap?.tracks.length ?? 0}`;
        }),
      { timeout: 60_000 },
    )
    .toBe(`take=${takeId} tracks=${tracks}`);
}

test.describe("split playback parity (W7-B)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test("a fresh split plays seamlessly across the boundary (one schedule pass) and the master render matches the archive", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const sessionId = crypto.randomUUID();

    const desk = await (await browser.newContext()).newPage();
    await desk.goto(`/session/${sessionId}`);
    await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();

    const phone = await (await browser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId);
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

    const takeId = await startTake(desk);
    await desk.waitForTimeout(8_000);
    await stopTake(desk);
    const converged = await expectTakeConverged(desk, sessionId, takeId, 1);
    const streamId = (converged.deskStreams[0] as DeskStreamStatus).streamId;
    await expectTakeLoaded(desk, takeId, 1);

    // Archive truth: the beep onsets of the uncut stream.
    const archive = await desk.evaluate(
      async ({ streamId, onsetsSrc }) => {
        const res = await fetch(`/api/streams/${streamId}/flac`);
        if (!res.ok) throw new Error(`flac fetch ${res.status}`);
        const ctx = new OfflineAudioContext(1, 1, 48_000);
        const audio = await ctx.decodeAudioData(await res.arrayBuffer());
        const data = audio.getChannelData(0);
        const onsetsOf = new Function(`return ${onsetsSrc}`)() as (d: Float32Array) => number[];
        return { length: data.length, onsets: onsetsOf(data) };
      },
      { streamId, onsetsSrc: ONSETS_SRC },
    );
    expect(archive.onsets.length).toBeGreaterThanOrEqual(8);

    // Cut MID-BEEP — the hardest place to hide a seam: a dropped or
    // doubled sample span at the boundary bends the onset cadence, and a
    // beep torn by a gap would mint an extra onset. Target: 100 ms past
    // the 4th onset (the bursts run ~200 ms).
    const cutSourceSec = (archive.onsets[3] as number) / 48_000 + 0.1;
    await desk.keyboard.press("c"); // Split tool
    const box = await desk.locator(`[data-clip="${streamId}"]`).boundingBox();
    if (!box) throw new Error("clip not visible");
    await desk.mouse.click(box.x + cutSourceSec * PX_PER_SEC, box.y + box.height / 2);
    await expect.poll(async () => await desk.locator("[data-clip]").count()).toBe(2);
    const pieces = (await uiRegions(desk))[streamId] as UiRegion[];
    expect(pieces).toHaveLength(2);
    // Fresh split: abutting in both domains (the seam under test).
    expect(pieces[1]?.startSec).toBeCloseTo(
      (pieces[0]?.startSec as number) + (pieces[0]?.durationSec as number),
      6,
    );
    await desk.keyboard.press("v");

    // --- master-bus tap across the boundary (the W4-A probe) ------------------
    const tap = await desk.evaluate(
      async ({ onsetsSrc }) => {
        interface PlayerInternals {
          play(fromSec?: number): void;
          snapshot(): { playing: boolean; scheduleCount: number };
          ensureGraph(): AudioContext;
          masterAnalyser: AnalyserNode | null;
        }
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

        player.play(1); // the take's base — regions start here
        const t0 = performance.now();
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

    // ONE schedule pass covers both pieces (no re-schedule at the seam).
    expect(tap.playing).toBe(false);
    expect(tap.scheduleCount).toBe(1);
    // Every onset came through IN CADENCE — the intervals spanning the cut
    // included. A seam at the boundary (gap, overlap, restart) would bend
    // the interval around onset 4 or mint/drop one.
    const takeEndSec = archive.length / 48_000;
    const certain = archive.onsets.filter((o) => o / 48_000 < takeEndSec - 0.1);
    expect(tap.onsets.length).toBeGreaterThanOrEqual(certain.length);
    expect(tap.onsets.length).toBeLessThanOrEqual(archive.onsets.length);
    const ratio = tap.contextRate / 48_000;
    for (let i = 1; i < certain.length; i++) {
      const archiveInterval = ((certain[i] as number) - (certain[i - 1] as number)) * ratio;
      const tapInterval = (tap.onsets[i] as number) - (tap.onsets[i - 1] as number);
      expect(
        Math.abs(tapInterval - archiveInterval),
        `beep interval ${i} across the split (tap ${tapInterval} vs archive ${archiveInterval})`,
      ).toBeLessThanOrEqual(0.005 * tap.contextRate);
    }

    // --- render parity: the master mix carries identical onsets ---------------
    // (The session master renders the SPLIT regions through the same
    // planRegionSource as playback; a fresh split must be byte-equivalent
    // to the uncut take.)
    const exportButton = desk.getByRole("button", { name: "Export ▾" });
    await expect(exportButton).toBeEnabled({ timeout: 30_000 });
    await exportButton.click();
    const masterItem = desk.getByRole("menuitem", { name: /^Master mix/ });
    await expect(masterItem).toBeEnabled({ timeout: 30_000 });
    const [download] = await Promise.all([desk.waitForEvent("download"), masterItem.click()]);
    const rendered = wavChannel0(await readFile(await download.path()));
    const renderedOnsets = findOnsets(rendered);
    expect(renderedOnsets.length).toBe(archive.onsets.length);
    for (let i = 0; i < archive.onsets.length; i++) {
      expect(
        Math.abs((renderedOnsets[i] as number) - (archive.onsets[i] as number)),
        `rendered onset ${i}`,
      ).toBeLessThanOrEqual(48); // 1 ms @ 48 kHz
    }

    await phone.close();
    await desk.close();
  });
});
