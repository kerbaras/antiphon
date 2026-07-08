// QA wave-2 group G4: F19 join-session feedback + phone/app LOWs.
//
// F19 — joining a made-up session id used to render the normal join page and
// happily enable the mic into a void. The join page now probes
// GET /api/sessions/:id on load (the endpoint answers 200 with an empty
// summary for unknown ids — no 404, flagged for the server wave; existence
// is therefore derived from the body: any takes, or any peer with role
// "desk") and renders an honest, non-gating warning that clears by gentle
// re-probe once a desk opens the link.
//
// LOWs — nickname 48-char cap enforceable at commit (paste/programmatic
// included), avatar initials must not split surrogate pairs (QA #14), and
// the wasm asset's two-fetch desk load is documented as intended
// (main thread + sink worker — one instantiation per JS context).

import { expect, test } from "@playwright/test";
import { deskState, joinAsRecorder, renamePeerFromDesk } from "./helpers/session";

const ABSENT_COPY = /this session doesn't exist \(yet\)/i;

async function openDesk(browser: import("@playwright/test").Browser, sessionId: string) {
  const desk = await (await browser.newContext()).newPage();
  await desk.goto(`/session/${sessionId}`);
  await expect(desk.getByText("ANTIPHON", { exact: true })).toBeVisible();
  // Fully joined (hello acked → peer row upserted server-side), so a probe
  // fired after this point definitely sees the desk. Generous deadline —
  // parallel suite load can starve the first WS handshake (see the
  // workers note in playwright.config.ts); the client re-dials every 2s.
  await expect
    .poll(async () => (await deskState(desk))?.signalingConnected ?? false, { timeout: 45_000 })
    .toBe(true);
  return desk;
}

test.describe("F19: session-existence feedback", () => {
  test("made-up session id warns honestly, never gates the mic, clears when a desk opens it", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const sessionId = crypto.randomUUID();
    const phone = await (await browser.newContext()).newPage();
    await phone.goto(`/join/${sessionId}`);

    // The honest state: copy + the full id for link-checking.
    await expect(phone.getByText(ABSENT_COPY)).toBeVisible({ timeout: 10_000 });
    await expect(phone.getByText(sessionId, { exact: true })).toBeVisible();
    // Capture never gates on the probe: the mic button stays enabled.
    await expect(phone.getByRole("button", { name: /enable microphone/i })).toBeEnabled();

    // A desk opens the invite moments later → the gentle re-probe clears it.
    const desk = await openDesk(browser, sessionId);
    await expect(phone.getByText(ABSENT_COPY)).toBeHidden({ timeout: 20_000 });
    await desk.close();
  });

  test("a real session shows no warning", async ({ browser }) => {
    const sessionId = crypto.randomUUID();
    const desk = await openDesk(browser, sessionId);

    const phone = await (await browser.newContext()).newPage();
    await phone.goto(`/join/${sessionId}`);
    await expect(phone.getByRole("button", { name: /enable microphone/i })).toBeVisible();
    // Let the probe round-trip settle, then assert it stayed quiet.
    await phone.waitForTimeout(2_000);
    await expect(phone.getByText(ABSENT_COPY)).toBeHidden();
    await desk.close();
  });

  test("landing join-by-code hints inline for a never-opened session without blocking Join", async ({
    page,
  }) => {
    const ghost = crypto.randomUUID();
    await page.goto("/");
    await page.getByLabel("Session link or id").fill(ghost);
    await expect(page.getByText(/no desk has opened this session yet/i)).toBeVisible({
      timeout: 10_000,
    });
    // Friction stays low: Join is enabled, navigation not gated.
    await expect(page.getByRole("button", { name: "Join" })).toBeEnabled();
    await page.getByRole("button", { name: "Join" }).click();
    await expect(page).toHaveURL(new RegExp(`/join/${ghost}`));
  });
});

test.describe("nickname 48-char cap at commit", () => {
  test("a 300-char programmatic paste commits as 48", async ({ page }) => {
    await page.goto("/rehearse");
    await page.getByRole("button", { name: /edit/i }).click();
    const input = page.getByPlaceholder("Your name");
    await expect(input).toBeVisible();

    // Bypass the input's maxLength the way paste/programmatic writes can:
    // set .value through the native setter and fire an input event (the QA
    // finding — the cap lived only on the DOM attribute, not at commit).
    await page.evaluate((longName) => {
      const el = document.querySelector<HTMLInputElement>('input[placeholder="Your name"]');
      if (!el) throw new Error("nickname input not found");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) throw new Error("no native value setter");
      setter.call(el, longName);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, "x".repeat(300));
    await page.getByRole("button", { name: "Save" }).click();

    // Committed (persisted + displayed) as exactly 48.
    const stored = await page.evaluate(() => localStorage.getItem("antiphon:nickname"));
    expect(stored).toBe("x".repeat(48));
    await expect(page.getByText("x".repeat(48), { exact: true })).toBeVisible();
  });
});

test.describe("avatar initials are emoji-safe (QA #14)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "fake mic is Chromium-only");

  test('"🎤 Zoë" renders "🎤Z" initials with no split surrogate anywhere', async ({ browser }) => {
    test.setTimeout(120_000);
    const sessionId = crypto.randomUUID();
    const desk = await openDesk(browser, sessionId);
    const phone = await (await browser.newContext()).newPage();
    await joinAsRecorder(phone, sessionId);
    await expect(desk.getByText("1 phone connected")).toBeVisible({ timeout: 15_000 });

    const peerId = ((await deskState(desk))?.session?.peers ?? []).find(
      (p) => p.role === "recorder",
    )?.peerId;
    expect(peerId).toBeTruthy();
    await renamePeerFromDesk(desk, peerId as string, "🎤 Zoë");

    // The initials render whole graphemes…
    await expect(desk.getByText("🎤Z").first()).toBeVisible({ timeout: 15_000 });
    // …and NOTHING on the desk carries an unpaired surrogate (the pre-fix
    // failure mode: "\uD83CZ", drawn as U+FFFD). With the /u flag a
    // surrogate range matches only LONE surrogates — pairs are code points.
    const loneSurrogate = await desk.evaluate(() =>
      /[\uD800-\uDFFF]/u.test(document.body.textContent ?? ""),
    );
    expect(loneSurrogate).toBe(false);
  });
});

test.describe("wasm fetch budget", () => {
  test("desk load fetches the wasm exactly twice: main thread + sink worker (intended)", async ({
    browser,
  }) => {
    // QA-2 F3 ("wasm asset fetched twice per load"): VERDICT — intended.
    // Wasm instantiation is per JS context; the desk needs the module on
    // the main thread (chirp/align/meters) AND inside the sink worker.
    // This spec pins the budget so a main-thread double-init (the loader
    // memoized a done-flag, not the in-flight promise) can never regress
    // it to three.
    const page = await (await browser.newContext()).newPage();
    const wasmFetches: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("antiphon_bg") && request.url().endsWith(".wasm")) {
        wasmFetches.push(request.url());
      }
    });
    await page.goto(`/session/${crypto.randomUUID()}`);
    await expect(page.getByText("ANTIPHON", { exact: true })).toBeVisible();
    await expect.poll(() => wasmFetches.length, { timeout: 20_000 }).toBe(2);
    // Settle window: nothing else re-fetches after boot.
    await page.waitForTimeout(2_500);
    expect(wasmFetches.length).toBe(2);
    await page.close();
  });
});
