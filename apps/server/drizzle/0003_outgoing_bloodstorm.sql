CREATE TABLE "collab_docs" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"doc" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collab_docs" ADD CONSTRAINT "collab_docs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;