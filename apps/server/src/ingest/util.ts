export const CHANNEL_LABELS = {
  data: "antiphon/1",
  sync: "antiphon-sync/1",
} as const;

export function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  if (hex.length !== 32) throw new Error(`bad uuid: ${uuid}`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
