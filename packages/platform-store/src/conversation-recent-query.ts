import {
	type AgentManagementStateV1,
	parseCurrentTaskUserV1,
	type RecentPersonalConversationRecordV1,
	RecentPersonalConversationsError,
	type RecentPersonalConversationsQueryV1,
	type RecentPersonalConversationsReadV1,
	recentPersonalUnavailableAgentsMaximumV1,
} from "@agent-infra/platform-core";
import type postgres from "postgres";
import { agentManagementStateJsonSql } from "./agent-management-state-sql.js";
import type { ConversationQueryProjectionV1 } from "./conversation-query.js";
import { conversationSandboxReadBindingSql } from "./session-sandbox.js";
import { decodePersistedWorkloadStateV1 } from "./workload-reconciliation.js";

interface Row {
	readonly sandbox_status: string | null;
	readonly sandbox_desired_state: string | null;
	readonly sandbox_resource_fence: number | string | null;
	readonly sandbox_observation_status: string | null;
	readonly sandbox_id: string | null;
	readonly resource_name: string | null;
	readonly workspace_scope: string | null;
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
	readonly unavailable_agents: unknown;
}

/**
 * One statement binds current grants, channel facts and global keyset ordering.
 * Agents whose Web channel eligibility is unknown are omitted per Agent and
 * named instead of failing the whole page (#3379); unknown is never included.
 */
export async function readRecentPersonalConversations(
	client: postgres.Sql,
	input: RecentPersonalConversationsQueryV1,
	project: (row: Row) => ConversationQueryProjectionV1,
): Promise<RecentPersonalConversationsReadV1> {
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
		// Agents whose persisted Workload passes the SQL mirror but not the strict
		// decoder are re-read as unknown, so the page is never cut after its limit.
		const demoted: string[] = [];
		for (;;) {
			const rows = await readPage(client, user, input, demoted);
			const failed = new Set<string>();
			const records: RecentPersonalConversationRecordV1[] = [];
			for (const row of rows) {
				if (row.id === null) continue;
				const record = toRecord(row, project);
				if (record) records.push(record);
				else failed.add(row.agent_id);
			}
			if (failed.size === 0)
				return {
					records,
					unavailableAgents: unavailableAgents(rows[0]?.unavailable_agents),
				};
			for (const agentId of failed) {
				if (demoted.includes(agentId))
					throw new RecentPersonalConversationsError("unavailable");
				demoted.push(agentId);
			}
			if (demoted.length > input.limit)
				throw new RecentPersonalConversationsError("unavailable");
		}
	} catch (error) {
		if (error instanceof RecentPersonalConversationsError) throw error;
		throw new RecentPersonalConversationsError("unavailable");
	}
}

function readPage(
	client: postgres.Sql,
	user: ReturnType<typeof parseCurrentTaskUserV1>,
	input: RecentPersonalConversationsQueryV1,
	demoted: readonly string[],
) {
	// Bind timestamp text so postgres.js does not truncate microseconds via Date.
	return client.unsafe<Row[]>(
		`with current_agents as (
				-- Workload 只代表 Runtime 输入：与当前 Runtime 修订比较，只改渠道的配置修订
				-- 不会让该 Agent 的渠道状态变成 unknown（ADR-0028）。
				select a.current_configuration_revision,
					coalesce(cfg.runtime_revision, a.current_configuration_revision) as runtime_revision,
					ap.*, w.state as workload,
					case
						when a.id = any($6::text[])
							or w.state is null
							or w.state->>'agentId' is distinct from a.id
							or w.state->'sourceConfigurationRevision' is distinct from to_jsonb(coalesce(cfg.runtime_revision, a.current_configuration_revision))
							or w.state#>>'{candidate,configuration,agentId}' is distinct from a.id
							or w.state#>'{candidate,configuration,revision}' is distinct from to_jsonb(coalesce(cfg.runtime_revision, a.current_configuration_revision))
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
							and w.state#>'{verified,configuration,revision}' between '1'::jsonb and to_jsonb(coalesce(cfg.runtime_revision, a.current_configuration_revision))
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
			), unavailable as (
				-- Only granted Agents with the user's own Web rows after the position are named.
				select coalesce(jsonb_agg(omitted.management order by omitted.agent_id), '[]'::jsonb)
					as unavailable_agents
				from (
					select a.agent_id, ${agentManagementStateJsonSql("a")} as management
					from current_agents a
					where a.channel_state = 'unknown' and exists (
						select 1 from platform.conversations c
						where c.agent_id = a.agent_id and c.actor_id = $1 and c.channel_id = 'web'
							and ($3::text::timestamptz is null or (c.updated_at, c.id) < ($3::text::timestamptz, $4::text))
					)
					order by a.agent_id
					limit ${recentPersonalUnavailableAgentsMaximumV1}
				) omitted
			)
			select page.*, unavailable.unavailable_agents
			from unavailable
			left join lateral (
				select c.id, c.agent_id, c.actor_id, c.channel_id, c.status,
					c.principal_type, c.session_generation,
					s.sandbox_id, s.resource_name, s.workspace_scope,
					s.status as sandbox_status, s.desired_state as sandbox_desired_state,
                    s.resource_fence as sandbox_resource_fence, s.resource_observation->>'status' as sandbox_observation_status,
					c.selected_model_option_id, c.selected_reasoning_level,
					c.last_conversation_cursor, c.created_at, c.updated_at,
					to_char(c.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as exact_updated_at,
					a.runtime_revision::text as configuration_revision, a.workload,
					${agentManagementStateJsonSql("a")} as management
				from platform.conversations c
				left join platform.session_sandbox_allocations s on s.conversation_id = c.id
				join current_agents a on a.agent_id = c.agent_id and a.channel_state = 'included'
				where c.actor_id = $1 and c.channel_id = 'web'
					and ${conversationSandboxReadBindingSql}
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
			client.array([...demoted], 1009),
		],
	);
}

/** Null when this Agent's persisted channel facts cannot be decoded. */
function toRecord(
	row: Row,
	project: (row: Row) => ConversationQueryProjectionV1,
): RecentPersonalConversationRecordV1 | null {
	let workload: ReturnType<typeof decodePersistedWorkloadStateV1>;
	try {
		workload = decodePersistedWorkloadStateV1(row.workload, row.agent_id);
	} catch {
		return null;
	}
	const revision = Number(row.configuration_revision);
	if (
		!workload ||
		workload.legacy ||
		!Number.isSafeInteger(revision) ||
		revision < 1
	)
		return null;
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
}

function unavailableAgents(
	value: unknown,
): RecentPersonalConversationsReadV1["unavailableAgents"] {
	if (!Array.isArray(value))
		throw new RecentPersonalConversationsError("unavailable");
	// Core parses each management state and re-checks the current grant.
	return value.map((agent: AgentManagementStateV1) => ({ agent }));
}
