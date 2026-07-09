// F15 — top bar layout at narrow desktop widths.
//
// The prototype (docs/Antiphone DAW.dc.html) centers the transport cluster
// in the top bar. A literal absolute-centering port kept the cluster pinned
// to the viewport midpoint regardless of its neighbours, so below ~1200px it
// ran straight over the session-title block. Guard the degradation contract:
// from 1280 down to 900 the title block, the transport cluster and the
// right-hand controls never intersect, everything stays on-screen, and the
// title keeps a legible width.

import { expect, type Locator, test } from "@playwright/test";

test.skip(({ browserName }) => browserName !== "chromium", "desktop layout guard");

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function box(l: Locator, what: string): Promise<Box> {
  const b = await l.boundingBox();
  expect(b, `${what} has a bounding box`).not.toBeNull();
  return b as Box;
}

function intersect(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

const fmt = (b: Box) => `x ${b.x.toFixed(1)}–${(b.x + b.width).toFixed(1)}`;

for (const width of [1280, 1024, 900]) {
  test(`top bar: no collision at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/session/${crypto.randomUUID()}`);
    await expect(page.getByText("ANTIPHON", { exact: true })).toBeVisible();

    // The title/subtitle column (left), the transport cluster (center) and
    // the avatars/Export group (right; W4-D folded Share into the avatar
    // stack's "+") — located structurally, no test ids (house style).
    const titleBlock = page.locator("header span", { hasText: /^Session / }).locator("xpath=..");
    const cluster = page
      .locator("header > div")
      .filter({ has: page.getByRole("button", { name: "Record take" }) });
    const rightBlock = page
      .locator("header > div")
      .filter({ has: page.getByRole("button", { name: /Export/ }) });

    await expect(titleBlock).toBeVisible();
    await expect(cluster).toBeVisible();
    await expect(rightBlock).toBeVisible();

    const t = await box(titleBlock, "session-title block");
    const c = await box(cluster, "transport cluster");
    const r = await box(rightBlock, "right controls");

    // Evidence screenshot for design review (before/after the F15 fix).
    await page.screenshot({ path: test.info().outputPath(`topbar-${width}.png`) });

    expect(
      intersect(t, c),
      `session title (${fmt(t)}) must not run under the transport cluster (${fmt(c)})`,
    ).toBe(false);
    expect(
      intersect(c, r),
      `transport cluster (${fmt(c)}) must not run under the right controls (${fmt(r)})`,
    ).toBe(false);

    // Legibility: the title block keeps a readable width and every block
    // stays inside the viewport.
    expect(t.width, "session-title block keeps a legible width").toBeGreaterThan(70);
    expect(t.x).toBeGreaterThanOrEqual(0);
    expect(c.x + c.width).toBeLessThanOrEqual(width + 0.5);
    expect(r.x + r.width).toBeLessThanOrEqual(width + 0.5);

    // Prototype fidelity at full width: the transport cluster is centered
    // on the viewport midpoint and the stat chips are present.
    if (width >= 1280) {
      expect(Math.abs(c.x + c.width / 2 - width / 2), "transport cluster centered").toBeLessThan(2);
      await expect(page.getByText("48.0", { exact: true })).toBeVisible();
    }
  });
}
