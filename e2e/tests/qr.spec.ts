// The styled QR (rounded dots, inverted palette, center logo) must still be
// machine-readable — pretty is worthless if phones can't scan it. Rasterize
// the live SVG onto its card background and decode with ZXing, the engine
// class real camera scanners are built on.

import { expect, test } from "@playwright/test";
import { readBarcodes } from "zxing-wasm/reader";

test("styled join QR decodes to the join URL", async ({ page }) => {
  const sessionId = crypto.randomUUID();
  await page.goto(`/session/${sessionId}`);
  const svg = page.locator('svg[aria-label="Join QR code"]');
  await expect(svg).toBeVisible();

  const raster = await page.evaluate(() => {
    const source = document.querySelector('svg[aria-label="Join QR code"]');
    if (!source) return null;
    // Inline computed colors: CSS variables don't resolve inside an <img>.
    const clone = source.cloneNode(true) as SVGElement;
    const srcEls = [source, ...source.querySelectorAll("*")];
    const dstEls = [clone, ...clone.querySelectorAll("*")];
    srcEls.forEach((el, i) => {
      const cs = getComputedStyle(el as Element);
      const dst = dstEls[i] as SVGElement;
      if (cs.fill && cs.fill !== "none") dst.setAttribute("fill", cs.fill);
      if (cs.stroke && cs.stroke !== "none") dst.setAttribute("stroke", cs.stroke);
      // Inline style attrs referencing CSS vars would override the inlined
      // attributes and resolve to nothing inside the standalone <img>.
      dst.removeAttribute("style");
      dst.removeAttribute("class");
    });
    const size = 640;
    const margin = 64; // ≥4-module quiet zone at this scale
    // Without explicit dimensions an SVG <img> rasterizes at 150×150 and
    // gets blur-upscaled beyond recognition.
    clone.setAttribute("width", String(size - 2 * margin));
    clone.setAttribute("height", String(size - 2 * margin));
    const image = new Image();
    const svgText = new XMLSerializer().serializeToString(clone);
    image.src = `data:image/svg+xml;base64,${btoa(svgText)}`;
    return new Promise<{ data: number[]; width: number; height: number } | null>((resolve) => {
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(null);
        // The card surface the QR sits on.
        const card = getComputedStyle(document.documentElement)
          .getPropertyValue("--color-card")
          .trim();
        ctx.fillStyle = card || "#202122";
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(image, margin, margin, size - 2 * margin, size - 2 * margin);
        const pixels = ctx.getImageData(0, 0, size, size);
        resolve({ data: [...pixels.data], width: size, height: size });
      };
      image.onerror = () => resolve(null);
    });
  });

  expect(raster).not.toBeNull();
  if (!raster) return;
  // Node has no ImageData class; zxing-wasm only needs the shape.
  const imageData = {
    data: new Uint8ClampedArray(raster.data),
    width: raster.width,
    height: raster.height,
    colorSpace: "srgb",
  } as ImageData;
  const results = await readBarcodes(imageData, {
    formats: ["QRCode"],
    tryInvert: true,
    tryHarder: true,
  });
  expect(results.map((r) => r.text)).toContain(`http://localhost:4173/join/${sessionId}`);
});
