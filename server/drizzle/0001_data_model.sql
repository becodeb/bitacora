CREATE TYPE "public"."attachment_derived_text_status" AS ENUM('pending', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."change_log_operation" AS ENUM('insert', 'update', 'delete');--> statement-breakpoint
CREATE TYPE "public"."chat_message_role" AS ENUM('user', 'assistant', 'tool');--> statement-breakpoint
CREATE TYPE "public"."entry_kind" AS ENUM('text', 'photo', 'voice');--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"derived_text_status" "attachment_derived_text_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_group_id" uuid NOT NULL,
	"target_table" text NOT NULL,
	"target_id" uuid NOT NULL,
	"operation" "change_log_operation" NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" "chat_message_role" NOT NULL,
	"content" jsonb NOT NULL,
	"entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_rollups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rollup_date" date NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "entry_kind" NOT NULL,
	"text_body" text,
	"source" jsonb,
	"metadata" jsonb,
	"embedding" vector(1024),
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('spanish', coalesce(text_body, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content" text NOT NULL,
	"topic_id" uuid,
	"source_entry_id" uuid NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"supersedes_id" uuid,
	"embedding" vector(1024),
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('spanish', coalesce(content, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"topic_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"summary" text,
	"embedding" vector(1024),
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('spanish', coalesce(name, '') || ' ' || coalesce(description, '') || ' ' || coalesce(summary, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_entry_id_entries_id_fk" FOREIGN KEY ("source_entry_id") REFERENCES "public"."entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_supersedes_id_memories_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_entry_id_idx" ON "attachments" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "change_log_action_group_id_idx" ON "change_log" USING btree ("action_group_id");--> statement-breakpoint
CREATE INDEX "change_log_target_idx" ON "change_log" USING btree ("target_table","target_id");--> statement-breakpoint
CREATE INDEX "chat_messages_entry_id_idx" ON "chat_messages" USING btree ("entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_rollups_rollup_date_unique_idx" ON "daily_rollups" USING btree ("rollup_date");--> statement-breakpoint
CREATE INDEX "entries_kind_idx" ON "entries" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "entries_text_body_trgm_idx" ON "entries" USING gin ("text_body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "entries_search_vector_idx" ON "entries" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "entries_embedding_hnsw_idx" ON "entries" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "memories_topic_id_idx" ON "memories" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "memories_source_entry_id_idx" ON "memories" USING btree ("source_entry_id");--> statement-breakpoint
CREATE INDEX "memories_valid_idx" ON "memories" USING btree ("valid_to") WHERE valid_to is null;--> statement-breakpoint
CREATE INDEX "memories_content_trgm_idx" ON "memories" USING gin ("content" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "memories_search_vector_idx" ON "memories" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "memories_embedding_hnsw_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "rules_key_unique_idx" ON "rules" USING btree ("key");--> statement-breakpoint
CREATE INDEX "rules_topic_id_idx" ON "rules" USING btree ("topic_id");--> statement-breakpoint
CREATE UNIQUE INDEX "topics_name_lower_unique_idx" ON "topics" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "topics_name_trgm_idx" ON "topics" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "topics_search_vector_idx" ON "topics" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "topics_embedding_hnsw_idx" ON "topics" USING hnsw ("embedding" vector_cosine_ops);