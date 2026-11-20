CREATE TABLE "platform"."session_sandbox_executor_promotions" (
	"id" text PRIMARY KEY NOT NULL,
	"sandbox_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"session_generation" bigint NOT NULL,
	"resource_fence" bigint NOT NULL,
	"receipt" jsonb NOT NULL,
	"receipt_digest" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "session_sandbox_executor_promotion_digest" CHECK ("platform"."session_sandbox_executor_promotions"."receipt_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "platform"."session_sandbox_reserves" ADD COLUMN "executor_startup" jsonb;--> statement-breakpoint
ALTER TABLE "platform"."session_sandbox_executor_promotions" ADD CONSTRAINT "session_sandbox_executor_promotion_allocation_fk" FOREIGN KEY ("sandbox_id") REFERENCES "platform"."session_sandbox_allocations"("sandbox_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_sandbox_executor_promotion_unique" ON "platform"."session_sandbox_executor_promotions" USING btree ("sandbox_id","session_generation","resource_fence");