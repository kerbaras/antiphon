// W8-A authz matrix over real HTTP + WS transports, with MOCKED token
// verification (the ClerkAuth seam) — no Clerk round-trips anywhere. The
// live-Clerk journey (real keys, real sign-in) lives in the env-gated
// e2e spec; THIS suite is the exhaustive owner/sharee/public matrix:
//
//                 desk REST   desk WS   collab WS   mic WS   share mgmt
//   anonymous        401       reject    reject      OPEN       401
//   stranger         403       reject    reject      OPEN       403
//   sharee           200       welcome   open        OPEN     403 (owner-only)
//   owner            200       welcome   open        OPEN       2xx
//
// Plus: claim-on-first-open for legacy/ownerless sessions, email
// normalization, /exists staying public, and keyless mode staying
// byte-for-byte open. Requires Postgres (same harness as the other
// integration suites); skips when unreachable.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSignalingMessage, type SignalingMessage } from "@antiphon/protocol";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClerkAuth } from "../src/auth/clerk.ts";
import { startTestServer, type TestServer } from "./helpers.ts";

const ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://antiphon:antiphon@localhost:5433/antiphon";

let available = true;
try {
  const probe = postgres(ADMIN_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
} catch {
  available = false;
}

const suite = available ? describe : describe.skip;

async function freshDatabase(name: string): Promise<string> {
  const admin = postgres(ADMIN_URL, { max: 1 });
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  return ADMIN_URL.replace(/\/[^/]+$/, `/${name}`);
}

// ---- the fake Clerk: token → user, user → verified emails -------------------

interface FakeUser {
  userId: string;
  verifiedEmails: string[];
  primaryEmail: string | null;
}

const OWNER: FakeUser = {
  userId: "user_owner",
  verifiedEmails: ["owner@example.com"],
  primaryEmail: "owner@example.com",
};
/** Two verified emails — the sharee check must match ANY of them. */
const MATE: FakeUser = {
  userId: "user_mate",
  verifiedEmails: ["mate@choir.org", "alto.section@choir.org"],
  primaryEmail: "mate@choir.org",
};
const STRANGER: FakeUser = {
  userId: "user_stranger",
  verifiedEmails: ["stranger@elsewhere.io"],
  primaryEmail: "stranger@elsewhere.io",
};

const TOKENS = new Map<string, FakeUser>([
  ["tok-owner", OWNER],
  ["tok-mate", MATE],
  ["tok-stranger", STRANGER],
]);

const fakeClerk: ClerkAuth = {
  async verifyToken(token) {
    const user = TOKENS.get(token);
    return user ? { userId: user.userId } : null;
  },
  async userProfile(userId) {
    const user = [...TOKENS.values()].find((u) => u.userId === userId);
    if (!user) throw new Error(`unknown user ${userId}`);
    return { verifiedEmails: user.verifiedEmails, primaryEmail: user.primaryEmail };
  },
};

// ---- tiny transport helpers --------------------------------------------------

const authed = (token: string | null): Record<string, string> =>
  token ? { authorization: `Bearer ${token}` } : {};

async function createSession(baseUrl: string, token: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: authed(token),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { sessionId: string };
  return body.sessionId;
}

/** One desk/recorder hello over a real WS; resolves with the decisive
 * server reply (welcome or error) and whether the socket was closed. */
async function helloVerdict(
  baseUrl: string,
  sessionId: string,
  path: "session" | "join",
  role: "desk" | "recorder",
  authToken?: string,
): Promise<{ reply: SignalingMessage; closed: boolean }> {
  const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/${path}/${sessionId}/ws`);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no hello verdict within 5s")), 5_000);
    let reply: SignalingMessage | null = null;
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          v: 1,
          type: "hello",
          role,
          deviceInfo: { userAgent: "authz-suite" },
          protocolVersions: [1],
          ...(authToken ? { authToken } : {}),
        }),
      );
    });
    ws.addEventListener("message", (ev) => {
      const msg = parseSignalingMessage(String(ev.data));
      if (!msg || (msg.type !== "welcome" && msg.type !== "error")) return;
      reply = msg;
      // A welcome keeps the socket open — resolve and hang up ourselves.
      if (msg.type === "welcome") {
        clearTimeout(timer);
        ws.close();
        resolve({ reply: msg, closed: false });
      }
    });
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      if (reply) resolve({ reply, closed: true });
      else reject(new Error("ws closed without a verdict"));
    });
    ws.addEventListener("error", () => {
      // close fires after; verdict (if any) resolves there
    });
  });
}

/** Collab WS probe: resolves "open" when the server's sync step-1 frame
 * arrives, "refused" when the upgrade is rejected/closed before any frame. */
async function collabVerdict(
  baseUrl: string,
  sessionId: string,
  token?: string,
): Promise<"open" | "refused"> {
  const query = token ? `?auth_token=${encodeURIComponent(token)}` : "";
  const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/session/${sessionId}/collab${query}`);
  ws.binaryType = "arraybuffer";
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no collab verdict within 5s")), 5_000);
    ws.addEventListener("message", () => {
      clearTimeout(timer);
      ws.close();
      resolve("open");
    });
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      resolve("refused");
    });
    ws.addEventListener("error", () => {
      // close follows
    });
  });
}

// ---- the suite ---------------------------------------------------------------

suite("desk-surface authorization (W8-A)", () => {
  let server: TestServer;

  beforeAll(async () => {
    const dbUrl = await freshDatabase("antiphon_authz");
    server = await startTestServer(dbUrl, mkdtempSync(join(tmpdir(), "antiphon-authz-")), {
      auth: { clerkSecretKey: "sk_test_mocked", clerkPublishableKey: "pk_test_mocked" },
      clerkAuth: fakeClerk,
    });
  }, 30_000);

  afterAll(async () => {
    await server.stop();
  });

  it("reports clerk auth mode (and the publishable key) to the SPA", async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/config`);
    expect(await res.json()).toEqual({ enabled: true, publishableKey: "pk_test_mocked" });
  });

  it("session creation requires an account and records the creator as owner", async () => {
    const anon = await fetch(`${server.baseUrl}/api/sessions`, { method: "POST" });
    expect(anon.status).toBe(401);
    const bad = await fetch(`${server.baseUrl}/api/sessions`, {
      method: "POST",
      headers: authed("tok-garbage"),
    });
    expect(bad.status).toBe(401);

    const sessionId = await createSession(server.baseUrl, "tok-owner");
    const summary = await fetch(`${server.baseUrl}/api/sessions/${sessionId}`, {
      headers: authed("tok-owner"),
    });
    expect(summary.status).toBe(200);
    expect(((await summary.json()) as { access: string }).access).toBe("owner");
  });

  it("desk REST: 401 anonymous, 403 stranger, 404 unknown/malformed", async () => {
    const sessionId = await createSession(server.baseUrl, "tok-owner");
    expect((await fetch(`${server.baseUrl}/api/sessions/${sessionId}`)).status).toBe(401);
    expect(
      (
        await fetch(`${server.baseUrl}/api/sessions/${sessionId}`, {
          headers: authed("tok-stranger"),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${server.baseUrl}/api/sessions/${crypto.randomUUID()}`, {
          headers: authed("tok-stranger"),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${server.baseUrl}/api/sessions/not-a-uuid`, {
          headers: authed("tok-owner"),
        })
      ).status,
    ).toBe(404);
    // The take route sits behind the same gate.
    expect(
      (
        await fetch(`${server.baseUrl}/api/sessions/${sessionId}/takes/${crypto.randomUUID()}`, {
          headers: authed("tok-stranger"),
        })
      ).status,
    ).toBe(403);
  });

  it("/exists stays public in authed mode (mic join needs the typo probe)", async () => {
    const sessionId = await createSession(server.baseUrl, "tok-owner");
    expect((await fetch(`${server.baseUrl}/api/sessions/${sessionId}/exists`)).status).toBe(200);
    expect(
      (await fetch(`${server.baseUrl}/api/sessions/${crypto.randomUUID()}/exists`)).status,
    ).toBe(404);
  });

  it("share add normalizes email; sharee gains access via ANY verified email", async () => {
    const sessionId = await createSession(server.baseUrl, "tok-owner");
    // Pre-share: the mate is a stranger.
    expect(
      (
        await fetch(`${server.baseUrl}/api/sessions/${sessionId}`, {
          headers: authed("tok-mate"),
        })
      ).status,
    ).toBe(403);

    // Hostile-typist input: whitespace + mixed case → stored normalized.
    const add = await fetch(`${server.baseUrl}/api/sessions/${sessionId}/shares`, {
      method: "POST",
      headers: { ...authed("tok-owner"), "content-type": "application/json" },
      body: JSON.stringify({ email: "  Alto.Section@CHOIR.ORG " }),
    });
    expect(add.status).toBe(201);
    expect(await add.json()).toEqual({ email: "alto.section@choir.org" });

    const list = await fetch(`${server.baseUrl}/api/sessions/${sessionId}/shares`, {
      headers: authed("tok-owner"),
    });
    const shares = (await list.json()) as { shares: Array<{ email: string }> };
    expect(shares.shares.map((s) => s.email)).toEqual(["alto.section@choir.org"]);

    // The mate's SECOND verified email matches — access granted.
    const asMate = await fetch(`${server.baseUrl}/api/sessions/${sessionId}`, {
      headers: authed("tok-mate"),
    });
    expect(asMate.status).toBe(200);
    expect(((await asMate.json()) as { access: string }).access).toBe("sharee");

    // Idempotent re-add.
    const again = await fetch(`${server.baseUrl}/api/sessions/${sessionId}/shares`, {
      method: "POST",
      headers: { ...authed("tok-owner"), "content-type": "application/json" },
      body: JSON.stringify({ email: "alto.section@choir.org" }),
    });
    expect(again.status).toBe(201);

    // Garbage email shapes are refused.
    const junk = await fetch(`${server.baseUrl}/api/sessions/${sessionId}/shares`, {
      method: "POST",
      headers: { ...authed("tok-owner"), "content-type": "application/json" },
      body: JSON.stringify({ email: "not an email" }),
    });
    expect(junk.status).toBe(400);
  });

  it("share management is owner-only; revoke takes effect on next request", async () => {
    const sessionId = await createSession(server.baseUrl, "tok-owner");
    await fetch(`${server.baseUrl}/api/sessions/${sessionId}/shares`, {
      method: "POST",
      headers: { ...authed("tok-owner"), "content-type": "application/json" },
      body: JSON.stringify({ email: "mate@choir.org" }),
    });

    // A sharee has full desk powers EXCEPT share management (v1).
    for (const [method, url, body] of [
      ["GET", `${server.baseUrl}/api/sessions/${sessionId}/shares`, undefined],
      ["POST", `${server.baseUrl}/api/sessions/${sessionId}/shares`, { email: "x@y.zz" }],
      ["DELETE", `${server.baseUrl}/api/sessions/${sessionId}/shares/mate@choir.org`, undefined],
    ] as const) {
      const res = await fetch(url, {
        method,
        headers: { ...authed("tok-mate"), "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain("owner");
    }

    // Owner revokes (email in the path, normalized server-side).
    const revoke = await fetch(
      `${server.baseUrl}/api/sessions/${sessionId}/shares/MATE@choir.org`,
      { method: "DELETE", headers: authed("tok-owner") },
    );
    expect(revoke.status).toBe(204);
    expect(
      (
        await fetch(`${server.baseUrl}/api/sessions/${sessionId}`, {
          headers: authed("tok-mate"),
        })
      ).status,
    ).toBe(403);
  });

  it("legacy ownerless session: first authenticated desk opener claims it", async () => {
    // A pre-auth session (e.g. created keyless, or by a recorder joining
    // a void): row exists, no owner.
    const sessionId = crypto.randomUUID();
    await server.archive.ensureSession(sessionId);

    const first = await fetch(`${server.baseUrl}/api/sessions/${sessionId}`, {
      headers: authed("tok-mate"),
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { access: string }).access).toBe("owner");

    // Claim persisted: everyone else is now judged by normal rules.
    expect(
      (
        await fetch(`${server.baseUrl}/api/sessions/${sessionId}`, {
          headers: authed("tok-owner"),
        })
      ).status,
    ).toBe(403);
  });

  it("GET /api/me/sessions returns both buckets with owner attribution", async () => {
    expect((await fetch(`${server.baseUrl}/api/me/sessions`)).status).toBe(401);

    const owned = await createSession(server.baseUrl, "tok-stranger");
    await server.archive.ensureTake(owned, crypto.randomUUID());
    await server.archive.ensureTake(owned, crypto.randomUUID());
    const shared = await createSession(server.baseUrl, "tok-owner");
    await fetch(`${server.baseUrl}/api/sessions/${shared}/shares`, {
      method: "POST",
      headers: { ...authed("tok-owner"), "content-type": "application/json" },
      body: JSON.stringify({ email: "stranger@elsewhere.io" }),
    });

    const res = await fetch(`${server.baseUrl}/api/me/sessions`, {
      headers: authed("tok-stranger"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      own: Array<{ sessionId: string; takeCount: number; ownerEmail: string | null }>;
      shared: Array<{ sessionId: string; ownerEmail: string | null }>;
    };
    const ownEntry = body.own.find((s) => s.sessionId === owned);
    expect(ownEntry?.takeCount).toBe(2);
    const sharedEntry = body.shared.find((s) => s.sessionId === shared);
    expect(sharedEntry?.ownerEmail).toBe("owner@example.com");
    // Owned sessions never double-list in the shared bucket.
    expect(body.shared.some((s) => s.sessionId === owned)).toBe(false);
  });

  it("desk WS: anonymous/bad-token/stranger refused BEFORE any room state; owner+sharee welcomed", async () => {
    const sessionId = await createSession(server.baseUrl, "tok-owner");
    await fetch(`${server.baseUrl}/api/sessions/${sessionId}/shares`, {
      method: "POST",
      headers: { ...authed("tok-owner"), "content-type": "application/json" },
      body: JSON.stringify({ email: "mate@choir.org" }),
    });

    for (const token of [undefined, "tok-garbage", "tok-stranger"]) {
      const { reply, closed } = await helloVerdict(
        server.baseUrl,
        sessionId,
        "session",
        "desk",
        token,
      );
      expect(reply.type).toBe("error");
      if (reply.type === "error") {
        expect(reply.code).toBe("unauthorized");
        expect(reply.fatal).toBe(true);
      }
      expect(closed).toBe(true);
      // Trap D teeth: the refused desk attached NO session state — the
      // room was never created (sessionBusy would be true mid-init).
      expect(server.signaling.sessionBusy(sessionId)).toBe(false);
    }

    for (const token of ["tok-owner", "tok-mate"]) {
      const { reply } = await helloVerdict(server.baseUrl, sessionId, "session", "desk", token);
      expect(reply.type).toBe("welcome");
    }
  });

  it("mic join stays public: recorder hello needs no account in authed mode", async () => {
    const sessionId = await createSession(server.baseUrl, "tok-owner");
    const { reply } = await helloVerdict(server.baseUrl, sessionId, "join", "recorder");
    expect(reply.type).toBe("welcome");
  });

  it("desk WS on an unknown session: authenticated opener creates AND claims it", async () => {
    const sessionId = crypto.randomUUID();
    const { reply } = await helloVerdict(server.baseUrl, sessionId, "session", "desk", "tok-mate");
    expect(reply.type).toBe("welcome");
    const summary = await fetch(`${server.baseUrl}/api/sessions/${sessionId}`, {
      headers: authed("tok-mate"),
    });
    expect(((await summary.json()) as { access: string }).access).toBe("owner");
  });

  it("collab WS: upgrade refused without/with-bad token, open for owner and sharee", async () => {
    const sessionId = await createSession(server.baseUrl, "tok-owner");
    await fetch(`${server.baseUrl}/api/sessions/${sessionId}/shares`, {
      method: "POST",
      headers: { ...authed("tok-owner"), "content-type": "application/json" },
      body: JSON.stringify({ email: "mate@choir.org" }),
    });
    expect(await collabVerdict(server.baseUrl, sessionId)).toBe("refused");
    expect(await collabVerdict(server.baseUrl, sessionId, "tok-garbage")).toBe("refused");
    expect(await collabVerdict(server.baseUrl, sessionId, "tok-stranger")).toBe("refused");
    expect(await collabVerdict(server.baseUrl, sessionId, "tok-owner")).toBe("open");
    expect(await collabVerdict(server.baseUrl, sessionId, "tok-mate")).toBe("open");
  });

  it("flac export sits behind the desk gate (stream → session resolution)", async () => {
    const sessionId = await createSession(server.baseUrl, "tok-owner");
    const takeId = crypto.randomUUID();
    const streamId = crypto.randomUUID();
    await server.archive.ensureTake(sessionId, takeId);
    await server.archive.ensureStream(takeId, streamId);

    const url = `${server.baseUrl}/api/streams/${streamId}/flac`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: authed("tok-stranger") })).status).toBe(403);
    // Owner passes the gate; the archive then answers its own honest
    // status for a chunkless stream (409 not-yet / 404 never) — the point
    // is it is NOT an auth refusal.
    const asOwner = await fetch(url, { headers: authed("tok-owner") });
    expect([404, 409]).toContain(asOwner.status);
    expect((await fetch(`${server.baseUrl}/api/streams/${crypto.randomUUID()}/flac`)).status).toBe(
      401,
    );
  });

  it("session delete is a desk power (sharee included); strangers refused", async () => {
    const sessionId = await createSession(server.baseUrl, "tok-owner");
    await fetch(`${server.baseUrl}/api/sessions/${sessionId}/shares`, {
      method: "POST",
      headers: { ...authed("tok-owner"), "content-type": "application/json" },
      body: JSON.stringify({ email: "mate@choir.org" }),
    });
    expect(
      (
        await fetch(`${server.baseUrl}/api/sessions/${sessionId}`, {
          method: "DELETE",
          headers: authed("tok-stranger"),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${server.baseUrl}/api/sessions/${sessionId}`, {
          method: "DELETE",
          headers: authed("tok-mate"),
        })
      ).status,
    ).toBe(204);
    expect((await fetch(`${server.baseUrl}/api/sessions/${sessionId}/exists`)).status).toBe(404);
  });
});

suite("keyless mode stays byte-for-byte open (W8-A pin)", () => {
  let server: TestServer;

  beforeAll(async () => {
    const dbUrl = await freshDatabase("antiphon_keyless");
    server = await startTestServer(dbUrl, mkdtempSync(join(tmpdir(), "antiphon-keyless-")));
  }, 30_000);

  afterAll(async () => {
    await server.stop();
  });

  it("reports auth disabled and keeps every surface open without tokens", async () => {
    const mode = await fetch(`${server.baseUrl}/api/auth/config`);
    expect(await mode.json()).toEqual({ enabled: false, publishableKey: null });

    const created = await fetch(`${server.baseUrl}/api/sessions`, { method: "POST" });
    expect(created.status).toBe(201);
    const { sessionId } = (await created.json()) as { sessionId: string };

    const summary = await fetch(`${server.baseUrl}/api/sessions/${sessionId}`);
    expect(summary.status).toBe(200);
    // Pre-auth wire shape: no `access` field leaks into keyless mode.
    expect("access" in ((await summary.json()) as Record<string, unknown>)).toBe(false);

    expect((await fetch(`${server.baseUrl}/api/sessions/${sessionId}/exists`)).status).toBe(200);

    // The accounts surface simply does not exist keyless.
    expect((await fetch(`${server.baseUrl}/api/me/sessions`)).status).toBe(404);
    expect((await fetch(`${server.baseUrl}/api/sessions/${sessionId}/shares`)).status).toBe(404);

    // Desk WS and collab open with no token, exactly as before W8-A.
    const { reply } = await helloVerdict(server.baseUrl, sessionId, "session", "desk");
    expect(reply.type).toBe("welcome");
    expect(await collabVerdict(server.baseUrl, sessionId)).toBe("open");
  });
});
