CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"turn_id" uuid NOT NULL,
	"request_json" jsonb NOT NULL,
	"stop_reason" text,
	"usage" jsonb,
	"estimated_cost_usd" text,
	"latency_millis" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_runs_turn_id_idx" ON "agent_runs" USING btree ("turn_id");