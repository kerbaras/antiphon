// project.json (W3-B): the schema-versioned manifest inside every project
// export. The WAVs carry the audio; this file carries everything else the
// desk knows — identity, lane names, the full mixer state (EQ included),
// song markers, comments, and the alignment/drift measurements that were
// baked into the stems. It is the honest interchange format: any DAW (or
// script) can reconstruct the session from `stems/*.wav` + this file, and
// the .als / Logic packages are conveniences layered on top of it.
//
// Pure data in, JSON-safe object out — the builder never touches audio
// buffers or the DOM, so the schema round-trips under plain JSON and is
// unit-testable byte-for-byte.

import type { TakeComment } from "./comments";
import type { EqState } from "./eq";
import { type Marker, type Song, songsOf } from "./markers";
import type { AlignmentResult, ChannelStrip, DriftResult } from "./player";
import type { TrackTiming } from "./timeline-math";

export const PROJECT_MANIFEST_FORMAT = "antiphon/project";
export const PROJECT_MANIFEST_VERSION = 1;

/** Mixer strip state as the desk had it at export time. NOT baked into the
 * stem WAVs (stems are pre-mix source material); the master WAV is the one
 * render that has all of this applied. */
export interface ManifestMixer {
  /** Strip fader, dB (0 = unity; ≤ −60 = −∞). */
  gainDb: number;
  /** Stereo placement of the mono lane, −1 (L) .. +1 (R). */
  pan: number;
  muted: boolean;
  soloed: boolean;
  /** 3-band EQ: low shelf 120 Hz / mid peak (midHz, Q 1) / high shelf
   * 8 kHz, gains in dB; `bypassed` = the whole EQ is out of circuit. */
  eq: EqState;
}

export interface ManifestStem {
  /** Archive-relative path of this lane's aligned mono WAV. */
  file: string;
  /** Capture stream identity (server archive / FLAC source). */
  streamId: string;
  /** Mixer lane the stream plays through. `peerId` is the recorder
   * (performer device) identity when known; `name` is the human lane name
   * (nickname when set). */
  lane: { key: string; name: string; peerId: string | null };
  mixer: ManifestMixer;
  /** Raw alignment measurement. `method` "chirp" (or absent): `lagSamples`
   * = the RFC §10 sweep's position in this stream's own samples. `method`
   * "content" (W4-B fallback): the same lag domain, derived from content
   * cross-correlation against the reference stream. `applied` = the fit
   * was confident enough to schedule with. null = the take was never
   * aligned. (Field keeps its v1 name for schema stability.) */
  chirp: AlignmentResult | null;
  /** Clock-drift fit vs the reference stream: `ratio` is
   * target_clock/reference_clock (played back as playbackRate), `ppm` the
   * same as parts-per-million, `initialOffsetSamples` the fit's residual
   * head offset. `isReference` marks the stream the others were measured
   * against. null = fewer than two aligned streams. */
  drift: DriftResult | null;
  /** What IS rendered into the stem WAV — the room-clock mapping:
   * `headSec` buffer-seconds trimmed from the head (chirp + drift
   * residual), `ratio` the applied drift playback rate, `clipDelaySec` the
   * clip's arrangement position. Every stem starts at the range head and
   * has identical length, so lanes line up at 0:00 in any DAW. */
  baked: TrackTiming;
}

export interface ProjectManifest {
  format: typeof PROJECT_MANIFEST_FORMAT;
  /** Schema version — bump on any breaking shape change. */
  version: typeof PROJECT_MANIFEST_VERSION;
  /** ISO 8601 export timestamp. */
  createdAt: string;
  sessionId: string;
  takeId: string;
  /** Sample rate of every WAV in the package (the take's native rate). */
  sampleRate: number;
  /** WAV bit depth (integer PCM). */
  bitDepth: number;
  /** The slice of the take's room timeline this package renders, seconds
   * (0 = take head after alignment). v1 exports the whole take. */
  range: { startSec: number; endSec: number };
  /** The desk's reference mixdown — all mixer/master state applied. */
  master: { file: string; gainDb: number; pan: number; eq: EqState };
  stems: ManifestStem[];
  /** Named points on the take timeline (song starts). */
  markers: Marker[];
  /** Marker-derived spans: marker N → marker N+1, the last running to the
   * take end (endSec null). Slice the WAVs by these to split songs. */
  songs: Song[];
  /** Timestamped production notes ("alto flat at 2:31"), take timeline. */
  comments: TakeComment[];
}

/** Per-stem inputs, already joined by the caller (streamId ↔ lane ↔ file):
 * pure data — the audio itself never enters the manifest path. */
export interface ManifestStemInput {
  file: string;
  streamId: string;
  channelKey: string;
  timing: TrackTiming;
  alignment: AlignmentResult | null;
  drift: DriftResult | null;
}

export interface ManifestInput {
  sessionId: string;
  takeId: string;
  sampleRate: number;
  bitDepth: number;
  range: { startSec: number; endSec: number };
  masterFile: string;
  masterDb: number;
  masterPan: number;
  masterEq: EqState;
  stems: ManifestStemInput[];
  /** Mixer strips keyed by lane (player.snapshot().channels). */
  channels: readonly ChannelStrip[];
  /** Lane display names/peer ids, keyed like channels. */
  lanes: ReadonlyArray<{ key: string; name: string; peerId: string | null }>;
  markers: readonly Marker[];
  comments: readonly TakeComment[];
  /** Injectable for deterministic tests. */
  createdAt?: string;
}

export function buildProjectManifest(input: ManifestInput): ProjectManifest {
  const stripOf = new Map(input.channels.map((c) => [c.key, c]));
  const laneOf = new Map(input.lanes.map((l) => [l.key, l]));
  return {
    format: PROJECT_MANIFEST_FORMAT,
    version: PROJECT_MANIFEST_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    sessionId: input.sessionId,
    takeId: input.takeId,
    sampleRate: input.sampleRate,
    bitDepth: input.bitDepth,
    range: { startSec: input.range.startSec, endSec: input.range.endSec },
    master: {
      file: input.masterFile,
      gainDb: input.masterDb,
      pan: input.masterPan,
      eq: { ...input.masterEq },
    },
    stems: input.stems.map((stem) => {
      const strip = stripOf.get(stem.channelKey);
      const lane = laneOf.get(stem.channelKey);
      return {
        file: stem.file,
        streamId: stem.streamId,
        lane: {
          key: stem.channelKey,
          name: lane?.name ?? stem.channelKey,
          peerId: lane?.peerId ?? null,
        },
        mixer: {
          gainDb: strip?.gainDb ?? 0,
          pan: strip?.pan ?? 0,
          muted: strip?.muted ?? false,
          soloed: strip?.soloed ?? false,
          eq: strip
            ? { ...strip.eq }
            : { lowDb: 0, midDb: 0, midHz: 1_000, highDb: 0, bypassed: false },
        },
        chirp: stem.alignment ? { ...stem.alignment } : null,
        drift: stem.drift ? { ...stem.drift } : null,
        baked: { ...stem.timing },
      };
    }),
    markers: input.markers.map((m) => ({ ...m })),
    songs: songsOf(input.markers),
    comments: input.comments.map((c) => ({ ...c })),
  };
}

/** Parse + validate a serialized manifest (the schema's read side — used
 * by tests today, a future import path tomorrow). Throws on anything that
 * is not a version-1 antiphon/project document. */
export function parseProjectManifest(json: string): ProjectManifest {
  const doc = JSON.parse(json) as Partial<ProjectManifest> | null;
  if (doc === null || typeof doc !== "object") throw new Error("project.json: not an object");
  if (doc.format !== PROJECT_MANIFEST_FORMAT) {
    throw new Error(`project.json: unknown format ${JSON.stringify(doc.format)}`);
  }
  if (doc.version !== PROJECT_MANIFEST_VERSION) {
    throw new Error(`project.json: unsupported version ${JSON.stringify(doc.version)}`);
  }
  if (
    typeof doc.sessionId !== "string" ||
    typeof doc.takeId !== "string" ||
    typeof doc.sampleRate !== "number" ||
    !Array.isArray(doc.stems) ||
    !Array.isArray(doc.markers) ||
    !Array.isArray(doc.songs) ||
    !Array.isArray(doc.comments) ||
    typeof doc.master !== "object" ||
    doc.master === null
  ) {
    throw new Error("project.json: malformed manifest");
  }
  return doc as ProjectManifest;
}
