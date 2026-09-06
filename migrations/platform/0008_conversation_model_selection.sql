ALTER TABLE "platform"."conversation_audit_events" ALTER COLUMN "execution_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."conversation_audit_events" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "model_configuration_revision" bigint;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "model_option_id" text;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "reasoning_level" text;--> statement-breakpoint
ALTER TABLE "platform"."conversations" ADD COLUMN "selected_model_option_id" text;--> statement-breakpoint
ALTER TABLE "platform"."conversations" ADD COLUMN "selected_reasoning_level" text;--> statement-breakpoint
ALTER TABLE "platform"."conversation_audit_events" ADD CONSTRAINT "conversation_audit_execution_binding" CHECK ((
				"platform"."conversation_audit_events"."execution_id" IS NULL
				AND "platform"."conversation_audit_events"."action" in (
					'conversation.model_selection.updated',
					'conversation.model_selection.fell_back'
				)
			) OR (
				"platform"."conversation_audit_events"."execution_id" IS NOT NULL
				AND "platform"."conversation_audit_events"."action" not in (
					'conversation.model_selection.updated',
					'conversation.model_selection.fell_back'
				)
			));--> statement-breakpoint
ALTER TABLE "platform"."conversation_audit_events" ADD CONSTRAINT "conversation_audit_details_binding" CHECK ((
				"platform"."conversation_audit_events"."action" in (
					'conversation.model_selection.updated',
					'conversation.model_selection.fell_back'
				)
			) = ("platform"."conversation_audit_events"."details" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD CONSTRAINT "conversation_execution_model_selection" CHECK ((
				"platform"."conversation_executions"."model_configuration_revision" IS NULL
				AND "platform"."conversation_executions"."model_option_id" IS NULL
				AND "platform"."conversation_executions"."reasoning_level" IS NULL
			) OR (
				"platform"."conversation_executions"."model_configuration_revision" IS NOT NULL
				AND "platform"."conversation_executions"."model_option_id" IS NOT NULL
				AND "platform"."conversation_executions"."reasoning_level" IS NOT NULL
				AND "platform"."conversation_executions"."model_configuration_revision" between 1 and 9007199254740991
				AND char_length("platform"."conversation_executions"."model_option_id") > 0
				AND char_length("platform"."conversation_executions"."reasoning_level") > 0
			));--> statement-breakpoint
ALTER TABLE "platform"."conversations" ADD CONSTRAINT "conversation_model_selection_pair" CHECK (("platform"."conversations"."selected_model_option_id" IS NULL AND "platform"."conversations"."selected_reasoning_level" IS NULL)
				OR ("platform"."conversations"."selected_model_option_id" IS NOT NULL
					AND "platform"."conversations"."selected_reasoning_level" IS NOT NULL
					AND char_length("platform"."conversations"."selected_model_option_id") > 0
					AND char_length("platform"."conversations"."selected_reasoning_level") > 0));