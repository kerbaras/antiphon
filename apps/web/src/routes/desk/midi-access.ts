// Structural slices of the Web MIDI API — the DeskMidi manager's working
// types. Real MIDIAccess/MIDIInput satisfy them; tests inject scripted
// doubles (Chromium has no fake-MIDI-device launch flag).

export interface MidiMessageLike {
  data: Uint8Array | null;
  timeStamp: number;
}

export interface MidiInputLike {
  id: string;
  name: string | null;
  manufacturer: string | null;
  state?: string;
  addEventListener(type: "midimessage", listener: (e: MidiMessageLike) => void): void;
  removeEventListener(type: "midimessage", listener: (e: MidiMessageLike) => void): void;
}

export interface MidiAccessLike {
  inputs: { forEach(cb: (input: MidiInputLike) => void): void };
  addEventListener(type: "statechange", listener: () => void): void;
  removeEventListener(type: "statechange", listener: () => void): void;
}

export type MidiAccessFactory = () => Promise<MidiAccessLike>;

/** Web MIDI access, test-overridable: e2e installs a scripted access
 * object on __antiphonFakeMidi before the app boots. */
export function midiAccess(): Promise<MidiAccessLike> {
  const fake = (globalThis as { __antiphonFakeMidi?: MidiAccessLike }).__antiphonFakeMidi;
  if (fake) return Promise.resolve(fake);
  if (!("requestMIDIAccess" in navigator)) {
    return Promise.reject(new Error("Web MIDI unavailable in this browser"));
  }
  return navigator.requestMIDIAccess({ sysex: false });
}

export interface MidiInputOption {
  id: string;
  /** "name — manufacturer" when the port reports both. */
  label: string;
}

export function midiInputOption(input: MidiInputLike): MidiInputOption {
  const name = input.name?.trim() || "MIDI input";
  const maker = input.manufacturer?.trim();
  return { id: input.id, label: maker && !name.includes(maker) ? `${name} — ${maker}` : name };
}
