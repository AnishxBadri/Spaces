CREATE TABLE "worker_heartbeat" (
	"role" text PRIMARY KEY NOT NULL,
	"instance" text NOT NULL,
	"pid" integer NOT NULL,
	"booted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"beat_at" timestamp with time zone DEFAULT now() NOT NULL
);
