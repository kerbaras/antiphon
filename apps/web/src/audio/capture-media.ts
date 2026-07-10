// getUserMedia + track-readout helpers and capture id utilities, shared by
// the capture controller and its callers.

export interface CaptureFlags {
  // Newer specs allow string modes (e.g. echoCancellation: "browser").
  echoCancellation: boolean | string | undefined;
  noiseSuppression: boolean | string | undefined;
  autoGainControl: boolean | string | undefined;
  sampleRate: number | undefined;
  channelCount: number | undefined;
  deviceLabel: string;
  /** Live track's deviceId — what a device picker should show as selected. */
  deviceId: string | undefined;
}

/** The ONE getUserMedia call sites share: every processing flag OFF (the
 * sacred capture constraints — a phone call is not a recorder), mono,
 * optionally pinned to a device with `exact` so a stale id fails loudly
 * instead of silently recording the wrong mic; callers own the fallback. */
export function acquireStream(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
      ...(deviceId !== undefined ? { deviceId: { exact: deviceId } } : {}),
    },
  });
}

/** Honest flags readout from the live track (iOS may still misreport). */
export function flagsOf(stream: MediaStream): CaptureFlags {
  const track = stream.getAudioTracks()[0];
  const settings = track?.getSettings() ?? {};
  return {
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppression,
    autoGainControl: settings.autoGainControl,
    sampleRate: settings.sampleRate,
    channelCount: settings.channelCount,
    deviceLabel: track?.label ?? "unknown input",
    deviceId: settings.deviceId,
  };
}

export function defaultDeviceDesc(flags: CaptureFlags | null): string {
  const ua = navigator.userAgent;
  const device = /iPhone|iPad|Android/.exec(ua)?.[0] ?? "browser";
  return `${device} · ${flags?.deviceLabel ?? "mic"}`;
}

export function randomId(): Uint8Array {
  const id = new Uint8Array(16);
  crypto.getRandomValues(id);
  // UUIDv4 bits so the ids read as valid UUIDs everywhere.
  id[6] = ((id[6] as number) & 0x0f) | 0x40;
  id[8] = ((id[8] as number) & 0x3f) | 0x80;
  return id;
}

export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  if (hex.length !== 32) throw new Error(`bad uuid: ${uuid}`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
