// LIVE end-to-end validation with REAL hardware: three recorder tabs share
// the MacBook microphone, the desk plays the calibration chirp through the
// speakers, and the acoustic loop (speaker → air → mic) drives real chirp
// alignment. Then playback, seek, mute/solo, and faders are exercised.
//
// Run with the preview (4173) + server (8787) up:  node e2e/live-validate.mjs

import { chromium } from "@playwright/test";

const log = (s) => console.log(`[live] ${s}`);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({
  headless: false, // real audio devices want a real (headed) browser
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const sessionId = crypto.randomUUID();
const origin = "http://localhost:4173";

// --- desk ------------------------------------------------------------------
const deskCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const desk = await deskCtx.newPage();
await desk.goto(`${origin}/session/${sessionId}`);
log(`desk up, session ${sessionId.slice(0, 8)}`);

// --- three phones on the REAL microphone ------------------------------------
const phones = [];
for (let i = 0; i < 3; i++) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 720 } });
  await ctx.grantPermissions(["microphone"], { origin });
  const page = await ctx.newPage();
  await page.goto(`${origin}/join/${sessionId}`);
  await page.getByRole("button", { name: /enable microphone/i }).click();
  phones.push(page);
}

const phoneState = (page) =>
  page.evaluate(() => {
    const h = window.__antiphon;
    return {
      server: h?.sessionState?.()?.serverLink ?? "down",
      desk: h?.sessionState?.()?.deskLink ?? "down",
      peak: h?.snapshot?.()?.peak ?? 0,
      state: h?.snapshot?.()?.stats?.state ?? "idle",
      rate: h?.snapshot?.()?.contextSampleRate ?? 0,
      dropped: h?.snapshot?.()?.ring?.droppedSamples ?? 0,
    };
  });

// Wait for all transports.
for (const [i, page] of phones.entries()) {
  for (let t = 0; t < 60; t++) {
    const s = await phoneState(page);
    if (s.server === "connected") break;
    await page.waitForTimeout(500);
  }
  const s = await phoneState(page);
  check(`phone ${i + 1} server link`, s.server === "connected", s.server);
  check(`phone ${i + 1} mic capture`, s.rate > 8000, `${s.rate} Hz`);
}

// --- record a take, chirp mid-take -------------------------------------------
await desk.getByRole("button", { name: "Record take" }).click();
await desk.waitForTimeout(1500);
for (const [i, page] of phones.entries()) {
  const s = await phoneState(page);
  check(`phone ${i + 1} streaming`, s.state === "streaming", s.state);
}

// Desk-side live meters (METER telemetry): fresh levels for every stream.
const deskLevels = () =>
  desk.evaluate(() => {
    const levels = window.__antiphonDesk?.snapshot()?.liveLevels ?? {};
    const now = Date.now();
    return Object.values(levels)
      .filter((l) => now - l.at < 1500)
      .map((l) => l.peak);
  });
await desk.waitForTimeout(1200);
const meterCount = (await deskLevels()).length;
check("desk receives live meter telemetry for all 3 streams", meterCount === 3, `${meterCount}/3`);

// Sample ambient peak before the chirp, then chirp and watch the mic hear it.
const peaksBefore = await Promise.all(phones.map((p) => phoneState(p).then((s) => s.peak)));
const deskLevelsBefore = await deskLevels();
log(`ambient peaks: ${peaksBefore.map((p) => p.toFixed(4)).join(", ")}`);
log(`desk meter levels: ${deskLevelsBefore.map((p) => p.toFixed(4)).join(", ")}`);

await desk.getByRole("button", { name: "Chirp" }).click();
log("chirp playing through speakers…");
let chirpPeaks = [0, 0, 0];
let deskChirpMax = 0;
for (let t = 0; t < 16; t++) {
  await desk.waitForTimeout(250);
  const now = await Promise.all(phones.map((p) => phoneState(p).then((s) => s.peak)));
  chirpPeaks = chirpPeaks.map((v, i) => Math.max(v, now[i]));
  for (const l of await deskLevels()) deskChirpMax = Math.max(deskChirpMax, l);
}
log(`chirp-window peaks: ${chirpPeaks.map((p) => p.toFixed(4)).join(", ")}`);
const micHeardChirp = chirpPeaks.every((p, i) => p > Math.max(0.004, peaksBefore[i] * 1.5));
check(
  "all mics captured the chirp acoustically",
  micHeardChirp,
  micHeardChirp ? "" : "peaks did not rise — speakers muted or mic blocked by macOS?",
);
const deskBaseline = Math.max(0.004, ...deskLevelsBefore) * 1.5;
check(
  "desk meters respond to actual audio (rise during chirp)",
  deskChirpMax > deskBaseline,
  `max ${deskChirpMax.toFixed(4)} vs baseline ${deskBaseline.toFixed(4)}`,
);

// Keep recording a few more seconds of room, then stop.
await desk.waitForTimeout(3000);
await desk.getByRole("button", { name: "Stop take" }).click();
log("take stopped; waiting for convergence…");

const deskStatus = () => desk.evaluate(() => window.__antiphonDesk?.snapshot()?.deskStatus ?? []);
let streams = [];
for (let t = 0; t < 90; t++) {
  streams = await deskStatus();
  if (streams.length === 3 && streams.every((s) => s.complete)) break;
  await desk.waitForTimeout(500);
}
check(
  "3 streams complete at the desk",
  streams.length === 3 && streams.every((s) => s.complete),
  streams
    .map((s) => `${s.streamId.slice(0, 6)}:${s.heldCount}/${(s.finalSeq ?? -1) + 1}`)
    .join(" "),
);
for (const [i, page] of phones.entries()) {
  const s = await phoneState(page);
  check(`phone ${i + 1} zero dropped samples`, s.dropped === 0, String(s.dropped));
}

// --- auto-align (runs automatically post-load because a chirp was emitted) ---
const playerSnap = () => desk.evaluate(() => window.__antiphonDesk?.playerSnapshot?.() ?? null);
let player = null;
for (let t = 0; t < 60; t++) {
  player = await playerSnap();
  if (player && player.tracks.length === 3 && !player.aligning && !player.loading) {
    if (player.tracks.every((tr) => tr.alignment !== null)) break;
  }
  await desk.waitForTimeout(500);
}
const alignments = (player?.tracks ?? []).map((t) => t.alignment);
log(
  `alignment: ${alignments
    .map((a) => (a ? `lag=${a.lagSamples} conf=${a.confidence.toFixed(2)}` : "null"))
    .join(" | ")}`,
);
const appliedCount = alignments.filter((a) => a?.applied).length;
check("chirp correlation confident on all 3 streams", appliedCount === 3, `${appliedCount}/3`);
if (appliedCount >= 2) {
  const lags = alignments.filter((a) => a?.applied).map((a) => a.lagSamples);
  const spreadMs = ((Math.max(...lags) - Math.min(...lags)) / 48_000) * 1000;
  log(`inter-stream spread before alignment: ${spreadMs.toFixed(1)} ms (now compensated)`);
  check("aligned badge visible on timeline", (await desk.getByText("⇥ aligned").count()) > 0);
}

// --- playback: play / playhead motion / pause / seek --------------------------
await desk.getByRole("button", { name: "Play" }).click();
await desk.waitForTimeout(400);
const p1 = await playerSnap();
await desk.waitForTimeout(1200);
const p2 = await playerSnap();
check(
  "play starts and playhead advances",
  p2.playing && p2.positionSec > p1.positionSec,
  `pos ${p1.positionSec.toFixed(2)} → ${p2.positionSec.toFixed(2)}`,
);
let masterPeak = 0;
for (let t = 0; t < 8; t++) {
  await desk.waitForTimeout(200);
  masterPeak = Math.max(masterPeak, (await playerSnap()).masterLevel);
}
check("master meter shows real level during playback", masterPeak > 0.003, masterPeak.toFixed(4));
await desk.screenshot({ path: "screens/live-playing.png" });

// Mute track 1: its meter must die while others live.
await desk.getByRole("button", { name: /^Mute/ }).first().click();
await desk.waitForTimeout(500);
const afterMute = await playerSnap();
check(
  "mute silences the muted track only",
  afterMute.tracks[0].muted && afterMute.tracks[0].level < 0.002,
  `levels ${afterMute.tracks.map((t) => t.level.toFixed(3)).join(", ")}`,
);
await desk.getByRole("button", { name: /^Mute/ }).first().click(); // unmute

// Fader drag on MASTER: pull it down, expect masterDb to drop.
const masterFader = desk.getByRole("slider", { name: "MASTER gain" });
const box = await masterFader.boundingBox();
await desk.mouse.move(box.x + box.width / 2, box.y + 10);
await desk.mouse.down();
await desk.mouse.move(box.x + box.width / 2, box.y + box.height - 8, { steps: 5 });
await desk.mouse.up();
const afterFader = await playerSnap();
check("master fader drag changes gain", afterFader.masterDb < -30, `${afterFader.masterDb} dB`);
// Track fader too.
const trackFader = desk.getByRole("slider").first();
const tbox = await trackFader.boundingBox();
await desk.mouse.move(tbox.x + 2, tbox.y + 10);
await desk.mouse.down();
await desk.mouse.move(tbox.x + 2, tbox.y + tbox.height * 0.55, { steps: 4 });
await desk.mouse.up();
const afterTrackFader = await playerSnap();
check(
  "track fader drag changes gain",
  afterTrackFader.tracks.some((t) => Math.abs(t.gainDb) > 1),
  afterTrackFader.tracks.map((t) => `${t.gainDb}dB`).join(", "),
);

// Pause freezes the clock.
await desk.getByRole("button", { name: "Pause" }).click();
const paused1 = await playerSnap();
await desk.waitForTimeout(700);
const paused2 = await playerSnap();
check(
  "pause freezes the playhead",
  !paused1.playing && Math.abs(paused2.positionSec - paused1.positionSec) < 0.02,
  `pos ${paused1.positionSec.toFixed(2)}`,
);

// Click-to-seek on the ruler: position jumps near the click target.
const before = (await playerSnap()).positionSec;
// Click 1s into the selected take's slot: slot offset is 1s → click at ~2s.
const laneRuler = desk.locator("section .cursor-pointer").first();
const rbox = await laneRuler.boundingBox();
if (rbox) {
  await desk.mouse.click(rbox.x + 48, rbox.y + rbox.height / 2); // 48px = 2s at zoom 1
  const afterSeek = await playerSnap();
  check(
    "ruler click seeks",
    Math.abs(afterSeek.positionSec - before) > 0.05 || afterSeek.positionSec < 1.5,
    `pos ${before.toFixed(2)} → ${afterSeek.positionSec.toFixed(2)}`,
  );
} else {
  check("ruler click seeks", false, "ruler not clickable");
}

await desk.screenshot({ path: "screens/live-final.png" });

// --- verdict -----------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  ✗ ${f.name} ${f.detail}`);
}
await browser.close();
process.exit(failed.length > 0 ? 1 : 0);
