// Dependency-free ZIP writer, STORE method only (APPNOTE 4.4.x subset):
// local file headers + central directory + end-of-central-directory, CRC-32
// per entry, UTF-8 filenames. No compression — the payload is WAV, and PCM
// barely deflates; STORE keeps the writer ~100 lines and byte-predictable.
// (The wasm core exposes CRC-32C — Castagnoli — which ZIP does not accept;
// ZIP wants the IEEE 802.3 polynomial, hand-rolled below.)

export interface ZipEntry {
  /** Path inside the archive (UTF-8, forward slashes). */
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE, reflected, as ZIP/PNG/gzip use). */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time pair (2-second resolution, local time). */
function dosDateTime(d: Date): { date: number; time: number } {
  return {
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

/** General purpose flags: bit 11 = filenames are UTF-8. */
const FLAGS_UTF8 = 0x0800;
/** "Version needed to extract" 2.0 — plain STORE needs nothing newer. */
const VERSION = 20;

/** Build a complete single-disk ZIP. `modified` stamps every entry (a
 * take export is one moment in time; injectable for deterministic tests). */
export function buildZip(
  entries: ZipEntry[],
  modified: Date = new Date(),
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const { date, time } = dosDateTime(modified);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0; // running local-header offset for the central directory

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + name.length + entry.data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, VERSION, true);
    lv.setUint16(6, FLAGS_UTF8, true);
    lv.setUint16(8, 0, true); // method: STORE
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, entry.data.length, true); // compressed size (= raw)
    lv.setUint32(22, entry.data.length, true); // uncompressed size
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true); // extra field length
    local.set(name, 30);
    local.set(entry.data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory signature
    cv.setUint16(4, VERSION, true); // version made by
    cv.setUint16(6, VERSION, true); // version needed
    cv.setUint16(8, FLAGS_UTF8, true);
    cv.setUint16(10, 0, true); // method: STORE
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    // 30 extra len · 32 comment len · 34 disk start · 36 internal attrs
    // · 38 external attrs: all zero.
    cv.setUint32(42, offset, true); // local header offset
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // end-of-central-directory signature
  ev.setUint16(8, entries.length, true); // entries on this disk
  ev.setUint16(10, entries.length, true); // entries total
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true); // central directory offset

  const out = new Uint8Array(offset + centralSize + eocd.length);
  let cursor = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}
