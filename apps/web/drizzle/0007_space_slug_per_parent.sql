DROP INDEX "space_slug_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "space_slug_per_parent_unique" ON "space" USING btree ("parent_id","slug") WHERE "space"."parent_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "space_slug_root_unique" ON "space" USING btree ("slug") WHERE "space"."parent_id" is null;