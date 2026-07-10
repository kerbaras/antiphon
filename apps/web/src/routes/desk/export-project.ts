// DAW project exports: three package flavors over one render path, all
// client-side from the loaded take. project.json slices honestly — events
// inside the range, rebased onto the exported timeline (buildProjectManifest).

import { ALS_SAMPLES_DIR, type AlsStem, buildAls } from "./als";
import type { TakeComment } from "./comments";
import { getPlayer } from "./desk-state";
import { channelData, downloadBlob, requireRenderModel } from "./export-audio";
import { logicImportGuide } from "./logic-guide";
import type { Marker } from "./markers";
import { dbToLinear, type PlayerSnapshot } from "./player";
import { buildProjectManifest, type ProjectManifest } from "./project-manifest";
import { RENDER_SAMPLE_RATE, type RenderModel, renderMaster, renderStems } from "./render";
import { type RenderRange, resolveRange, type TrackTiming } from "./timeline-math";
import { fileSafe } from "./track-model";
import { encodeWav } from "./wav";
import { buildZip, type ZipEntry } from "./zip";

export interface ProjectLane {
  /** Mixer channel key (player ChannelStrip.key — the performer lane). */
  key: string;
  /** Human lane name (nickname when set) — labels stems and DAW tracks. */
  name: string;
  peerId: string | null;
}

/** Everything a project export needs beyond what the player holds. */
export interface ProjectExportContext {
  sessionId: string;
  lanes: ProjectLane[];
  markers: Marker[];
  comments: TakeComment[];
}

interface RenderedStem {
  streamId: string;
  channelKey: string;
  /** Bare WAV filename: lane name + first 8 chars of the stream id. */
  fileName: string;
  data: Uint8Array;
  frames: number;
  sampleRate: number;
  durationSec: number;
}

/** Render + encode the per-lane stems once; every package flavor bundles
 * these same bytes. Sequential renders — PCM is big. */
async function renderStemFiles(
  model: RenderModel,
  lanes: ProjectLane[],
  range?: RenderRange,
): Promise<RenderedStem[]> {
  const laneOf = new Map(lanes.map((lane) => [lane.key, lane]));
  const stems = await renderStems(model, range);
  return stems.map((stem) => {
    const lane = laneOf.get(stem.channelKey);
    return {
      streamId: stem.streamId,
      channelKey: stem.channelKey,
      fileName: `${lane ? `${fileSafe(lane.name)}-` : ""}${stem.streamId.slice(0, 8)}.wav`,
      data: new Uint8Array(encodeWav(channelData(stem.buffer), stem.buffer.sampleRate)),
      frames: stem.buffer.length,
      sampleRate: stem.buffer.sampleRate,
      durationSec: stem.buffer.duration,
    };
  });
}

function manifestOf(
  ctx: ProjectExportContext,
  model: RenderModel,
  snap: PlayerSnapshot,
  stems: RenderedStem[],
  range: { startSec: number; endSec: number },
): ProjectManifest {
  const trackOf = new Map(snap.tracks.map((t) => [t.streamId, t]));
  const timingOf = new Map(model.tracks.map((t) => [t.streamId, t.timing]));
  return buildProjectManifest({
    sessionId: ctx.sessionId,
    takeId: model.takeId,
    sampleRate: RENDER_SAMPLE_RATE,
    bitDepth: 24,
    range,
    takeDurationSec: model.durationSec,
    masterFile: "master.wav",
    masterDb: snap.masterDb,
    masterPan: snap.masterPan,
    masterEq: snap.masterEq,
    stems: stems.map((stem) => ({
      file: `stems/${stem.fileName}`,
      streamId: stem.streamId,
      channelKey: stem.channelKey,
      timing: timingOf.get(stem.streamId) as TrackTiming,
      alignment: trackOf.get(stem.streamId)?.alignment ?? null,
      drift: trackOf.get(stem.streamId)?.drift ?? null,
    })),
    channels: snap.channels,
    lanes: ctx.lanes,
    markers: ctx.markers,
    comments: ctx.comments,
  });
}

async function packageZip(
  fileName: string,
  ctx: ProjectExportContext,
  withLogicGuide: boolean,
  range?: RenderRange,
): Promise<void> {
  const model = requireRenderModel();
  const snap = getPlayer().snapshot();
  const resolved = resolveRange(model.durationSec, range);
  const stems = await renderStemFiles(model, ctx.lanes, range);
  const master = await renderMaster(model, range);
  const manifest = manifestOf(ctx, model, snap, stems, resolved);
  const entries: ZipEntry[] = [
    ...stems.map((stem) => ({ name: `stems/${stem.fileName}`, data: stem.data })),
    {
      name: "master.wav",
      data: new Uint8Array(encodeWav(channelData(master), master.sampleRate)),
    },
    {
      name: "project.json",
      data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
    },
  ];
  if (withLogicGuide) {
    entries.push({
      name: "IMPORT-GUIDE.md",
      data: new TextEncoder().encode(logicImportGuide(manifest)),
    });
  }
  downloadBlob(fileName, new Blob([buildZip(entries)], { type: "application/zip" }));
}

/** Project package (ZIP): per-lane aligned stems under stems/, the master
 * mix, and the schema-versioned project.json manifest. */
export async function exportProjectPackage(
  fileName: string,
  ctx: ProjectExportContext,
  range?: RenderRange,
): Promise<void> {
  await packageZip(fileName, ctx, false, range);
}

/** Logic / generic stems package: the project package plus an honest
 * IMPORT-GUIDE.md (Logic has no documented project format to write). */
export async function exportLogicPackage(
  fileName: string,
  ctx: ProjectExportContext,
  range?: RenderRange,
): Promise<void> {
  await packageZip(fileName, ctx, true, range);
}

/** Ableton Live project: "<setName> Project.zip" containing <setName>.als
 * plus the stems under Samples/Imported/ — Live's own project folder
 * convention, referenced from the set by relative path. */
export async function exportAbletonProject(
  setName: string,
  ctx: ProjectExportContext,
  range?: RenderRange,
): Promise<void> {
  const model = requireRenderModel();
  const snap = getPlayer().snapshot();
  const resolved = resolveRange(model.durationSec, range);
  const stems = await renderStemFiles(model, ctx.lanes, range);
  const stripOf = new Map(snap.channels.map((c) => [c.key, c]));
  const laneOf = new Map(ctx.lanes.map((lane) => [lane.key, lane]));
  const alsStems: AlsStem[] = stems.map((stem) => {
    const strip = stripOf.get(stem.channelKey);
    return {
      name: laneOf.get(stem.channelKey)?.name ?? stem.channelKey.slice(0, 8),
      fileName: stem.fileName,
      durationSec: stem.durationSec,
      frames: stem.frames,
      sampleRate: stem.sampleRate,
      fileSizeBytes: stem.data.length,
      gainLinear: dbToLinear(strip?.gainDb ?? 0),
      pan: strip?.pan ?? 0,
      muted: strip?.muted ?? false,
    };
  });
  // Markers live on the take's room timeline; the set's timeline starts at
  // the render range head. Whole-take passes through unchanged.
  const locators = ctx.markers
    .filter((m) => m.atSec >= resolved.startSec && m.atSec < resolved.endSec)
    .map((m) => ({ name: m.name, atSec: m.atSec - resolved.startSec }));
  const als = await buildAls({
    stems: alsStems,
    locators,
    masterGainLinear: dbToLinear(snap.masterDb),
    masterPan: snap.masterPan,
  });
  const entries: ZipEntry[] = [
    { name: `${setName}.als`, data: als },
    ...stems.map((stem) => ({ name: `${ALS_SAMPLES_DIR}/${stem.fileName}`, data: stem.data })),
  ];
  downloadBlob(
    `${setName} Project.zip`,
    new Blob([buildZip(entries)], { type: "application/zip" }),
  );
}
