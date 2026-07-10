// W8-A live-Clerk journey against the REAL dev instance (app "Antiphon").
// Env-gated: self-skips without CLERK_SECRET_KEY + CLERK_PUBLISHABLE_KEY
// and lives in its own playwright project (never in the default suite):
//
//   set -a; source apps/server/.env; set +a
//   cd e2e && pnpm exec playwright test --project=live-clerk
//
// It boots a DEDICATED auth-enabled server behind a same-origin proxy (the
// shared keyless suite server stays untouched) and proves the whole spec:
// sign-in works with real keys UNDER cross-origin isolation (trap A), the
// owner creates + claims a session, a second user is refused desk access
// (REST + WS) until shared by email, both landing buckets render, the mic
// join stays accountless, and revoke bites on the next request.
//
// Conventions per the clerk-testing skill: +clerk_test emails (no real
// mail), fixed OTP 424242 via the email_code strategy, testing token to
// bypass bot detection. Users are created/deleted through the Backend API
// with the secret key from the environment — never logged, never persisted.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { WEB_PORT } from "../ports";
import {
  freePort,
  type SameOriginProxy,
  type ServerProcess,
  startDedicatedServer,
  startSameOriginProxy,
} from "./helpers/dedicated-server";
import { deskState, enableMicAndWait, recorderState } from "./helpers/session";

const SECRET_KEY = process.env.CLERK_SECRET_KEY?.trim() ?? "";
const PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY?.trim() ?? "";
const BAPI = "https://api.clerk.com/v1";

// ---- Backend API test-user management (skill: clerk-backend-api) ------------

interface TestUser {
  id: string;
  email: string;
}

async function createTestUser(tag: string): Promise<TestUser> {
  // +clerk_test emails: dev instances accept OTP 424242, no mail is sent.
  const email = `w8a-${tag}-${Date.now().toString(36)}+clerk_test@example.com`;
  const res = await fetch(`${BAPI}/users`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ email_address: [email], skip_password_requirement: true }),
  });
  if (!res.ok) throw new Error(`test-user create failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as {
    id: string;
    email_addresses?: Array<{ id: string }>;
  };
  // Mark the email VERIFIED up front: sharee matching only counts verified
  // emails (by design), and while the first email_code sign-in would
  // verify it anyway, the share must not depend on test ordering.
  const emailId = body.email_addresses?.[0]?.id;
  if (emailId) {
    await fetch(`${BAPI}/email_addresses/${emailId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${SECRET_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
  }
  return { id: body.id, email };
}

async function deleteTestUser(user: TestUser): Promise<void> {
  await fetch(`${BAPI}/users/${user.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${SECRET_KEY}` },
  }).catch(() => {
    // cleanup is best-effort; a leaked +clerk_test user is inert
  });
}

// ---- page drivers ------------------------------------------------------------

/** Sign a test user into the app (email_code + 424242 under the hood; the
 * helper injects the testing token so bot detection never fires). */
async function signIn(page: Page, origin: string, email: string): Promise<void> {
  await page.goto(`${origin}/`);
  // Auth-mode landing = Clerk shell mounted (window.Clerk exists).
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible({ timeout: 20_000 });
  await clerk.signIn({ page, signInParams: { strategy: "email_code", identifier: email } });
  await expect(page.getByText("Your sessions")).toBeVisible({ timeout: 20_000 });
}

async function bearerFetchStatus(page: Page, url: string): Promise<number> {
  return await page.evaluate(async (target) => {
    const w = window as unknown as {
      Clerk?: { session?: { getToken(): Promise<string | null> } };
    };
    const token = (await w.Clerk?.session?.getToken()) ?? null;
    const res = await fetch(target, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return res.status;
  }, url);
}

// ---- the journey ---------------------------------------------------------------

test.describe
  .serial("live Clerk: auth, sharing, landing, mic join (W8-A)", () => {
    test.skip(
      !SECRET_KEY || !PUBLISHABLE_KEY,
      "requires CLERK_SECRET_KEY + CLERK_PUBLISHABLE_KEY in the environment (dev instance)",
    );

    let server: ServerProcess;
    let proxy: SameOriginProxy;
    let origin: string;
    let owner: TestUser;
    let mate: TestUser;
    let ownerCtx: BrowserContext;
    let mateCtx: BrowserContext;
    let ownerPage: Page;
    let matePage: Page;
    let sessionId: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      await clerkSetup({ publishableKey: PUBLISHABLE_KEY });
      [owner, mate] = await Promise.all([createTestUser("owner"), createTestUser("mate")]);
      const apiPort = await freePort();
      server = await startDedicatedServer({
        port: apiPort,
        blobRoot: mkdtempSync(join(tmpdir(), "antiphon-live-clerk-")),
        env: { CLERK_SECRET_KEY: SECRET_KEY, CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY },
      });
      proxy = await startSameOriginProxy(WEB_PORT, apiPort);
      origin = proxy.origin;
      ownerCtx = await browser.newContext();
      mateCtx = await browser.newContext();
      ownerPage = await ownerCtx.newPage();
      matePage = await mateCtx.newPage();
    });

    test.afterAll(async () => {
      // Cleanup is best-effort and BOUNDED: pages hold live WS/WebRTC
      // links through the proxy, and any of these steps can wedge on a
      // half-dead socket — a leaked +clerk_test user or an expiring
      // session row must never fail the suite.
      test.setTimeout(120_000);
      const bounded = async (label: string, work: Promise<unknown>): Promise<void> => {
        await Promise.race([
          work.catch(() => undefined),
          new Promise((r) => setTimeout(r, 10_000)).then(() =>
            console.warn(`[live-clerk] cleanup step timed out: ${label}`),
          ),
        ]);
      };
      // Session hygiene first (owner token still live), then the users.
      if (sessionId && ownerPage) {
        await bounded(
          "session delete",
          ownerPage.evaluate(async (id) => {
            const w = window as unknown as {
              Clerk?: { session?: { getToken(): Promise<string | null> } };
            };
            const token = (await w.Clerk?.session?.getToken()) ?? null;
            if (token) {
              await fetch(`/api/sessions/${id}`, {
                method: "DELETE",
                headers: { authorization: `Bearer ${token}` },
              });
            }
          }, sessionId),
        );
      }
      if (owner) await bounded("owner delete", deleteTestUser(owner));
      if (mate) await bounded("mate delete", deleteTestUser(mate));
      await bounded("contexts", Promise.all([ownerCtx?.close(), mateCtx?.close()]));
      await bounded("proxy", proxy ? proxy.close() : Promise.resolve());
      await bounded("server", server ? server.kill() : Promise.resolve());
    });

    test("prebuilt sign-in UI renders under cross-origin isolation, and sign-in works", async () => {
      test.setTimeout(120_000);
      // Watch for COEP casualties: a subresource blocked by require-corp
      // logs ERR_BLOCKED_BY_RESPONSE — that is exactly trap A regressing.
      const blocked: string[] = [];
      ownerPage.on("requestfailed", (req) => {
        if (req.failure()?.errorText.includes("BLOCKED_BY_RESPONSE")) blocked.push(req.url());
      });

      await ownerPage.goto(`${origin}/`);
      expect(await ownerPage.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
      await expect(ownerPage.getByRole("button", { name: "Sign in" })).toBeVisible({
        timeout: 20_000,
      });
      // The REAL modal (Clerk's prebuilt component) must render with COEP
      // require-corp in force — the historical failure mode is a silently
      // blank sign-in.
      await ownerPage.getByRole("button", { name: "Sign in" }).click();
      await expect(
        ownerPage.locator(".cl-signIn-root, [data-clerk-component]").first(),
      ).toBeVisible({ timeout: 20_000 });
      await ownerPage.keyboard.press("Escape");

      await signIn(ownerPage, origin, owner.email);
      // Signed-in landing: UserButton (a Clerk component, avatars included)
      // and both buckets render; isolation is still intact.
      await expect(ownerPage.getByText("Shared with me")).toBeVisible();
      expect(await ownerPage.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
      expect(blocked).toEqual([]);
    });

    test("owner creates a session; the desk mounts, connects, stays isolated", async () => {
      test.setTimeout(120_000);
      await ownerPage.getByRole("button", { name: "Create session" }).click();
      await ownerPage.waitForURL(/\/session\/[0-9a-f-]{36}/, { timeout: 20_000 });
      sessionId = ownerPage.url().match(/\/session\/([0-9a-f-]{36})/)?.[1] ?? "";
      expect(sessionId).not.toBe("");
      await expect(ownerPage.getByRole("button", { name: "Record take" })).toBeVisible({
        timeout: 20_000,
      });
      await expect
        .poll(async () => (await deskState(ownerPage))?.signalingConnected ?? false, {
          timeout: 45_000,
        })
        .toBe(true);
      expect(await ownerPage.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
      // A16: the operator's own top-bar avatar wears the account pfp
      // (img.clerk.com under COEP require-corp — a broken CORP story
      // would fail this img and fall back to initials).
      await expect(ownerPage.locator('div[title="You (Desk)"] img')).toBeVisible({
        timeout: 15_000,
      });
    });

    test("second user without a share is refused: gate screen, REST 403, WS unauthorized", async () => {
      test.setTimeout(120_000);
      await signIn(matePage, origin, mate.email);
      await matePage.goto(`${origin}/session/${sessionId}`);
      await expect(matePage.getByText("No desk access")).toBeVisible({ timeout: 20_000 });

      // REST: the summary is desk-gated.
      expect(await bearerFetchStatus(matePage, `/api/sessions/${sessionId}`)).toBe(403);

      // WS: a desk hello with the mate's real token is refused with the
      // fatal `unauthorized` error BEFORE any session state attaches.
      const verdict = await matePage.evaluate(async (id) => {
        const w = window as unknown as {
          Clerk?: { session?: { getToken(): Promise<string | null> } };
        };
        const token = (await w.Clerk?.session?.getToken()) ?? null;
        const ws = new WebSocket(`ws://${location.host}/session/${id}/ws`);
        return await new Promise<{ type: string; code?: string } | null>((resolve) => {
          let reply: { type: string; code?: string } | null = null;
          const timer = setTimeout(() => {
            try {
              ws.close();
            } catch {
              // already closed
            }
            resolve(reply);
          }, 10_000);
          ws.addEventListener("open", () => {
            ws.send(
              JSON.stringify({
                v: 1,
                type: "hello",
                role: "desk",
                deviceInfo: { userAgent: "live-clerk-probe" },
                protocolVersions: [1],
                ...(token ? { authToken: token } : {}),
              }),
            );
          });
          ws.addEventListener("message", (ev) => {
            try {
              const msg = JSON.parse(String(ev.data)) as { type: string; code?: string };
              if (msg.type === "error" || msg.type === "welcome") reply = msg;
            } catch {
              // ignore non-JSON frames
            }
          });
          ws.addEventListener("close", () => {
            clearTimeout(timer);
            resolve(reply);
          });
        });
      }, sessionId);
      expect(verdict?.type).toBe("error");
      expect(verdict?.code).toBe("unauthorized");
    });

    test("owner shares by email from the merged '+' popover; the sharee's landing and desk both open", async () => {
      test.setTimeout(120_000);
      // The old top-bar Share button is gone: desk access lives in the
      // avatar-stack "+" popover, below the mic invite (one affordance,
      // both capability classes).
      await expect(ownerPage.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
      await ownerPage.getByRole("button", { name: "Invite performer", exact: true }).click();
      const popover = ownerPage.getByRole("dialog", { name: "Invite & access" });
      await expect(popover).toBeVisible();
      // Both capability sections in the one card: the mic QR + link, and
      // the desk-access management below it.
      await expect(popover.locator('svg[aria-label="Join QR code"]')).toBeVisible();
      await expect(popover.getByRole("button", { name: "Copy link" })).toBeVisible();
      await expect(popover.getByText("Desk access")).toBeVisible();
      // Hostile-typist input on purpose: server normalizes to lowercase.
      await popover.getByLabel("Share desk access by email").fill(mate.email.toUpperCase());
      await popover.getByRole("button", { name: "Share" }).click();
      await expect(popover.getByText(mate.email.toLowerCase())).toBeVisible({ timeout: 10_000 });
      await ownerPage.keyboard.press("Escape");

      // Sharee's landing: the session appears under "Shared with me".
      await matePage.goto(`${origin}/`);
      await expect(matePage.getByText("Shared with me")).toBeVisible({ timeout: 20_000 });
      const sharedEntry = matePage.getByTitle(`Open desk ${sessionId}`);
      await expect(sharedEntry).toBeVisible({ timeout: 20_000 });
      await sharedEntry.click();

      // Full desk powers for the sharee: the DAW mounts and connects.
      await expect(matePage.getByRole("button", { name: "Record take" })).toBeVisible({
        timeout: 20_000,
      });
      await expect
        .poll(async () => (await deskState(matePage))?.signalingConnected ?? false, {
          timeout: 45_000,
        })
        .toBe(true);
      // …but share management stays owner-only (the sharee's "+" popover
      // says so instead of showing the form).
      await matePage.getByRole("button", { name: "Invite performer", exact: true }).click();
      await expect(
        matePage.getByText("Only the session owner can manage desk access", { exact: false }),
      ).toBeVisible({ timeout: 10_000 });
      await expect(matePage.getByLabel("Share desk access by email")).toHaveCount(0);
      await matePage.keyboard.press("Escape");
    });

    test("owner's landing lists the session under Your sessions", async () => {
      test.setTimeout(60_000);
      const listPage = await ownerCtx.newPage();
      await listPage.goto(`${origin}/`);
      await expect(listPage.getByText("Your sessions")).toBeVisible({ timeout: 20_000 });
      await expect(listPage.getByTitle(`Open desk ${sessionId}`)).toBeVisible({ timeout: 20_000 });
      await listPage.close();
    });

    test("a SIGNED-IN mic join defaults its lane to the account email and wears the pfp (A16)", async () => {
      test.setTimeout(120_000);
      // Same context as the owner: the join page sees the signed-in user.
      const joinPage = await ownerCtx.newPage();
      await joinPage.goto(`${origin}/join/${sessionId}`);
      // No nickname configured → the working name is the account email…
      await expect(joinPage.getByText(owner.email)).toBeVisible({ timeout: 20_000 });
      await enableMicAndWait(joinPage);
      // …and the desk lane adopts it, wearing the account pfp on its chip
      // and in the top-bar stack.
      const laneHeader = ownerPage.locator("[data-lane-header]").first();
      await expect(laneHeader).toContainText(owner.email.slice(0, 12), { timeout: 20_000 });
      await expect(laneHeader.locator("img").first()).toBeVisible({ timeout: 15_000 });
      await expect(ownerPage.locator(`div[title="${owner.email}"] img`)).toBeVisible({
        timeout: 15_000,
      });
      await joinPage.close();
    });

    test("mic join needs no account and stays cross-origin isolated", async ({ browser }) => {
      test.setTimeout(120_000);
      const singerCtx = await browser.newContext(); // fresh: no Clerk cookies
      const singer = await singerCtx.newPage();
      await singer.goto(`${origin}/join/${sessionId}`);
      // The join page — not a sign-in wall.
      await expect(singer.getByText("ANTIPHON", { exact: true }).first()).toBeVisible();
      await expect(singer.getByRole("button", { name: "Sign in" })).toHaveCount(0);
      expect(await singer.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
      // The accountless recorder actually CONNECTS (public WS + ingest
      // leg) — the same enable-mic journey every keyless spec drives.
      await enableMicAndWait(singer);
      await expect
        .poll(async () => (await recorderState(singer))?.signalingConnected ?? false, {
          timeout: 45_000,
        })
        .toBe(true);
      await singerCtx.close();
    });

    test("revoke bites on the sharee's next request", async () => {
      test.setTimeout(120_000);
      await ownerPage.getByRole("button", { name: "Invite performer", exact: true }).click();
      const popover = ownerPage.getByRole("dialog", { name: "Invite & access" });
      await popover.getByRole("button", { name: `Revoke desk access for ${mate.email}` }).click();
      await expect(popover.getByText(mate.email)).toHaveCount(0, { timeout: 10_000 });
      await ownerPage.keyboard.press("Escape");

      await expect
        .poll(() => bearerFetchStatus(matePage, `/api/sessions/${sessionId}`), { timeout: 20_000 })
        .toBe(403);
      await matePage.goto(`${origin}/session/${sessionId}`);
      await expect(matePage.getByText("No desk access")).toBeVisible({ timeout: 20_000 });
    });
  });
