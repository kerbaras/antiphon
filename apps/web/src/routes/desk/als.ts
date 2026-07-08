// Ableton Live set writer (W3-B): a real .als — gzipped XML — declaring
// one arrangement audio track per stem, mixer volume/pan/mute mirrored
// from the desk, and song markers as locators. Deliberately the MINIMAL
// subset of the Live 12 schema: Live's loader fills defaults for absent
// elements (the well-trodden path of every third-party set generator),
// and a small writer keeps field-level fixes cheap.
//
// Schema notes (researched from real Live 12 sets and open references —
// ableton-tools' als-format notes, dawtool, als2cue, the Live 12 demo
// header; we cannot run Live in this environment, so the invariants below
// are unit-tested structurally and the final "opens in Live" check is a
// MANUAL step, documented in the workstream report):
//
// - Header: <Ableton MajorVersion="5" MinorVersion="12.0_12049"
//   SchemaChangeCount="7" Creator=…> — the attributes a real Live 12.0
//   set carries. Live refuses sets NEWER than itself; 12.0 is the floor
//   we target (Live 11 users: use the project package instead).
// - Arrangement clips live at AudioTrack > DeviceChain > MainSequencer >
//   Sample > ArrangerAutomation > Events > AudioClip. Clip Time /
//   CurrentStart / CurrentEnd are in BEATS; Live requires a tempo, so we
//   write a fixed 120 BPM and place by seconds × (120/60) = 2 beats/sec.
// - Clips are UNWARPED (IsWarped false): the stem plays at its native
//   rate bit-faithfully — no time-stretch engine in the path. For
//   unwarped clips the Loop/OutMarker positions are in file SECONDS
//   (beats when warped) — the one field whose domain differs by mode.
// - Sample references: FileRef with RelativePathType 3 ("current
//   project") and a project-relative RelativePath — Live's own
//   collect-and-save convention, which is what makes the zip portable.
//   Path (absolute) is unknowable at export time and left empty; Live
//   resolves via the relative path. OriginalCrc 0 = "recompute on load".
// - Live 12 renamed the master track: the element is MainTrack (tempo
//   lives at MainTrack > DeviceChain > Mixer > Tempo > Manual).
// - Locators: LiveSet > Locators > Locators > Locator, Time in beats.
//
// Everything renders from the same aligned stems as the project package,
// so every clip starts at beat 0 — alignment/drift are already in the
// audio, and the set carries no warping to fight it.

import { gzip } from "./gzip";
import { el, serializeXml, val, type XmlElement } from "./xml";

/** The fixed project tempo. Choir takes are tempo-free; 120 BPM makes the
 * seconds→beats mapping a clean ×2 and is Live's own default. */
export const ALS_TEMPO_BPM = 120;

/** Folder inside the project the stems ship under — Live's convention for
 * media copied into a project ("collect all and save"). */
export const ALS_SAMPLES_DIR = "Samples/Imported";

const BEATS_PER_SEC = ALS_TEMPO_BPM / 60;

/** Live 12 track color indices (0–69 palette), one per lane, cycling. */
const TRACK_COLORS = [16, 4, 21, 12, 26, 58, 43, 34];

export interface AlsStem {
  /** Track + clip display name (the lane name / nickname). */
  name: string;
  /** WAV filename inside ALS_SAMPLES_DIR (no directories). */
  fileName: string;
  /** Stem length in seconds (every stem spans the whole export range). */
  durationSec: number;
  /** PCM frame count — SampleRef's DefaultDuration hint. */
  frames: number;
  /** Sample rate — SampleRef's DefaultSampleRate hint. */
  sampleRate: number;
  /** Encoded WAV byte size — FileRef's OriginalFileSize. */
  fileSizeBytes: number;
  /** Strip fader as LINEAR amplitude (Live's Volume Manual domain). */
  gainLinear: number;
  /** Strip pan, −1..+1 (Live's Pan Manual domain). */
  pan: number;
  /** Muted lanes export with the track activator (Speaker) off. */
  muted: boolean;
}

export interface AlsLocator {
  name: string;
  /** Seconds on the export's timeline (0 = first sample of the stems). */
  atSec: number;
}

export interface AlsSet {
  stems: AlsStem[];
  locators: AlsLocator[];
  masterGainLinear: number;
  masterPan: number;
}

/** The uncompressed Live set document. */
export function buildAlsXml(set: AlsSet): string {
  const root = el(
    "Ableton",
    {
      MajorVersion: "5",
      MinorVersion: "12.0_12049",
      SchemaChangeCount: "7",
      Creator: "Antiphon",
      Revision: "",
    },
    [
      el("LiveSet", {}, [
        el(
          "Tracks",
          {},
          set.stems.map((stem, i) => audioTrack(stem, i)),
        ),
        el("MainTrack", {}, [
          el("Name", {}, [val("EffectiveName", "Main"), val("UserName", "")]),
          el("DeviceChain", {}, [
            el("Mixer", {}, [
              el("Volume", {}, [val("Manual", set.masterGainLinear)]),
              el("Pan", {}, [val("Manual", set.masterPan)]),
              el("Tempo", {}, [val("Manual", ALS_TEMPO_BPM)]),
            ]),
          ]),
        ]),
        el("Locators", {}, [
          el(
            "Locators",
            {},
            set.locators.map((locator, i) =>
              el("Locator", { Id: i + 1 }, [
                val("LomId", 0),
                val("Time", locator.atSec * BEATS_PER_SEC),
                val("Name", locator.name),
                val("Annotation", ""),
                val("IsSongStart", false),
              ]),
            ),
          ),
        ]),
      ]),
    ],
  );
  return serializeXml(root);
}

function audioTrack(stem: AlsStem, index: number): XmlElement {
  const color = TRACK_COLORS[index % TRACK_COLORS.length] as number;
  return el("AudioTrack", { Id: 10 + index }, [
    val("LomId", 0),
    el("Name", {}, [
      val("EffectiveName", stem.name),
      val("UserName", stem.name),
      val("Annotation", ""),
    ]),
    val("Color", color),
    val("TrackGroupId", -1),
    el("DeviceChain", {}, [
      el("Mixer", {}, [
        // Speaker is the track activator: off = muted.
        el("Speaker", {}, [val("Manual", !stem.muted)]),
        el("Volume", {}, [val("Manual", stem.gainLinear)]),
        el("Pan", {}, [val("Manual", stem.pan)]),
      ]),
      el("MainSequencer", {}, [
        el("Sample", {}, [
          el("ArrangerAutomation", {}, [el("Events", {}, [audioClip(stem, color)])]),
        ]),
      ]),
    ]),
  ]);
}

function audioClip(stem: AlsStem, color: number): XmlElement {
  const endBeats = stem.durationSec * BEATS_PER_SEC;
  return el("AudioClip", { Id: 0, Time: 0 }, [
    // Arrangement bounds in beats. Every stem starts at 0 — alignment is
    // baked into the audio, so lanes line up with no clip offsets at all.
    val("CurrentStart", 0),
    val("CurrentEnd", endBeats),
    // Unwarped clip: Loop/OutMarker are in file seconds (see header note).
    el("Loop", {}, [
      val("LoopStart", 0),
      val("LoopEnd", stem.durationSec),
      val("StartRelative", 0),
      val("LoopOn", false),
      val("OutMarker", stem.durationSec),
      val("HiddenLoopStart", 0),
      val("HiddenLoopEnd", stem.durationSec),
    ]),
    val("Name", stem.name),
    val("Color", color),
    val("IsWarped", false),
    el("SampleRef", {}, [
      el("FileRef", {}, [
        // 3 = "relative to the current project" — the portable reference.
        val("RelativePathType", 3),
        val("RelativePath", `${ALS_SAMPLES_DIR}/${stem.fileName}`),
        // Absolute path is unknowable until the user unzips; Live falls
        // back to the relative path (and rewrites this on first save).
        val("Path", ""),
        val("Type", 1),
        val("LivePackName", ""),
        val("LivePackId", ""),
        val("OriginalFileSize", stem.fileSizeBytes),
        // 0 = let Live recompute; avoids a spurious "file changed" prompt.
        val("OriginalCrc", 0),
      ]),
      val("DefaultDuration", stem.frames),
      val("DefaultSampleRate", stem.sampleRate),
    ]),
  ]);
}

/** The .als file itself: the document gzipped (Live accepts any level). */
export async function buildAls(set: AlsSet): Promise<Uint8Array> {
  return gzip(new TextEncoder().encode(buildAlsXml(set)));
}
