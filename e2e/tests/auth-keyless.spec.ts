// W8-A keyless-mode pin. The default suite runs against a server whose
// Clerk keys are explicitly pinned empty (playwright.config webServer env
// — deterministic even when this worktree's apps/server/.env carries real
// keys), and in that mode EVERYTHING must look and behave exactly like the
// pre-auth product: no sign-in affordances anywhere, no Clerk network
// traffic, open desk surface. The other ~78 specs exercise the behavior;
// this one pins the mode itself and the absences that would otherwise
// regress silently.

import { expect, test } from "@playwright/test";

test.describe("keyless mode (auth off) stays the pre-W8-A product", () => {
  test("server reports auth disabled; accounts surface absent", async ({ page }) => {
    const config = await page.request.get("/api/auth/config");
    expect(config.status()).toBe(200);
    expect(await config.json()).toEqual({ enabled: false, publishableKey: null });
    // The accounts routes do not exist keyless — 404 like any unknown path.
    expect((await page.request.get("/api/me/sessions")).status()).toBe(404);
  });

  test("landing renders today's affordances and zero auth chrome", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("ANTIPHON", { exact: true })).toBeVisible();
    // Today's landing, positively pinned…
    await expect(page.getByRole("button", { name: "Create session" })).toBeVisible();
    await expect(page.getByLabel("Session link or id")).toBeVisible();
    // …and the auth-mode affordances demonstrably absent.
    await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create account" })).toHaveCount(0);
    await expect(page.getByText("Your sessions")).toHaveCount(0);
    await expect(page.getByText("Shared with me")).toHaveCount(0);
    // Clerk mounts nothing (no provider, no components) in keyless mode.
    await expect(page.locator("[data-clerk-component]")).toHaveCount(0);
  });

  test("desk opens with no account and carries no auth chrome", async ({ page }) => {
    await page.goto(`/session/${crypto.randomUUID()}`);
    // The DAW itself (not a sign-in screen): transport record button.
    await expect(page.getByRole("button", { name: "Record take" })).toBeVisible();
    await expect(page.getByText("Desk access")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
  });

  test("no Clerk bytes on the wire anywhere in keyless mode", async ({ page }) => {
    const clerkRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      // Any Clerk traffic — the CDN, the FAPI, avatars — or the lazy
      // clerk-shell chunk of our own bundle.
      if (/clerk/i.test(url)) clerkRequests.push(url);
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Create session" })).toBeVisible();
    await page.goto(`/join/${crypto.randomUUID()}`);
    await expect(page.getByText("ANTIPHON", { exact: true }).first()).toBeVisible();
    await page.waitForTimeout(500);
    expect(clerkRequests).toEqual([]);
  });
});
