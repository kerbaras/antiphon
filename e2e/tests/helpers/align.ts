// Shared fixtures/probes for the alignment journeys (W4-B capture shape,
// W6-C audible + visual assertions): the chirpless music-like WAV the fake
// mics replay, a per-lane master-graph tap that MEASURES the residual
// offset between two lanes in the actually-rendered signal, and the clip
// box geometry reader the visual-honesty assertions use.

import { expect, type Page } from "@playwright/test";

export const SAMPLE_RATE = 48_000;
const FILE_SECONDS = 60;

/** Deterministic PRNG (mulberry32) for the music fixture: the bed must be
 * byte-identical run to run — an unseeded Math.random() handed each run a
 * different self-similarity landscape, and rare realizations gave the
 * offset probe below a spurious secondary correlation peak. The capture
 * STAGGER still varies with join timing, which is the part under test. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 16-bit mono PCM WAV of music-like content — AM tones + filtered noise
 * under an APERIODIC phrase contour, the same recipe as the dsp content.rs
 * calibration tests. Aperiodicity matters: the default fake tone has no
 * unique content lag (alignment-state.spec.ts pins that honest decline). */
export function musicLikeWav(): Buffer {
  const rand = mulberry32(0xa11c_0de5);
  const n = SAMPLE_RATE * FILE_SECONDS;
  const tones: Array<[number, number]> = [
    [220, 0.11],
    [311.1, 0.07],
    [466.2, 0.05],
  ];
  const knotLen = SAMPLE_RATE / 2; // 0.5 s phrase-contour knots
  const knots = Array.from({ length: n / knotLen + 2 }, () => 0.4 + 0.6 * rand());
  const data = Buffer.alloc(n * 2);
  let lp1 = 0;
  let lp2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    let s = 0;
    for (let k = 0; k < tones.length; k++) {
      const [freq, amp] = tones[k] as [number, number];
      const am = 0.6 + 0.4 * Math.sin(2 * Math.PI * (0.23 + 0.11 * k) * t);
      s += amp * am * Math.sin(2 * Math.PI * freq * t);
    }
    lp1 += 0.35 * (rand() * 2 - 1 - lp1);
    lp2 += 0.35 * (lp1 - lp2);
    const knot = i / knotLen;
    const frac = (i % knotLen) / knotLen;
    const contour =
      (knots[Math.floor(knot)] as number) * (1 - frac) +
      (knots[Math.floor(knot) + 1] as number) * frac;
    const v = (s + 0.3 * lp2) * contour;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 26000))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // integer PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bit depth
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** A pure, constant-amplitude 440 Hz sine for the fake mics — the
 * DETERMINISTIC-DECLINE fixture (W5-D, extracted from topbar.spec.ts).
 * Chromium's default fake device (a 0.5 s beep grid) doesn't decline
 * reliably: its envelope has edges, and the partial beep at each capture's
 * head is genuine aperiodic evidence that sometimes hands the content
 * correlator an honest lag (~1/4 aligned measured on main; the same
 * stochastic accept flaked alignment-state at the 2.75 bar). A flat sine
 * has no envelope feature anywhere — mean removal leaves nothing to match
 * and every period is a tie, the exact fixture dsp content.rs pins
 * sub-threshold (periodic_content_is_ambiguous_and_declined); the chirp
 * path declines trivially (no chirp is ever emitted). 440 × 30 s is an
 * integer cycle count, so the file loops seamlessly — no splice transient
 * to betray it. */
export function sineWav(): Buffer {
  const rate = 48_000;
  const n = rate * 30;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = 0.5 * Math.sin(2 * Math.PI * 440 * (i / rate));
    data.writeInt16LE(Math.round(v * 26000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // integer PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bit depth
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export interface LaneOffsetMeasurement {
  /** Envelope-correlation peak lag in seconds. Sign convention: POSITIVE =
   * the lexicographically-FIRST stream (streamId sort) renders late
   * relative to the other; a drag that delays the second-sorted stream by
   * d reads as −d. */
  lagSec: number;
  /** Normalized correlation at that lag (≈ 1 for near-identical lanes). */
  r: number;
  scheduleCount: number;
}

/** Measure the residual offset between the loaded take's TWO lanes in the
 * signal the player actually renders. Both track analysers are tapped
 * through one ChannelMerger → ScriptProcessor (the captures are
 * sample-synchronized by construction, and the processor sits INSIDE the
 * graph — output-device underruns can't fake or hide an offset, same
 * technique as playback-gapless.spec.ts). Plays from `fromSec` for
 * `seconds`, then cross-correlates the two lanes' mean-subtracted RMS
 * envelopes (5 ms hops, ±4 s search). Pick `fromSec` past every clip
 * delay so both lanes are content-full for the whole window — a long
 * silent head hands self-similar music a spurious secondary peak. Lane
 * order is fixed by streamId sort, so the sign is deterministic. */
export async function measureLaneOffset(
  desk: Page,
  seconds: number,
  fromSec = 0,
): Promise<LaneOffsetMeasurement> {
  return await desk.evaluate(
    async ({ seconds, fromSec }) => {
      interface TrackInternals {
        streamId: string;
        analyser: AnalyserNode;
      }
      interface PlayerInternals {
        play(fromSec?: number): void;
        pause(): void;
        snapshot(): { playing: boolean; scheduleCount: number };
        ensureGraph(): AudioContext;
        tracks: Map<string, TrackInternals>;
      }
      const hook = (globalThis as unknown as { __antiphonDesk?: { player: unknown } })
        .__antiphonDesk;
      if (!hook) throw new Error("no desk hook");
      // TS-private, runtime-public (the playback-gapless precedent): the
      // per-track analysers are the post-strip nodes feeding the master bus.
      const player = hook.player as PlayerInternals;
      const ctx = player.ensureGraph();
      const tracks = [...player.tracks.values()].sort((a, b) =>
        a.streamId.localeCompare(b.streamId),
      );
      if (tracks.length !== 2) throw new Error(`expected 2 tracks, got ${tracks.length}`);
      const merger = ctx.createChannelMerger(2);
      (tracks[0] as TrackInternals).analyser.connect(merger, 0, 0);
      (tracks[1] as TrackInternals).analyser.connect(merger, 0, 1);
      const proc = ctx.createScriptProcessor(4096, 2, 1);
      const slabsA: Float32Array[] = [];
      const slabsB: Float32Array[] = [];
      proc.onaudioprocess = (e) => {
        slabsA.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        slabsB.push(new Float32Array(e.inputBuffer.getChannelData(1)));
      };
      const mute = ctx.createGain();
      mute.gain.value = 0;
      merger.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);

      player.play(fromSec);
      await new Promise((r) => setTimeout(r, seconds * 1000));
      const snap = player.snapshot();
      player.pause();
      (tracks[0] as TrackInternals).analyser.disconnect(merger);
      (tracks[1] as TrackInternals).analyser.disconnect(merger);
      merger.disconnect();
      proc.disconnect();

      const concat = (slabs: Float32Array[]) => {
        const total = slabs.reduce((n, s) => n + s.length, 0);
        const out = new Float32Array(total);
        let off = 0;
        for (const s of slabs) {
          out.set(s, off);
          off += s.length;
        }
        return out;
      };
      const a = concat(slabsA);
      const b = concat(slabsB);
      const hopSec = 0.005;
      const hop = Math.round(ctx.sampleRate * hopSec);
      const envOf = (d: Float32Array) => {
        const n = Math.floor(d.length / hop);
        const env = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          let acc = 0;
          for (let j = i * hop; j < (i + 1) * hop; j++) acc += (d[j] as number) ** 2;
          env[i] = Math.sqrt(acc / hop);
        }
        let mean = 0;
        for (const v of env) mean += v;
        mean /= n || 1;
        for (let i = 0; i < n; i++) env[i] = (env[i] as number) - mean;
        return env;
      };
      const ea = envOf(a);
      const eb = envOf(b);
      // Search reach: ±4 s, but never past HALF the window — a candidate
      // lag must leave a majority overlap or short-window self-similarity
      // of the music bed can out-correlate the true peak (observed: a
      // spurious +3.39 s at 43% overlap beating a true −2 s).
      const maxLag = Math.min(Math.round(4 / hopSec), Math.floor(ea.length / 2));
      let bestLag = 0;
      let bestR = -2;
      for (let lag = -maxLag; lag <= maxLag; lag++) {
        let sab = 0;
        let saa = 0;
        let sbb = 0;
        for (let i = 0; i < ea.length; i++) {
          const j = i - lag;
          if (j < 0 || j >= eb.length) continue;
          const va = ea[i] as number;
          const vb = eb[j] as number;
          sab += va * vb;
          saa += va * va;
          sbb += vb * vb;
        }
        const r = sab / (Math.sqrt(saa * sbb) || 1);
        if (r > bestR) {
          bestR = r;
          bestLag = lag;
        }
      }
      return { lagSec: bestLag * hopSec, r: bestR, scheduleCount: snap.scheduleCount };
    },
    { seconds, fromSec },
  );
}

/** Clip boxes' timeline x in px, keyed by streamId (the data-clip id). */
export async function clipLefts(desk: Page): Promise<Map<string, number>> {
  const entries = await desk.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-clip]")].map((el) => [
      el.dataset.clip as string,
      Number.parseFloat(el.style.left || "0"),
    ]),
  );
  return new Map(entries as Array<[string, number]>);
}

/** The player's applied head-trim deltas (streamId → samples), via hook. */
export async function alignDeltas(desk: Page): Promise<Array<[string, number]>> {
  return await desk.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __antiphonDesk?: { player: { alignDeltas(): Map<string, number> } };
      }
    ).__antiphonDesk;
    if (!hook) return [];
    return [...hook.player.alignDeltas().entries()];
  });
}

/** Poll until the player holds `takeId` with at least one track. */
export async function expectTakeLoaded(
  desk: Page,
  takeId: string,
  timeoutMs = 60_000,
): Promise<void> {
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
      { timeout: timeoutMs },
    )
    .toBe(takeId);
}
