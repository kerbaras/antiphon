// JSONL codec for OPFS-stored take MIDI. Line 1 is the schema-versioned
// header {"antiphonMidiJsonl":1,"overflow":bool}; each later line is one
// MidiEvent. Per-line tolerance: a corrupt tail costs only the bad lines.

import { decodeMidiEventEntry, type MidiEvent, sortMidiEvents, type TakeMidi } from "./midi";

export const MIDI_JSONL_VERSION = 1;

interface JsonlHeader {
  antiphonMidiJsonl: number;
  overflow: boolean;
}

export function encodeMidiJsonl(midi: TakeMidi): string {
  const header: JsonlHeader = {
    antiphonMidiJsonl: MIDI_JSONL_VERSION,
    overflow: midi.overflow,
  };
  const lines = [JSON.stringify(header)];
  for (const e of sortMidiEvents(midi.events)) lines.push(JSON.stringify(e));
  return `${lines.join("\n")}\n`;
}

/** Decode a JSONL document. `null` = no usable header (wrong shape or an
 * unknown future version — don't guess at semantics we don't know). With a
 * good header: keep what parses, line by line. */
export function decodeMidiJsonl(text: string): TakeMidi | null {
  const lines = text.split("\n");
  let header: JsonlHeader | null = null;
  try {
    const parsed: unknown = JSON.parse(lines[0] ?? "");
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>).antiphonMidiJsonl === MIDI_JSONL_VERSION
    ) {
      header = {
        antiphonMidiJsonl: MIDI_JSONL_VERSION,
        overflow: (parsed as Record<string, unknown>).overflow === true,
      };
    }
  } catch {
    // fall through to null
  }
  if (!header) return null;
  const events: MidiEvent[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    try {
      const e = decodeMidiEventEntry(JSON.parse(line));
      if (e) events.push(e);
    } catch {
      // one bad line loses one event, not the take
    }
  }
  return { events: sortMidiEvents(events), overflow: header.overflow };
}
