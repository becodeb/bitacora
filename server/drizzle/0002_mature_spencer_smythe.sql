ALTER TYPE "public"."attachment_derived_text_status" ADD VALUE 'not_available';--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "derived_text" text;--> statement-breakpoint
ALTER TABLE "entries" drop column "search_vector";--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('spanish', coalesce(text_body, '') || ' ' || coalesce(derived_text, ''))) STORED;--> statement-breakpoint
CREATE INDEX "entries_derived_text_trgm_idx" ON "entries" USING gin ("derived_text" gin_trgm_ops);
