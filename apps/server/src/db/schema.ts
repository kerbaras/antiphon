// Drizzle schema: the metadata half of the archive (blobs live in the blob
// store). Chunk rows are the durable source of truth for reconciliation
// state — a server restart rebuilds its SinkEngine from here (RFC §8).

import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** Postgres bytea (drizzle-orm has no built-in); postgres-js maps Buffer↔bytea. */
const bytea = customType<{ data: Buffer }>({
  dataType: () => "bytea",
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Touched on join and take start/stop (signaling-level, never per-chunk);
   * the expiry sweep hard-deletes sessions idle past SESSION_TTL_HOURS. */
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
  /** Clerk user id of the session owner (W8-A). NULL in keyless mode and
   * for legacy sessions; with auth ON, the first authenticated desk opener
   * claims an ownerless session (atomic claim in auth/access.ts) — after
   * that the desk surface is owner+sharee only. Never a foreign key: users
   * live in Clerk, not in this database. */
  ownerUserId: text("owner_user_id"),
  /** Owner's primary email at claim/create time, normalized lowercase.
   * Deliberate denormalization: the landing's "Shared with me" list shows
   * who owns a session without a Clerk API call per row. Display-only —
   * authorization always compares ownerUserId / session_shares. */
  ownerEmail: text("owner_email"),
});

/** W8-A desk-access shares: (session, normalized-lowercase email). Grants
 * the USE capability (desk surface) to any Clerk user holding a VERIFIED
 * matching email — distinct from the mic-join capability, which stays a
 * public bearer link (RFC §12). Rows are meaningful only when auth is ON;
 * keyless mode never reads this table. */
export const sessionShares = pgTable(
  "session_shares",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** Always normalized (trim + lowercase) before write — matching is
     * exact string equality against the user's verified emails. */
    email: text("email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Clerk user id of the sharer (the owner; manage API is owner-only). */
    createdBy: text("created_by").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.email] }), index("shares_email_idx").on(t.email)],
);

export const peers = pgTable("peers", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["desk", "recorder"] }).notNull(),
  userAgent: text("user_agent").notNull().default(""),
  label: text("label"),
  /** Stable browser identity (A12): (session, role, device) resumes this peer id. */
  deviceId: uuid("device_id"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
});

export const takes = pgTable("takes", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  wallClockHint: text("wall_clock_hint"),
});

export const streams = pgTable(
  "streams",
  {
    id: uuid("id").primaryKey(),
    takeId: uuid("take_id")
      .notNull()
      .references(() => takes.id, { onDelete: "cascade" }),
    peerId: uuid("peer_id"),
    // Populated from the seq-0 stream header when it lands.
    sampleRate: integer("sample_rate"),
    bitsPerSample: integer("bits_per_sample"),
    channels: integer("channels"),
    deviceDesc: text("device_desc"),
    clockEpochUs: bigint("clock_epoch_us", { mode: "number" }),
    wallClockHintMs: bigint("wall_clock_hint_ms", { mode: "number" }),
    finalSeq: bigint("final_seq", { mode: "number" }),
    /** Fatal-but-kept conditions observed (§11): CRC conflict, discontinuity. */
    flagged: boolean("flagged").notNull().default(false),
  },
  (t) => [index("streams_take_idx").on(t.takeId)],
);

export const chunks = pgTable(
  "chunks",
  {
    streamId: uuid("stream_id")
      .notNull()
      .references(() => streams.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    takeId: uuid("take_id").notNull(),
    firstSampleIndex: bigint("first_sample_index", { mode: "number" }).notNull(),
    sampleCount: bigint("sample_count", { mode: "number" }).notNull(),
    captureTsUs: bigint("capture_ts_us", { mode: "number" }).notNull(),
    crc32c: bigint("crc32c", { mode: "number" }).notNull(),
    payloadLen: integer("payload_len").notNull(),
    blobKey: text("blob_key").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // The chunk key (take_id, stream_id, seq): stream ids are unique per take
  // by construction, so (stream_id, seq) is the enforcing key — inserts are
  // ON CONFLICT DO NOTHING, which is the idempotency law in SQL.
  (t) => [primaryKey({ columns: [t.streamId, t.seq] }), index("chunks_take_idx").on(t.takeId)],
);

export const gaps = pgTable(
  "gaps",
  {
    streamId: uuid("stream_id")
      .notNull()
      .references(() => streams.id, { onDelete: "cascade" }),
    startSeq: bigint("start_seq", { mode: "number" }).notNull(),
    endSeq: bigint("end_seq", { mode: "number" }).notNull(),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.streamId, t.startSeq] })],
);

/** W3-A shared project doc (Yjs): the session's mix/markers/comments/arrange
 * state as one merged CRDT update (`Y.encodeStateAsUpdate`). Audio bytes are
 * NEVER in here — blobs stay content-addressed in the blob store
 * (ARCHITECTURE §6); this row is small metadata like everything else. */
export const collabDocs = pgTable("collab_docs", {
  sessionId: uuid("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  doc: bytea("doc").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chirps = pgTable("chirps", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  emitTsDeskUs: bigint("emit_ts_desk_us", { mode: "number" }).notNull(),
  spec: jsonb("spec").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
