// Drizzle schema: the metadata half of the archive (blobs live in the blob
// store). Chunk rows are the durable source of truth for reconciliation
// state — a server restart rebuilds its SinkEngine from here (RFC §8).

import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const peers = pgTable("peers", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["desk", "recorder"] }).notNull(),
  userAgent: text("user_agent").notNull().default(""),
  label: text("label"),
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

export const chirps = pgTable("chirps", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  emitTsDeskUs: bigint("emit_ts_desk_us", { mode: "number" }).notNull(),
  spec: jsonb("spec").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
