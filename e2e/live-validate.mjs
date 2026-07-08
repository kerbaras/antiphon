// LIVE end-to-end validation with REAL hardware: three recorder tabs share
// the MacBook microphone, the desk plays the calibration chirp through the
// speakers, and the acoustic loop (speaker → air → mic) drives real chirp
// alignment. Then playback, seek, mute/solo, and faders are exercised.
//
// Run with the preview + server up:  node e2e/live-validate.mjs
// Defaults to the fixed ports (4173/8787); in a worktree running the e2e
// suite, pass its derived port via ANTIPHON_E2E_WEB_PORT (see e2e/ports.ts).

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
const origin = `http://localhost:${process.env.ANTIPHON_E2E_WEB_PORT ?? 4173}`;

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

// Mixer strips are channel strips (per performer lane), NOT per-take: they
// must be editable right now — mid-recording, with nothing loaded at all.
const playerSnapEarly = () =>
  desk.evaluate(() => window.__antiphonDesk?.playerSnapshot?.() ?? null);
await desk.getByRole("button", { name: /^Mute/ }).first().click();
const earlyChannels = (await playerSnapEarly())?.channels ?? [];
check(
  "mixer mute works while recording, no take loaded",
  earlyChannels.some((c) => c.muted),
  earlyChannels.map((c) => `${c.key.slice(0, 6)}:${c.muted}`).join(", ") || "no channels",
);
await desk.getByRole("button", { name: /^Mute/ }).first().click(); // restore

// Pan knobs too: drag one right mid-recording, double-click to recenter.
const panKnob = desk.getByRole("slider", { name: / pan$/ }).first();
const pknob = await panKnob.boundingBox();
await desk.mouse.move(pknob.x + pknob.width / 2, pknob.y + pknob.height / 2);
await desk.mouse.down();
await desk.mouse.move(pknob.x + pknob.width / 2 + 40, pknob.y + pknob.height / 2, { steps: 4 });
await desk.mouse.up();
const pannedChannels = (await playerSnapEarly())?.channels ?? [];
check(
  "pan knob drags while recording, no take loaded",
  pannedChannels.some((c) => (c.pan ?? 0) > 0.3),
  pannedChannels.map((c) => `${c.key.slice(0, 6)}:${c.pan}`).join(", ") || "no channels",
);
await panKnob.dblclick();
const recentered = (await playerSnapEarly())?.channels ?? [];
check(
  "double-click recenters the pan knob",
  recentered.every((c) => (c.pan ?? 0) === 0),
  recentered.map((c) => `${c.pan}`).join(", "),
);

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

// Master meter during recording = bus sum of the live track levels.
const trackLevels = await deskLevels();
const masterLive = await desk.evaluate(() => window.__antiphonDesk?.ui?.()?.liveMasterLevel ?? 0);
check(
  "master meter is the mix of live tracks while recording",
  masterLive > 0 && masterLive >= Math.max(...trackLevels) * 0.9,
  `master ${masterLive.toFixed(4)} vs tracks ${trackLevels.map((l) => l.toFixed(4)).join(", ")}`,
);

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
// Definitive proof arrives later via correlation confidence; the peak rise
// factor stays modest because room noise floors move between runs.
const micHeardChirp = chirpPeaks.every((p, i) => p > Math.max(0.004, peaksBefore[i] * 1.25));
check(
  "all mics captured the chirp acoustically",
  micHeardChirp,
  micHeardChirp ? "" : "peaks did not rise — speakers muted or mic blocked by macOS?",
);
const deskBaseline = Math.max(0.004, ...deskLevelsBefore) * 1.25;
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

// True waveforms appear for ALL completed streams without any clicking.
let cachedWaves = 0;
for (let t = 0; t < 30; t++) {
  cachedWaves = await desk.evaluate(() => window.__antiphonDesk?.ui?.()?.waveformsCached ?? 0);
  if (cachedWaves >= 3) break;
  await desk.waitForTimeout(400);
}
check(
  "true waveforms cached for all streams (no click needed)",
  cachedWaves >= 3,
  `${cachedWaves}/3`,
);
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
// Gapless playback: sources must be scheduled exactly once for the whole
// run — every extra schedule() is an audible cut (regression guard for the
// status-poll re-schedule storm).
await desk.waitForTimeout(2500);
const schedules = (await playerSnap()).scheduleCount;
check(
  "continuous playback never re-schedules (no audible cuts)",
  schedules === 1,
  `scheduleCount ${schedules}`,
);
// Capture never stuttered either (mic delivery gaps would also click).
for (const [i, page] of phones.entries()) {
  const empty = await page.evaluate(() => window.__antiphon?.snapshot?.()?.ring?.emptyQuanta ?? -1);
  check(`phone ${i + 1} no capture stutter`, empty === 0, `empty quanta ${empty}`);
}
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
// Track fader too (pan knobs are sliders as well, so match by name).
const trackFader = desk.getByRole("slider", { name: / gain$/ }).first();
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

// --- timeline editing: space / lane seek / marquee / group drag --------------
const ui = () => desk.evaluate(() => window.__antiphonDesk?.ui?.() ?? null);
const timeline = desk.locator("section > div[role=presentation]").first();
const tbox2 = await timeline.boundingBox();
const HEADER_W = 232;
const RULER_HEIGHT = 30;
const ROW_H = 66;
const PX_PER_SEC = 24;

// Space toggles playback.
await desk.locator("body").click({ position: { x: 5, y: 300 } }); // drop focus, also a lane-less click
await desk.keyboard.press("Space");
await desk.waitForTimeout(500);
const sp1 = await playerSnap();
await desk.keyboard.press("Space");
await desk.waitForTimeout(300);
const sp2 = await playerSnap();
check(
  "space bar toggles play/pause",
  sp1.playing && !sp2.playing,
  `playing ${sp1.playing} → ${sp2.playing}`,
);

// Lane click on empty space (before the clips start at 1s) seeks: the
// target maps to take-time 0.
await desk.mouse.click(
  tbox2.x + HEADER_W + 0.5 * PX_PER_SEC,
  tbox2.y + RULER_HEIGHT + ROW_H / 2, // inside row 1's lane, left of its clip
);
await desk.waitForTimeout(300);
const afterLaneSeek = await playerSnap();
check(
  "timeline click moves the playhead",
  afterLaneSeek.positionSec < 0.2,
  `pos ${afterLaneSeek.positionSec.toFixed(2)} (want ≈0)`,
);

// Marquee: drag on empty lane space from right of the clips leftward across
// all three rows → selects all three clips.
await desk.mouse.move(tbox2.x + HEADER_W + 320, tbox2.y + RULER_HEIGHT + 8);
await desk.mouse.down();
await desk.mouse.move(tbox2.x + HEADER_W + 30, tbox2.y + RULER_HEIGHT + 3 * ROW_H - 8, {
  steps: 8,
});
await desk.mouse.up();
await desk.waitForTimeout(300);
const afterMarquee = await ui();
check(
  "marquee selects all clips it touches",
  (afterMarquee?.selection.length ?? 0) === 3,
  `${afterMarquee?.selection.length ?? 0}/3 selected`,
);

// Group drag: grab the first row's clip and pull it +2s; every selected clip
// moves together.
const clip = desk.locator("[data-clip]").first();
const cbox = await clip.boundingBox();
await desk.mouse.move(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2);
await desk.mouse.down();
await desk.mouse.move(cbox.x + cbox.width / 2 + 2 * PX_PER_SEC, cbox.y + cbox.height / 2, {
  steps: 6,
});
await desk.mouse.up();
await desk.waitForTimeout(400);
const afterDrag = await ui();
const starts = Object.values(afterDrag?.clipStarts ?? {});
const movedTogether =
  starts.length === 3 && starts.every((s) => Math.abs(s - (starts[0] ?? 0)) < 0.05);
check(
  "dragging a selected clip moves all selected clips together",
  movedTogether && Math.abs((starts[0] ?? 0) - 3) < 0.6, // 1s base + 2s drag
  `starts ${starts.map((s) => s.toFixed(2)).join(", ")}`,
);

// Nudge ONE clip relative to the others: clear the selection with an empty
// click, drag only row 1's clip a further +1.5s — the arrangement now has a
// relative offset, so total playable duration must grow by ~1.5s.
const durBefore = (await playerSnap()).durationSec;
await desk.mouse.click(tbox2.x + HEADER_W + 0.3 * PX_PER_SEC, tbox2.y + RULER_HEIGHT + 8);
await desk.waitForTimeout(200);
const clip0 = desk.locator("[data-clip]").first();
const c0 = await clip0.boundingBox();
await desk.mouse.move(c0.x + c0.width / 2, c0.y + c0.height / 2);
await desk.mouse.down();
await desk.mouse.move(c0.x + c0.width / 2 + 1.5 * PX_PER_SEC, c0.y + c0.height / 2, {
  steps: 5,
});
await desk.mouse.up();
await desk.waitForTimeout(400);
const durAfter = (await playerSnap()).durationSec;
check(
  "playback honors a per-clip offset (duration grows)",
  Math.abs(durAfter - durBefore - 1.5) < 0.3,
  `duration ${durBefore.toFixed(2)} → ${durAfter.toFixed(2)}`,
);
await desk.keyboard.press("Space");
await desk.waitForTimeout(600);
const spMoved = await playerSnap();
check(
  "playback runs on the edited arrangement",
  spMoved.playing,
  `pos ${spMoved.positionSec.toFixed(2)}`,
);
await desk.keyboard.press("Space");

// Space during recording stops the take.
await desk.getByRole("button", { name: "Record take" }).click();
await desk.waitForTimeout(1500);
await desk.keyboard.press("Space");
await desk.waitForTimeout(800);
const takeStopped = await desk.evaluate(
  () => window.__antiphonDesk?.snapshot()?.activeTakeId === null,
);
check("space bar stops an ongoing recording", takeStopped);

// --- per-lane record arm (the ● button in the track header) ------------------
// Disarm lane 1, roll take 3: that phone must sit the take out while the
// other two record; re-arm afterwards.
await desk.getByRole("button", { name: /^Arm/ }).first().click();
await desk.getByRole("button", { name: "Record take" }).click();
await desk.waitForTimeout(2000);
const armStates = await Promise.all(
  phones.map((p) =>
    p.evaluate(() => ({
      state: window.__antiphon?.snapshot?.()?.stats?.state ?? "idle",
      sittingOut: window.__antiphon?.sessionState?.()?.sittingOut ?? false,
    })),
  ),
);
const sitters = armStates.filter((s) => s.sittingOut && s.state !== "streaming").length;
const rollers = armStates.filter((s) => s.state === "streaming").length;
const deskDuringArm = await desk.evaluate(() => ({
  active: window.__antiphonDesk?.snapshot?.()?.activeTakeId?.slice(0, 6) ?? null,
  disarmed: window.__antiphonDesk?.snapshot?.()?.disarmedPeers?.length ?? -1,
}));
check(
  "disarmed lane sits the take out; the rest record",
  sitters === 1 && rollers === 2,
  `${armStates.map((s) => (s.sittingOut ? "out" : s.state)).join(", ")} (desk take=${deskDuringArm.active} disarmed=${deskDuringArm.disarmed})`,
);
await desk.keyboard.press("Space"); // stop take 3
await desk.waitForTimeout(800);
await desk.getByRole("button", { name: /^Arm/ }).first().click(); // re-arm

// --- take deletion: select clips, press Delete ------------------------------
// Three takes exist now (3 + 3 + 2 streams; take 3 sat one lane out). Wait
// for all eight streams to settle at the desk.
let allStreams = [];
for (let t = 0; t < 60; t++) {
  allStreams = await deskStatus();
  if (allStreams.length === 8 && allStreams.every((s) => s.complete)) break;
  await desk.waitForTimeout(500);
}
check(
  "all three takes complete before deletion",
  allStreams.length === 8 && allStreams.every((s) => s.complete),
  `${allStreams.filter((s) => s.complete).length}/8 complete`,
);

// Click one clip of take 2 → selects take 2, so the player loads it. The
// lane strips (e.g. the −31 dB fader dragged during take 1) must carry
// over — mixer state belongs to the performer lane, not the take.
const take1LoadedId = (await playerSnap()).loadedTakeId;
await desk.locator("[data-clip]", { hasText: "Take 2" }).first().click();
let carried = null;
for (let t = 0; t < 40; t++) {
  carried = await playerSnap();
  if (
    carried.loadedTakeId &&
    carried.loadedTakeId !== take1LoadedId &&
    carried.tracks.length === 3 &&
    !carried.loading
  ) {
    break;
  }
  await desk.waitForTimeout(400);
}
const carryDiag = await desk.evaluate(() => ({
  selected: window.__antiphonDesk?.ui?.()?.selectedTakeId ?? null,
  errors: window.__antiphonDesk?.snapshot?.()?.errors ?? [],
}));
check(
  "mixer state carries across takes (lane strips, not per-take)",
  carried.loadedTakeId !== take1LoadedId && carried.tracks.some((t) => t.gainDb < -5),
  `gains ${carried.tracks.map((t) => t.gainDb.toFixed(0)).join(",")} loaded=${carried.loadedTakeId?.slice(0, 6)} was=${take1LoadedId?.slice(0, 6)} sel=${carryDiag.selected?.slice(0, 6)} loading=${carried.loading} err=${carried.error ?? carryDiag.errors.join(";") ?? ""}`,
);
await desk.keyboard.press("Delete");
let afterSingleDelete = [];
for (let t = 0; t < 20; t++) {
  afterSingleDelete = await deskStatus();
  if (afterSingleDelete.length === 7) break;
  await desk.waitForTimeout(400);
}
check(
  "Delete removes the selected clip's stream",
  afterSingleDelete.length === 7 && (await desk.locator("[data-clip]").count()) === 7,
  `${afterSingleDelete.length} streams, ${await desk.locator("[data-clip]").count()} clips`,
);

// Marquee everything, Delete → the timeline empties end to end.
await desk.mouse.move(tbox2.x + HEADER_W + 560, tbox2.y + RULER_HEIGHT + 6);
await desk.mouse.down();
await desk.mouse.move(tbox2.x + HEADER_W + 10, tbox2.y + RULER_HEIGHT + 3 * ROW_H - 6, {
  steps: 8,
});
await desk.mouse.up();
await desk.waitForTimeout(300);
await desk.keyboard.press("Backspace"); // both keys must work
let afterFullDelete = [];
for (let t = 0; t < 20; t++) {
  afterFullDelete = await deskStatus();
  if (afterFullDelete.length === 0) break;
  await desk.waitForTimeout(400);
}
const playerAfterDelete = await playerSnap();
check(
  "deleting every clip empties the timeline and unloads the player",
  afterFullDelete.length === 0 && playerAfterDelete.loadedTakeId === null,
  `${afterFullDelete.length} streams, loaded=${playerAfterDelete.loadedTakeId}`,
);

// The server archive dropped the takes too.
const serverTakes = await desk.evaluate(async (sid) => {
  const res = await fetch(`/api/sessions/${sid}`);
  return (await res.json()).takes.length;
}, sessionId);
check("server archive dropped the deleted takes", serverTakes === 0, `${serverTakes} takes left`);

// And the deletion survives a desk reload: nothing rebuilds from OPFS.
await desk.reload();
await desk.waitForTimeout(2500);
const reborn = await desk.evaluate(() => {
  const snap = window.__antiphonDesk?.snapshot?.();
  return { streams: snap?.deskStatus?.length ?? -1, rebuilt: snap?.rebuiltChunks ?? -1 };
});
check(
  "deletion is durable across desk reload (OPFS wiped)",
  reborn.streams === 0 && reborn.rebuilt === 0,
  `streams ${reborn.streams}, rebuilt chunks ${reborn.rebuilt}`,
);

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
