// IMPORT-GUIDE.md for the Logic / generic stems package. Logic Pro has no
// documented project file format, so Antiphon does not fake a .logicx —
// it ships the honest package with exact import steps instead.

import { formatAt } from "./format";
import type { ProjectManifest } from "./project-manifest";

export function logicImportGuide(manifest: ProjectManifest): string {
  const stemLines = manifest.stems.map((s) => `- \`${s.file}\` — ${s.lane.name}`).join("\n");
  const songLines =
    manifest.songs.length > 0
      ? manifest.songs
          .map(
            (s) =>
              `- ${String(s.index).padStart(2, "0")} ${s.name} — starts at ${formatAt(s.startSec)}`,
          )
          .join("\n")
      : "- (no song markers were set on this take)";
  return `# Importing this take into Logic Pro

Logic Pro has no documented project format, so this package does not
pretend to be one. It is the take itself: one aligned mono WAV per
performer, the desk's master mix, and \`project.json\` with everything
else (mixer settings, EQ, song markers, comments). Every WAV starts at
0:00 and has identical length — microphone timing offsets and clock
drift are already corrected in the audio — so a plain import lines all
lanes up sample-accurately with no editing. The take is tempo-free:
ignore any tempo-detection prompt.

## Steps (Logic Pro)

1. Create an empty project: one audio track, sample rate ${manifest.sampleRate} Hz
   (File → Project Settings → Audio), Smart Tempo set to KEEP.
2. Drag all \`stems/*.wav\` into the track area at bar 1 and choose
   "Create new tracks" when prompted. Do not let Logic move or stretch
   the regions; all regions must sit exactly at the project start.
3. Optionally add \`master.wav\` on its own track as the desk's reference
   mix — mute it once your own mix takes shape.
4. Recreate the desk mix from \`project.json\` if you want its starting
   point: each stem lists fader gain (dB), pan, mute, and the 3-band EQ
   (low shelf 120 Hz / mid peak / high shelf 8 kHz).

The same steps work in any DAW that can import WAV at a fixed position.

## Stems

${stemLines}

## Songs on this take

${songLines}
`;
}
