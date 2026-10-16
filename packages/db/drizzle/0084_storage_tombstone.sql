CREATE TABLE "storage_tombstone" (
	"binding_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_tombstone_binding_id_external_id_pk" PRIMARY KEY("binding_id","external_id")
);
--> statement-breakpoint
ALTER TABLE "storage_tombstone" ADD CONSTRAINT "storage_tombstone_binding_id_storage_binding_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."storage_binding"("id") ON DELETE cascade ON UPDATE no action;