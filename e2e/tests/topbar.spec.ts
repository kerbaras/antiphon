// F15 + W5-B — top bar (and toolbar) layout at narrow desktop widths.
//
// The prototype (docs/Antiphone DAW.dc.html) centers the transport cluster
// in the top bar. A literal absolute-centering port kept the cluster pinned
// to the viewport midpoint regardless of its neighbours, so below ~1200px it
// ran straight over the session-title block (F15). W5-B extended the
// degradation ladder after QA clamped the desk to 430px and watched the bar
// self-overlap: stat chips shed <1200, the wordmark lettering <840 (the mark
// stays), the timecode + presence avatars <640 (the "+" invite affordance
// survives; boundary set where the session title stays legible WITH them on
// screen — QA F5), and index.tsx floors the whole desk at 520px — below that
// the page scrolls instead of exploding. The toolbar's tiers are governed by
// the alignment verdict chip — the row's one flexible child, whose longest
// live string (declined, ~178px) must render whole at every width ≥ 700 (QA
// F2): view tabs return at 860, snap/grid at 1200, inert tools at 1380.
//
// Guard the contract: from 1280 down to 560 the title block, the transport
// cluster and the right-hand controls never intersect, everything stays
// on-screen, the title keeps a legible width, and the toolbar's two groups
// keep to their own sides. The verdict-chip budget is pinned with a LIVE
// declined verdict across the full width sweep. At 430 (below the floor)
// the bar keeps its shape and the page scrolls.

import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectTakeConverged, joinAsRecorder, startTake, stopTake } from "./helpers/session";

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

/** Structural top-bar locators (no test ids — house style). */
function topBarParts(page: Page) {
  return {
    titleBlock: page.locator("header span", { hasText: /^Session / }).locator("xpath=.."),
    cluster: page
      .locator("header > div")
      .filter({ has: page.getByRole("button", { name: "Record take" }) }),
    rightBlock: page
      .locator("header > div")
      .filter({ has: page.getByRole("button", { name: /Export/ }) }),
  };
}

for (const width of [1280, 1024, 900, 800, 700, 640, 560]) {
  test(`top bar: no collision at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/session/${crypto.randomUUID()}`);
    // The wordmark lettering is itself a shed tier (<840), so the ready
    // signal is the transport — present at every width.
    await expect(page.getByRole("button", { name: "Record take" })).toBeVisible();

    const { titleBlock, cluster, rightBlock } = topBarParts(page);
    await expect(titleBlock).toBeVisible();
    await expect(cluster).toBeVisible();
    await expect(rightBlock).toBeVisible();

    const t = await box(titleBlock, "session-title block");
    const c = await box(cluster, "transport cluster");
    const r = await box(rightBlock, "right controls");

    // Evidence screenshot for design review (before/after the F15/W5-B fixes).
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

    // Wordmark tier (W5-B): the lettering yields below 840 — the mark and
    // the session title carry the identity there.
    const lettering = page.getByText("ANTIPHON", { exact: true });
    if (width >= 840) await expect(lettering).toBeVisible();
    else await expect(lettering).toBeHidden();

    // Toolbar (W5-B): its left tools and right controls hold their own
    // sides too — at 1100 the view tabs used to run over the pills.
    const toolbar = page.locator("main > div").first();
    const toolLeft = await box(toolbar.locator("> div").first(), "toolbar tools");
    const toolRight = await box(toolbar.locator("> div").last(), "toolbar view/zoom");
    expect(
      intersect(toolLeft, toolRight),
      `toolbar tools (${fmt(toolLeft)}) must not run under the view/zoom group (${fmt(toolRight)})`,
    ).toBe(false);
    expect(toolRight.x + toolRight.width).toBeLessThanOrEqual(width + 0.5);

    // Prototype fidelity at full width: the transport cluster is centered
    // on the viewport midpoint and the stat chips are present.
    if (width >= 1280) {
      expect(Math.abs(c.x + c.width / 2 - width / 2), "transport cluster centered").toBeLessThan(2);
      await expect(page.getByText("48.0", { exact: true })).toBeVisible();
    }
  });
}

test("top bar: below the 520px floor the bar keeps its shape and the page scrolls (430px)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 430, height: 800 });
  await page.goto(`/session/${crypto.randomUUID()}`);
  await expect(page.getByRole("button", { name: "Record take" })).toBeVisible();

  // The desk floors at 520px (index.tsx main min-w): the document gains a
  // horizontal scroll range instead of the bar folding over itself.
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth, "the desk floors instead of compressing further").toBeGreaterThanOrEqual(520);

  const { titleBlock, cluster, rightBlock } = topBarParts(page);
  const t = await box(titleBlock, "session-title block");
  const c = await box(cluster, "transport cluster");
  const r = await box(rightBlock, "right controls");
  await page.screenshot({ path: test.info().outputPath("topbar-430.png") });

  expect(intersect(t, c), "title vs cluster").toBe(false);
  expect(intersect(c, r), "cluster vs right controls").toBe(false);
  // Single 48px row — nothing wrapped or spilled downward.
  for (const b of [t, c, r]) expect(b.y + b.height).toBeLessThanOrEqual(48.5);

  // Sub-640 tiers: the timecode yields; the transport and the "+" invite
  // affordance stay live.
  await expect(page.getByText("00:00:00:00", { exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Invite performer", exact: true })).toBeVisible();
});

// W5-B QA F2 — the verdict-chip budget, pinned structurally. The chip is
// the toolbar's ONE flexible child; every returning tier of inert chrome
// is a chance to squash it (it happened twice: 980-1200 in the first cut,
// then 1200-1345 in the "fix" — 4px at 1200, 84px at 1280). So the guard
// is a SWEEP with a live declined verdict (the longest chip string, what
// two sine-tone fake mics deterministically produce), not spot widths:
// every guarded width ≥ 700 including both sides of every tier boundary
// and QA's measured five, asserting ≥170px AND visually untruncated.
test("toolbar: the live declined verdict chip keeps ≥170px across the width sweep", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const sessionId = crypto.randomUUID();
  const desk = await (await browser.newContext()).newPage();
  await desk.setViewportSize({ width: 1440, height: 800 });
  await desk.goto(`/session/${sessionId}`);
  await expect(desk.getByRole("button", { name: "Record take" })).toBeVisible();

  const phoneA = await (await browser.newContext()).newPage();
  await joinAsRecorder(phoneA, sessionId);
  const phoneB = await (await browser.newContext()).newPage();
  await joinAsRecorder(phoneB, sessionId);
  await expect(desk.getByText("2 phones connected")).toBeVisible({ timeout: 15_000 });

  const takeId = await startTake(desk);
  await desk.waitForTimeout(2_500);
  await stopTake(desk);
  await expectTakeConverged(desk, sessionId, takeId, 2);

  // Auto-load + align-on-load (W4-B): the periodic sine correlates without
  // consensus → a declined verdict, the longest live chip copy.
  const chip = desk.getByTestId("align-outcome");
  await expect(chip).toBeVisible({ timeout: 60_000 });
  await expect(chip).toContainText("declined");

  for (const width of [
    700, 760, 800, 859, 860, 900, 1024, 1100, 1199, 1200, 1280, 1345, 1379, 1380, 1440,
  ]) {
    await desk.setViewportSize({ width, height: 800 });
    const b = await box(chip, `verdict chip at ${width}px`);
    expect(b.width, `chip width at ${width}px`).toBeGreaterThanOrEqual(170);
    expect(b.x + b.width, `chip on-screen at ${width}px`).toBeLessThanOrEqual(width + 0.5);
    const truncated = await chip.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(truncated, `chip visually whole at ${width}px`).toBe(false);
  }

  await phoneA.close();
  await phoneB.close();
  await desk.close();
});
