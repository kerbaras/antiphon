// Clerk identity plumbing. Exactly two operations leave this file, both
// engineered to keep Clerk OFF the hot paths:
//
// - verifyToken: NETWORKLESS session-token verification. @clerk/backend
//   verifies the JWT locally against the instance JWKS, which it fetches
//   once and caches in-memory (jwksCacheTtlInMs) — after warm-up there is
//   no Clerk round-trip per request, per connection, or (ever) per chunk.
// - userProfile: user → verified emails, resolved via the Backend API and
//   cached here with a TTL. Session JWTs carry `sub` but not emails; the
//   sharee check needs "any VERIFIED email of this user" (all of them —
//   a session-token claim could only carry the primary), so the deliberate
//   trade is one BAPI call per (user, TTL window) instead of an instance
//   config change. Revoking an email at Clerk propagates within the TTL.

import { createClerkClient, verifyToken } from "@clerk/backend";
import { createLogger } from "../logger.ts";

export interface UserProfile {
  /** Normalized (lowercase) verified emails; authorization compares these. */
  verifiedEmails: string[];
  /** Primary email (normalized) — the owner-email denormalization source. */
  primaryEmail: string | null;
}

/** The identity surface the server needs from Clerk. Tests inject a fake;
 * production wires createClerkAuth. */
export interface ClerkAuth {
  /** Bearer session token → user id, or null for anything invalid/expired.
   * MUST be networkless-after-warmup (no per-call Clerk round-trip). */
  verifyToken(token: string): Promise<{ userId: string } | null>;
  /** Verified emails of a user, cached — never called per message. */
  userProfile(userId: string): Promise<UserProfile>;
}

/** Emails move rarely; 5 min bounds both staleness (a just-verified email
 * starts matching within it) and revocation lag (documented). */
const PROFILE_TTL_MS = 5 * 60_000;
/** JWKS rotates ~never; 1h cache, refreshed transparently by the SDK. */
const JWKS_TTL_MS = 60 * 60_000;

export function createClerkAuth(secretKey: string): ClerkAuth {
  const log = createLogger({ module: "auth" });
  const client = createClerkClient({ secretKey });
  const profiles = new Map<string, { at: number; profile: Promise<UserProfile> }>();

  return {
    async verifyToken(token) {
      try {
        const payload = await verifyToken(token, { secretKey, jwksCacheTtlInMs: JWKS_TTL_MS });
        return typeof payload.sub === "string" && payload.sub ? { userId: payload.sub } : null;
      } catch {
        // Expired/garbage/foreign-instance tokens are a normal hostile
        // input, not a server error: they read as "not authenticated".
        return null;
      }
    },

    userProfile(userId) {
      const cached = profiles.get(userId);
      if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return cached.profile;
      const profile = (async (): Promise<UserProfile> => {
        const user = await client.users.getUser(userId);
        const verifiedEmails = user.emailAddresses
          .filter((e) => e.verification?.status === "verified")
          .map((e) => e.emailAddress.toLowerCase());
        const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
        return {
          verifiedEmails,
          primaryEmail: primary?.emailAddress.toLowerCase() ?? verifiedEmails[0] ?? null,
        };
      })();
      // Failures must not poison the cache for the TTL: evict on rejection
      // so the next request retries (and log — this is the one Clerk call
      // that can fail independently of the token).
      profile.catch((error: unknown) => {
        log.warn("clerk user profile fetch failed", { userId, error });
        if (profiles.get(userId)?.profile === profile) profiles.delete(userId);
      });
      profiles.set(userId, { at: Date.now(), profile });
      return profile;
    },
  };
}
