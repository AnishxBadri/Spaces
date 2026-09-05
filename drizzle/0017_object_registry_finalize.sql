ALTER TABLE "attribute" ALTER COLUMN "object_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute" DROP COLUMN "object_kind";--> statement-breakpoint
DROP TYPE "public"."attribute_object_kind";