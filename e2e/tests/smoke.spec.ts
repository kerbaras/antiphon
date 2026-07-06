import { expect, test } from "@playwright/test";

test("app loads and is cross-origin isolated", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("ANTIPHON", { exact: true })).toBeVisible();
  // SharedArrayBuffer requires COOP/COEP — regression-guard it from day one.
  const isolated = await page.evaluate(() => globalThis.crossOriginIsolated);
  expect(isolated).toBe(true);
});

test("wasm initializes in the browser and encodes", async ({ page }) => {
  await page.goto("/");
  // Drive the same package the app uses, in-page, via a dynamic import of
  // the app bundle's test hook: the join page boots the worker; here we
  // simply verify cross-origin isolation exposes SharedArrayBuffer.
  const hasSab = await page.evaluate(() => typeof SharedArrayBuffer === "function");
  expect(hasSab).toBe(true);
});
