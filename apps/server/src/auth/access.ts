// Desk-surface authorization. Two capability classes, distinct everywhere:
// USE a session (desk WS + collab + desk REST — owner or sharee; sharees
// get full desk powers, only share MANAGEMENT is owner-only) vs JOIN as
// mic (public bearer link, RFC §12 — this module is never consulted there).

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { schema } from "../db/index.ts";
import { createLogger } from "../logger.ts";
import type { ClerkAuth } from "./clerk.ts";

export type DeskRole = "owner" | "sharee";

export type DeskDecision =
  | { ok: true; role: DeskRole }
  | { ok: false; reason: "unknown-session" | "forbidden" };

/** One share row as served by the manage API. */
export interface ShareEntry {
  email: string;
  createdAt: string;
}

/** One row of the landing lists (GET /api/me/sessions). */
export interface SessionListEntry {
  sessionId: string;
  createdAt: string;
  lastActivityAt: string;
  takeCount: number;
  /** Only meaningful in the "shared with me" bucket (owner attribution). */
  ownerEmail: string | null;
}

/** The one email normalization in the system: trim + lowercase. Applied on
 * every write (shares) and every comparison side (Clerk emails are lowered
 * in clerk.ts) — matching is then exact string equality. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Hostile-input gate for the share API, not an RFC 5322 parser: one "@"
 * with something on both sides and no whitespace. Overly strict validation
 * here would only reject real addresses; the share is harmless until a
 * Clerk user actually verifies a matching email. */
export function isPlausibleEmail(email: string): boolean {
  return email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Abuse bound, not a product limit: a choir's desk share list is people
 * you know by name. */
const MAX_SHARES_PER_SESSION = 100;

export class DeskAccess {
  private readonly log = createLogger({ module: "auth" });
  private readonly db: Db;
  private readonly clerk: ClerkAuth;

  constructor(db: Db, clerk: ClerkAuth) {
    this.db = db;
    this.clerk = clerk;
  }

  /** Authorize against an EXISTING session (REST reads/mutations): unknown
   * sessions stay an honest 404 at the route — this must never create rows
   * (GET /api/sessions/:id existence semantics predate auth). */
  async authorize(sessionId: string, userId: string): Promise<DeskDecision> {
    const [row] = await this.db
      .select({ ownerUserId: schema.sessions.ownerUserId })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId));
    if (!row) return { ok: false, reason: "unknown-session" };
    if (row.ownerUserId === null) {
      const role = await this.claim(sessionId, userId);
      return { ok: true, role };
    }
    if (row.ownerUserId === userId) return { ok: true, role: "owner" };
    const { verifiedEmails } = await this.clerk.userProfile(userId);
    if (verifiedEmails.length > 0) {
      const [share] = await this.db
        .select({ email: schema.sessionShares.email })
        .from(schema.sessionShares)
        .where(
          and(
            eq(schema.sessionShares.sessionId, sessionId),
            inArray(schema.sessionShares.email, verifiedEmails),
          ),
        )
        .limit(1);
      if (share) return { ok: true, role: "sharee" };
    }
    return { ok: false, reason: "forbidden" };
  }

  /** Authorize a desk OPENING surface (signaling hello, collab connect):
   * creates the session row when absent — exactly the surfaces that
   * auto-create sessions today — so the opener becomes the owner. */
  async authorizeOrCreate(sessionId: string, userId: string): Promise<DeskDecision> {
    await this.db.insert(schema.sessions).values({ id: sessionId }).onConflictDoNothing();
    return await this.authorize(sessionId, userId);
  }

  /** Create a session owned by `userId` (POST /api/sessions). */
  async createOwned(sessionId: string, userId: string): Promise<void> {
    await this.db.insert(schema.sessions).values({
      id: sessionId,
      ownerUserId: userId,
      ownerEmail: await this.primaryEmail(userId),
    });
  }

  /** First authenticated desk opener claims an ownerless session. Atomic:
   * the WHERE owner IS NULL makes concurrent claimers serialize — exactly
   * one UPDATE wins; the loser re-reads and is judged by normal rules. */
  private async claim(sessionId: string, userId: string): Promise<DeskRole> {
    const claimed = await this.db
      .update(schema.sessions)
      .set({ ownerUserId: userId, ownerEmail: await this.primaryEmail(userId) })
      .where(and(eq(schema.sessions.id, sessionId), sql`${schema.sessions.ownerUserId} is null`))
      .returning({ id: schema.sessions.id });
    if (claimed.length > 0) {
      this.log.info("ownerless session claimed by first authenticated desk opener", {
        sessionId,
        userId,
      });
      return "owner";
    }
    // Lost the race — someone else just became owner; re-judge.
    const decision = await this.authorize(sessionId, userId);
    if (!decision.ok) throw new AccessDeniedError();
    return decision.role;
  }

  private async primaryEmail(userId: string): Promise<string | null> {
    try {
      return (await this.clerk.userProfile(userId)).primaryEmail;
    } catch {
      // Denormalized display data must never block a claim/create: the
      // owner column is what authorizes; the email is cosmetic.
      return null;
    }
  }

  // ---- share management (owner-only; enforced at the route) -----------------

  async listShares(sessionId: string): Promise<ShareEntry[]> {
    const rows = await this.db
      .select({ email: schema.sessionShares.email, createdAt: schema.sessionShares.createdAt })
      .from(schema.sessionShares)
      .where(eq(schema.sessionShares.sessionId, sessionId))
      .orderBy(schema.sessionShares.createdAt);
    return rows.map((r) => ({ email: r.email, createdAt: r.createdAt.toISOString() }));
  }

  /** Idempotent add (re-sharing the same email is a no-op, not an error).
   * Returns false when the abuse cap is hit. */
  async addShare(sessionId: string, email: string, createdBy: string): Promise<boolean> {
    const existing = await this.listShares(sessionId);
    if (existing.some((s) => s.email === email)) return true;
    if (existing.length >= MAX_SHARES_PER_SESSION) return false;
    await this.db
      .insert(schema.sessionShares)
      .values({ sessionId, email, createdBy })
      .onConflictDoNothing();
    this.log.info("desk access shared", { sessionId, email, createdBy });
    return true;
  }

  /** Idempotent revoke. Takes effect on the sharee's NEXT desk-surface
   * request/connection — live sockets are not severed in v1 (documented). */
  async removeShare(sessionId: string, email: string): Promise<void> {
    await this.db
      .delete(schema.sessionShares)
      .where(
        and(eq(schema.sessionShares.sessionId, sessionId), eq(schema.sessionShares.email, email)),
      );
    this.log.info("desk access revoked", { sessionId, email });
  }

  // ---- landing lists ---------------------------------------------------------

  /** Both landing buckets in one call: sessions the user owns, and sessions
   * shared to any of their verified emails (owned ones excluded from the
   * shared bucket — claiming your own share must not double-list). */
  async listUserSessions(
    userId: string,
  ): Promise<{ own: SessionListEntry[]; shared: SessionListEntry[] }> {
    const { verifiedEmails } = await this.clerk.userProfile(userId);
    // Hand-qualified on purpose: drizzle renders interpolated columns
    // UNqualified inside a correlated subquery, and takes."id" would then
    // shadow sessions."id" — counting zero forever.
    const takeCount = sql<number>`(
      select count(*)::int from "takes"
      where "takes"."session_id" = "sessions"."id"
    )`;
    const fields = {
      sessionId: schema.sessions.id,
      createdAt: schema.sessions.createdAt,
      lastActivityAt: schema.sessions.lastActivityAt,
      ownerEmail: schema.sessions.ownerEmail,
      takeCount,
    };
    const own = await this.db
      .select(fields)
      .from(schema.sessions)
      .where(eq(schema.sessions.ownerUserId, userId))
      .orderBy(desc(schema.sessions.lastActivityAt))
      .limit(200);
    const shared =
      verifiedEmails.length === 0
        ? []
        : await this.db
            .selectDistinctOn([schema.sessions.id], fields)
            .from(schema.sessions)
            .innerJoin(
              schema.sessionShares,
              and(
                eq(schema.sessionShares.sessionId, schema.sessions.id),
                inArray(schema.sessionShares.email, verifiedEmails),
              ),
            )
            .where(sql`${schema.sessions.ownerUserId} is distinct from ${userId}`)
            .limit(200);
    const entry = (r: (typeof own)[number]): SessionListEntry => ({
      sessionId: r.sessionId,
      createdAt: r.createdAt.toISOString(),
      lastActivityAt: r.lastActivityAt.toISOString(),
      takeCount: r.takeCount,
      ownerEmail: r.ownerEmail,
    });
    return {
      own: own.map(entry),
      shared: shared.map(entry).sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1)),
    };
  }
}

/** Thrown only by the claim-race re-read; routes map it to 403. */
export class AccessDeniedError extends Error {
  constructor() {
    super("desk access denied");
  }
}
