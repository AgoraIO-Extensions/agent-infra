ALTER TABLE "platform"."conversation_generation_tombstones" DROP CONSTRAINT "conversation_generation_tombstone_principal_valid";--> statement-breakpoint
ALTER TABLE "platform"."conversation_generation_tombstones" ADD CONSTRAINT "conversation_generation_tombstone_principal_valid" CHECK (jsonb_typeof("platform"."conversation_generation_tombstones"."original_principal") = 'object'
				and coalesce(jsonb_typeof("platform"."conversation_generation_tombstones"."original_principal"->'kind') = 'string', false)
				and coalesce("platform"."conversation_generation_tombstones"."original_principal"->>'kind' in ('user', 'application'), false)
				and coalesce(jsonb_typeof("platform"."conversation_generation_tombstones"."original_principal"->'id') = 'string', false)
				and char_length(coalesce("platform"."conversation_generation_tombstones"."original_principal"->>'id', '')) > 0);