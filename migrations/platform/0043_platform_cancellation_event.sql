ALTER TABLE "platform"."conversation_events" DROP CONSTRAINT "conversation_event_source_binding";--> statement-breakpoint
ALTER TABLE "platform"."conversation_events" ADD CONSTRAINT "conversation_event_source_binding" CHECK ((
					"platform"."conversation_events"."source" = 'runtime'
					AND "platform"."conversation_events"."runtime_cursor" IS NOT NULL
					AND char_length("platform"."conversation_events"."runtime_cursor") > 0
					AND "platform"."conversation_events"."event_type" not in ('model.selection.fell_back', 'task.status')
				) OR (
					"platform"."conversation_events"."source" = 'platform'
					AND "platform"."conversation_events"."runtime_cursor" IS NULL
					AND (
						"platform"."conversation_events"."event_type" in ('model.selection.fell_back', 'task.status')
						OR (
							"platform"."conversation_events"."event_type" = 'execution.status'
							AND "platform"."conversation_events"."event_payload"->>'status' = 'cancelled'
						)
					)
				));