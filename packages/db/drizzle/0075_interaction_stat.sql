CREATE TABLE "interaction_stat" (
	"entity_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"first_id" uuid,
	"first_at" timestamp with time zone,
	"last_id" uuid,
	"last_at" timestamp with time zone,
	"next_id" uuid,
	"next_at" timestamp with time zone,
	CONSTRAINT "interaction_stat_entity_id_kind_pk" PRIMARY KEY("entity_id","kind"),
	CONSTRAINT "interaction_stat_kind_check" CHECK ("interaction_stat"."kind" in ('email', 'meeting', 'call', 'any'))
);
--> statement-breakpoint
ALTER TABLE "interaction_stat" ADD CONSTRAINT "interaction_stat_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_stat" ADD CONSTRAINT "interaction_stat_first_id_interaction_id_fk" FOREIGN KEY ("first_id") REFERENCES "public"."interaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_stat" ADD CONSTRAINT "interaction_stat_last_id_interaction_id_fk" FOREIGN KEY ("last_id") REFERENCES "public"."interaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_stat" ADD CONSTRAINT "interaction_stat_next_id_interaction_id_fk" FOREIGN KEY ("next_id") REFERENCES "public"."interaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interaction_stat_next_idx" ON "interaction_stat" USING btree ("next_at") WHERE "interaction_stat"."next_at" is not null;--> statement-breakpoint
-- Backfill: the same computation as recomputeInteractionStats, over every edge.
WITH live AS (
	SELECT ie.entity_id, i.id, i.kind::text AS kind, i.occurred_at, (i.kind <> 'meeting' OR i.occurred_at <= now()) AS happened
	FROM interaction_entity ie
	JOIN interaction i ON i.id = ie.interaction_id
	WHERE NOT (i.kind = 'meeting' AND coalesce(i.meta ->> 'status', '') = 'cancelled')
),
tagged AS (
	SELECT entity_id, id, kind, occurred_at, happened FROM live
	UNION ALL
	SELECT entity_id, id, 'any', occurred_at, happened FROM live
),
computed AS (
	SELECT entity_id, kind,
		(array_agg(id ORDER BY occurred_at, id) FILTER (WHERE happened))[1] AS first_id,
		min(occurred_at) FILTER (WHERE happened) AS first_at,
		(array_agg(id ORDER BY occurred_at DESC, id DESC) FILTER (WHERE happened))[1] AS last_id,
		max(occurred_at) FILTER (WHERE happened) AS last_at,
		(array_agg(id ORDER BY occurred_at, id) FILTER (WHERE NOT happened))[1] AS next_id,
		min(occurred_at) FILTER (WHERE NOT happened) AS next_at
	FROM tagged
	GROUP BY entity_id, kind
)
INSERT INTO "interaction_stat" ("entity_id", "kind", "first_id", "first_at", "last_id", "last_at", "next_id", "next_at")
SELECT entity_id, kind, first_id, first_at, last_id, last_at, next_id, next_at
FROM computed
WHERE first_at IS NOT NULL OR next_at IS NOT NULL;
