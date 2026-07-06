CREATE TABLE "chirps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"emit_ts_desk_us" bigint NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"stream_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"take_id" uuid NOT NULL,
	"first_sample_index" bigint NOT NULL,
	"sample_count" bigint NOT NULL,
	"capture_ts_us" bigint NOT NULL,
	"crc32c" bigint NOT NULL,
	"payload_len" integer NOT NULL,
	"blob_key" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunks_stream_id_seq_pk" PRIMARY KEY("stream_id","seq")
);
--> statement-breakpoint
CREATE TABLE "gaps" (
	"stream_id" uuid NOT NULL,
	"start_seq" bigint NOT NULL,
	"end_seq" bigint NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gaps_stream_id_start_seq_pk" PRIMARY KEY("stream_id","start_seq")
);
--> statement-breakpoint
CREATE TABLE "peers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"label" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "streams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"take_id" uuid NOT NULL,
	"peer_id" uuid,
	"sample_rate" integer,
	"bits_per_sample" integer,
	"channels" integer,
	"device_desc" text,
	"clock_epoch_us" bigint,
	"wall_clock_hint_ms" bigint,
	"final_seq" bigint,
	"flagged" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "takes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"wall_clock_hint" text
);
--> statement-breakpoint
ALTER TABLE "chirps" ADD CONSTRAINT "chirps_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_stream_id_streams_id_fk" FOREIGN KEY ("stream_id") REFERENCES "public"."streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gaps" ADD CONSTRAINT "gaps_stream_id_streams_id_fk" FOREIGN KEY ("stream_id") REFERENCES "public"."streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peers" ADD CONSTRAINT "peers_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "streams" ADD CONSTRAINT "streams_take_id_takes_id_fk" FOREIGN KEY ("take_id") REFERENCES "public"."takes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takes" ADD CONSTRAINT "takes_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_take_idx" ON "chunks" USING btree ("take_id");--> statement-breakpoint
CREATE INDEX "streams_take_idx" ON "streams" USING btree ("take_id");