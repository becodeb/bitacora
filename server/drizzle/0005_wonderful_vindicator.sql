ALTER TABLE "daily_rollups" ADD COLUMN "source_entry_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "memories_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "summary_generated_at" timestamp with time zone;