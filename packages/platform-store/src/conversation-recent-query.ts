import {
	parseCurrentTaskUserV1,
	type RecentPersonalConversationRecordV1,
	RecentPersonalConversationsError,
	type RecentPersonalConversationsQueryV1,
} from "@agent-infra/platform-core";
import type postgres from "postgres";
import type { ConversationQueryProjectionV1 } from "./conversation-query.js";
import { decodePersistedWorkloadStateV1 } from "./workload-reconciliation.js";

interface Row {
	readonly sandbox_ready: boolean | null;
	readonly sandbox_id: string;
	readonly resource_name: string;
	readonly workspace_scope: string;
	readonly principal_type: string;
	readonly session_generation: number | string;
	readonly id: string;
	readonly agent_id: string;
	readonly actor_id: string;
	readonly channel_id: string;
	readonly status: "ready" | "active" | "unavailable";
	readonly selected_model_option_id: string | null;
	readonly selected_reasoning_level: string | null;
	readonly last_conversation_cursor: string | number;
	readonly created_at: Date;
	readonly updated_at: Date;
	readonly exact_updated_at: string;
	readonly configuration_revision: string;
	readonly workload: unknown;
	readonly management: RecentPersonalConversationRecordV1["agent"];
	readonly channel_unavailable: boolean;
}

/** One statement binds current grants, channel facts and global keyset ordering. */
export async function readRecentPersonalConversations(
	client: postgres.Sql,
	input: RecentPersonalConversationsQueryV1,
	project: (row: Row) => ConversationQueryProjectionV1,
): Promise<readonly RecentPersonalConversationRecordV1[]> {
	try {
		const user = parseCurrentTaskUserV1(input.user);
		if (user.accountStatus !== "active")
			throw new RecentPersonalConversationsError("revoked");
		if (
			!Number.isSafeInteger(input.limit) ||
			input.limit < 1 ||
			input.limit > 101
		)
			throw new RecentPersonalConversationsError("unavailable");
		// Bind timestamp text so postgres.js does not truncate microseconds via Date.
		const rows = await client.unsafe<Row[]>(
			`with current_agents as (
				select a.current_configuration_revision,
					ap.*, w.state as workload,
					case
						when w.state is null
							or w.state->>'agentId' is distinct from a.id
							or w.state->'sourceConfigurationRevision' is distinct from to_jsonb(a.current_configuration_revision)
							or w.state#>>'{candidate,configuration,agentId}' is distinct from a.id
							or w.state#>'{candidate,configuration,revision}' is distinct from to_jsonb(a.current_configuration_revision)
							or jsonb_typeof(w.state->'fence') is distinct from 'number'
							or w.state->'fence' < '1'::jsonb
							or cfg.agent_id is null
						then 'unknown'
						when w.state#>>'{candidate,configuration,source,kind}' = 'standard' then 'included'
						when w.state#>>'{candidate,configuration,source,kind}' = 'custom'
							and w.state#>>'{candidate,configuration,source,interactionMode}' = 'self-managed' then 'excluded'
						when w.state#>>'{candidate,configuration,source,kind}' = 'custom'
							and w.state#>>'{verified,configuration,agentId}' = a.id
							and jsonb_typeof(w.state#>'{verified,configuration,revision}') = 'number'
							and w.state#>'{verified,configuration,revision}' between '1'::jsonb and to_jsonb(a.current_configuration_revision)
							and w.state#>>'{verified,configuration,source,kind}' = 'custom'
							and w.state#>>'{verified,configuration,source,interactionMode}' = 'platform-adapter'
							and jsonb_typeof(w.state->'capabilities') = 'object' then 'included'
						else 'unknown'
					end as channel_state
				from platform.agents a
				join platform.agent_applications ap on ap.agent_id = a.id
				left join platform.workload_reconciliations w on w.agent_id = a.id
				left join platform.agent_configuration_revisions cfg
					on cfg.agent_id = a.id and cfg.revision = a.current_configuration_revision
				where ap.status in ('creating', 'available', 'stopped', 'creation_failed', 'disabled')
					and (
						exists (select 1 from platform.agent_owners o where o.agent_id = a.id and o.owner_id = $1)
						or exists (select 1 from platform.agent_availability av
							where av.agent_id = a.id and (
								(av.target_type = 'user' and av.target_id = $1)
								or (av.target_type = 'organization' and av.target_id = any($2::text[]))
							))
					)
			), channel_guard as (
				select exists (
					select 1 from platform.conversations c
					join current_agents a on a.agent_id = c.agent_id
					where c.actor_id = $1 and c.channel_id = 'web' and a.channel_state = 'unknown'
						and ($3::text::timestamptz is null or (c.updated_at, c.id) < ($3::text::timestamptz, $4::text))
				) as channel_unavailable
			)
			select page.*, guard.channel_unavailable
			from channel_guard guard
			left join lateral (
				select c.id, c.agent_id, c.actor_id, c.channel_id, c.status,
					c.principal_type, c.session_generation,
					s.sandbox_id, s.resource_name, s.workspace_scope,
					s.status = 'ready' and s.desired_state = 'running' and s.resource_fence > 0
						and s.resource_observation->>'status' = 'ready' as sandbox_ready,
					c.selected_model_option_id, c.selected_reasoning_level,
					c.last_conversation_cursor, c.created_at, c.updated_at,
					to_char(c.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as exact_updated_at,
					a.current_configuration_revision::text as configuration_revision, a.workload,
					jsonb_build_object(
						'schemaVersion', 1, 'applicationId', a.id, 'agentId', c.agent_id,
						'applicantId', a.applicant_id, 'status', a.status, 'revision', a.management_revision,
						'approvalRevision', a.approval_revision, 'decisionReason', a.decision_reason,
						'serviceAvailability', a.service_availability, 'desiredState', a.desired_state,
						'workloadRevision', a.workload_revision, 'fence', a.fence, 'failureCode', a.failure_code,
						'ownerIds', coalesce((select jsonb_agg(o.owner_id order by o.owner_id)
							from platform.agent_owners o where o.agent_id = c.agent_id), '[]'::jsonb),
						'availability', coalesce((select jsonb_agg(case when av.target_type = 'user'
							then jsonb_build_object('kind', 'user', 'userId', av.target_id)
							else jsonb_build_object('kind', 'organization', 'organizationId', av.target_id) end
							order by av.target_type, av.target_id)
							from platform.agent_availability av where av.agent_id = c.agent_id), '[]'::jsonb)
					) as management
				from platform.conversations c
				join platform.session_sandbox_allocations s
					on s.conversation_id = c.id and s.agent_id = c.agent_id
					and s.actor_id = c.actor_id and s.principal_type = c.principal_type
					and s.channel_id = c.channel_id and s.session_generation = c.session_generation
				join current_agents a on a.agent_id = c.agent_id and a.channel_state = 'included'
				where not guard.channel_unavailable and c.actor_id = $1 and c.channel_id = 'web'
					and not exists (select 1 from platform.conversation_executions e
						where e.conversation_id = c.id and e.sandbox_id is distinct from s.sandbox_id)
					and ($3::text::timestamptz is null or (c.updated_at, c.id) < ($3::text::timestamptz, $4::text))
				order by c.updated_at desc, c.id desc
				limit $5
			) page on true
			order by page.updated_at desc, page.id desc`,
			[
				user.userId,
				// Bind text[] explicitly before a cold client's type discovery completes.
				client.array([...user.organizationIds], 1009),
				input.after?.updatedAt ?? null,
				input.after?.conversationId ?? null,
				input.limit,
			],
		);
		if (rows.some((row) => row.channel_unavailable))
			throw new RecentPersonalConversationsError("unavailable");
		return rows
			.filter((row) => row.id !== null)
			.map((row) => {
				const workload = decodePersistedWorkloadStateV1(
					row.workload,
					row.agent_id,
				);
				const revision = Number(row.configuration_revision);
				if (
					!workload ||
					workload.legacy ||
					!Number.isSafeInteger(revision) ||
					revision < 1
				)
					throw new RecentPersonalConversationsError("unavailable");
				return {
					projection: {
						...project(row),
						selectedModelOptionId: row.selected_model_option_id,
						selectedReasoningLevel: row.selected_reasoning_level,
					},
					actorId: row.actor_id,
					channelId: row.channel_id,
					position: { updatedAt: row.exact_updated_at, conversationId: row.id },
					agent: row.management,
					channel: {
						boundary: { agentId: row.agent_id, channelId: row.channel_id },
						configurationRevision: revision,
						workload: workload.state,
					},
				};
			});
	} catch (error) {
		if (error instanceof RecentPersonalConversationsError) throw error;
		throw new RecentPersonalConversationsError("unavailable");
	}
}
