CREATE TABLE "email_grant" (
	"interaction_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_grant_interaction_id_user_id_pk" PRIMARY KEY("interaction_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "email_visibility" (
	"entity_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"scope" text DEFAULT 'workspace' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_visibility_entity_id_user_id_pk" PRIMARY KEY("entity_id","user_id"),
	CONSTRAINT "email_visibility_scope_check" CHECK ("email_visibility"."scope" = 'workspace')
);
--> statement-breakpoint
ALTER TABLE "email_grant" ADD CONSTRAINT "email_grant_interaction_id_interaction_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interaction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_grant" ADD CONSTRAINT "email_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_grant" ADD CONSTRAINT "email_grant_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_visibility" ADD CONSTRAINT "email_visibility_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_visibility" ADD CONSTRAINT "email_visibility_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;