// One-off generator for apps/web/public/favicon.ico — a browser-oriented
// ICO (PNG entries at 16/32 px) rendered from favicon.svg with the
// playwright Chromium this workspace already ships (no new deps, per the
// design-system "no deps" rule). Rerun after editing favicon.svg:
//   node e2e/make-favicon-ico.mjs
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svgPath = resolve(root, "apps/web/public/favicon.svg");
const icoPath = resolve(root, "apps/web/public/favicon.ico");

const svg = await readFile(svgPath, "utf8");
const sizes = [16, 32];

const browser = await chromium.launch();
const pngs = [];
for (const size of sizes) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<!doctype html><style>*{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  pngs.push(await page.screenshot({ omitBackground: true, type: "png" }));
  await page.close();
}
await browser.close();

// ICO container: 6-byte header, one 16-byte dir entry per image, PNG blobs.
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(pngs.length, 4);

const entries = [];
let offset = 6 + 16 * pngs.length;
pngs.forEach((png, i) => {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(sizes[i] === 256 ? 0 : sizes[i], 0); // width
  entry.writeUInt8(sizes[i] === 256 ? 0 : sizes[i], 1); // height
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += png.length;
});

await writeFile(icoPath, Buffer.concat([header, ...entries, ...pngs]));
console.log(`wrote ${icoPath} (${offset} bytes: ${sizes.join("/")}px PNG entries)`);
