CREATE TABLE "session_shares" (
	"session_id" uuid NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "session_shares_session_id_email_pk" PRIMARY KEY("session_id","email")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "owner_email" text;--> statement-breakpoint
ALTER TABLE "session_shares" ADD CONSTRAINT "session_shares_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shares_email_idx" ON "session_shares" USING btree ("email");