import { expect, test } from "@playwright/test";

test("app loads and is cross-origin isolated", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Antiphon" })).toBeVisible();
  // SharedArrayBuffer requires COOP/COEP — regression-guard it from day one.
  const isolated = await page.evaluate(() => globalThis.crossOriginIsolated);
  expect(isolated).toBe(true);
});
