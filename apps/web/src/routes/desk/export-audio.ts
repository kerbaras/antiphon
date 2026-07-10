// Audio exports, out of the component tree: render the loaded take through
// an OfflineAudioContext (render.ts), encode WAV/FLAC/ZIP, hand the bytes
// to the browser as a download. Range-capable: no range = whole take.

import { encode_flac_mono, init as initWasm } from "@antiphon/core-wasm";
import { getPlayer } from "./desk-state";
import type { MidiEvent } from "./midi";
import { encodeMidiFile } from "./midi-file";
import {
  estimateSessionWavBytes,
  type RenderModel,
  renderMaster,
  renderSessionMaster,
  renderStems,
} from "./render";
import type { RenderRange } from "./timeline-math";
import { encodeWav } from "./wav";
import { buildZip } from "./zip";

/** Render the loaded take's master mix (mixer + master state, alignment,
 * drift — exactly what playback monitors) to a 24-bit 48 kHz stereo WAV. */
export async function exportMasterWav(fileName: string, range?: RenderRange): Promise<void> {
  const model = getPlayer().renderModel();
  if (!model) throw new Error("no take loaded");
  const buffer = await renderMaster(model, range);
  downloadBlob(
    fileName,
    new Blob([encodeWav(channelData(buffer), buffer.sampleRate)], {
      type: "audio/wav",
    }),
  );
}

/** Ask before rendering something enormous. Injectable for tests; the
 * default is the browser's own modal. */
export const SESSION_RENDER_CONFIRM_BYTES = 500 * 1024 * 1024;

/** Render the ENTIRE session's master mix: every take at its room offset,
 * silence in the gaps, one sequential per-take pass through the same
 * planSource math as playback. Above ~500 MB of WAV the operator confirms
 * first — a silent multi-GB allocation would be hostile. */
export async function exportSessionMasterWav(
  fileName: string,
  confirmLarge: (message: string) => boolean = (message) => window.confirm(message),
): Promise<void> {
  const player = getPlayer();
  const segments = player.sessionRenderPlan();
  if (segments.length === 0) throw new Error("no takes to render");
  const startSec = Math.min(...segments.map((s) => s.baseSec));
  const endSec = Math.max(...segments.map((s) => s.declaredEndSec));
  const estimated = estimateSessionWavBytes(endSec - startSec);
  if (
    estimated > SESSION_RENDER_CONFIRM_BYTES &&
    !confirmLarge(
      `The session master spans ${Math.round((endSec - startSec) / 60)} minutes — about ${Math.round(estimated / 1024 / 1024)} MB of WAV. Render it?`,
    )
  ) {
    return; // declined: not an error, just a no
  }
  const mix = await renderSessionMaster(segments, (takeId) => player.renderModelFor(takeId));
  downloadBlob(
    fileName,
    new Blob([encodeWav(mix.channelData, mix.sampleRate)], { type: "audio/wav" }),
  );
}

/** Stem archive format: identical mono 24-bit audio either way — FLAC is
 * the same lossless samples at roughly half the bytes. */
export type StemFormat = "wav" | "flac";

/** Render aligned+drift-corrected mono stems (pre-mix: strip gain/pan/
 * mute/solo intentionally not baked — see renderStems) and bundle them
 * into a STORE ZIP. `stemBaseName` maps each track to its archive filename
 * WITHOUT extension — the format choice owns that. */
export async function exportStemsZip(
  fileName: string,
  stemBaseName: (streamId: string, channelKey: string) => string,
  range?: RenderRange,
  format: StemFormat = "wav",
): Promise<void> {
  const model = getPlayer().renderModel();
  if (!model) throw new Error("no take loaded");
  if (format === "flac") await initWasm();
  const stems = await renderStems(model, range);
  const entries = stems.map((stem) => ({
    name: `${stemBaseName(stem.streamId, stem.channelKey)}.${format}`,
    data:
      format === "flac"
        ? encode_flac_mono(stem.buffer.getChannelData(0), stem.buffer.sampleRate, 24)
        : new Uint8Array(encodeWav(channelData(stem.buffer), stem.buffer.sampleRate)),
  }));
  downloadBlob(fileName, new Blob([buildZip(entries)], { type: "application/zip" }));
}

/** Render one master-mix WAV per song (marker span) and bundle them into a
 * STORE ZIP. Songs render sequentially: each is its own OfflineAudioContext
 * pass and PCM buffers are big. */
export async function exportSongsZip(
  fileName: string,
  songs: Array<{ fileName: string; range: RenderRange }>,
): Promise<void> {
  const model = getPlayer().renderModel();
  if (!model) throw new Error("no take loaded");
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  for (const song of songs) {
    const buffer = await renderMaster(model, song.range);
    entries.push({
      name: song.fileName,
      data: new Uint8Array(encodeWav(channelData(buffer), buffer.sampleRate)),
    });
  }
  downloadBlob(fileName, new Blob([buildZip(entries)], { type: "application/zip" }));
}

/** Download the take's captured MIDI as a standard MIDI file. Pure encode
 * (midi-file.ts) — no render pass, so no busy state. */
export function exportMidiFile(fileName: string, events: readonly MidiEvent[]): void {
  downloadBlob(fileName, new Blob([encodeMidiFile(events)], { type: "audio/midi" }));
}

export function requireRenderModel(): RenderModel {
  const model = getPlayer().renderModel();
  if (!model) throw new Error("no take loaded");
  return model;
}

export function channelData(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch));
}

export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Revoke after the download has had time to start (revoking immediately
  // races the browser's fetch of the blob URL).
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
