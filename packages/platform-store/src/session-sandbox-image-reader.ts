import { createHash } from "node:crypto";
import {
	parseSessionSandboxBindingV1,
	type SessionSandboxBindingV1,
	type SessionSandboxVerifiedPolicyV1,
} from "@agent-infra/platform-core";
import { platformDatabaseUrlFromEnvironment } from "./migrate.js";
import postgres from "./observed-postgres.js";

type Json = Record<string, unknown>;
type Row = {
	sandbox_id: string;
	conversation_id: string;
	agent_id: string;
	actor_id: string;
	principal_type: string;
	channel_id: string;
	session_generation: string | number;
	resource_name: string;
	workspace_scope: string;
	status: string;
	desired_state: string;
	resource_fence: string | number;
	resource_policy: unknown;
	resource_observation: unknown;
	allocation_version: string;
	conversation_matches: boolean;
	management_revision: string | number | null;
	management_fence: string | number | null;
	configuration_revision: string | number | null;
	workload_store_revision: string | number | null;
	workload_store_fence: string | number | null;
	owner_ids: string[];
	outbox_id: string | null;
	outbox_version: string | null;
	outbox_status: string | null;
	outbox_count: string | number | null;
	attempt_count: number | null;
	delivery_fence: string | number | null;
	lease_present: boolean;
	payload_schema: unknown;
	payload_conversation: unknown;
	payload_generation: unknown;
	deployment: unknown;
	model_projection: unknown;
	lifecycle_source: unknown;
};

/** Private Worker inputs. Only the resulting image-only projection may enter an operations receipt. */
export interface SessionSandboxImageProjectionInputV1 {
	readonly source: "allocation" | "retained-lifecycle";
	readonly binding: SessionSandboxBindingV1;
	readonly resourceFence: number;
	readonly policy: SessionSandboxVerifiedPolicyV1;
	readonly deployment: unknown;
	readonly modelProjection: unknown;
	readonly inputHash: string;
}

const object = (value: unknown): Json | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Json)
		: null;
const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value: unknown): value is string =>
	typeof value === "string" &&
	/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
const counter = (value: unknown) => {
	const number =
		typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
	if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)
		throw new Error();
	return number;
};

function policy(value: unknown): SessionSandboxVerifiedPolicyV1 | null {
	const p = object(value);
	if (
		!p ||
		typeof p.namespace !== "string" ||
		!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(p.namespace) ||
		typeof p.resourceConfigurationHash !== "string" ||
		!/^[a-f0-9]{64}$/.test(p.resourceConfigurationHash) ||
		typeof p.imageDigest !== "string" ||
		!/^sha256:[a-f0-9]{64}$/.test(p.imageDigest)
	)
		return null;
	try {
		return {
			namespace: p.namespace,
			resourceConfigurationHash: p.resourceConfigurationHash,
			imageDigest: p.imageDigest,
			configurationRevision: counter(p.configurationRevision),
			workloadRevision: counter(p.workloadRevision),
			managementFence: counter(p.managementFence),
		};
	} catch {
		return null;
	}
}

function resources(value: unknown) {
	const observation = object(value);
	if (!observation || !Array.isArray(observation.resources)) return null;
	return observation.resources.map((raw) => {
		const resource = object(raw);
		if (
			!resource ||
			![
				"Pod",
				"StatefulSet",
				"Service",
				"ServiceAccount",
				"PersistentVolumeClaim",
				"NetworkPolicy",
				"Secret",
			].includes(String(resource.kind)) ||
			![
				resource.namespace,
				resource.name,
				resource.uid,
				resource.resourceVersion,
			].every(text)
		)
			throw new Error();
		return {
			kind: resource.kind as string,
			namespace: resource.namespace as string,
			name: resource.name as string,
			uid: resource.uid as string,
			resourceVersion: resource.resourceVersion as string,
		};
	});
}

function projectionInput(
	source: SessionSandboxImageProjectionInputV1["source"],
	binding: SessionSandboxBindingV1,
	resourceFence: number,
	p: SessionSandboxVerifiedPolicyV1 | null,
	deployment: unknown,
	modelProjection: unknown,
): SessionSandboxImageProjectionInputV1 | null {
	const desired = object(deployment);
	if (
		!p ||
		!desired ||
		resourceFence < 1 ||
		desired.agentId !== binding.agentId ||
		desired.configRevision !== p.configurationRevision ||
		desired.workloadRevision !== p.workloadRevision ||
		desired.imageDigest !== p.imageDigest
	)
		return null;
	return {
		source,
		binding,
		resourceFence,
		policy: p,
		deployment,
		modelProjection,
		inputHash: hash([
			source,
			binding,
			resourceFence,
			p,
			deployment,
			modelProjection,
		]),
	};
}

function projectRow(row: Row, namespace: string) {
	const binding = parseSessionSandboxBindingV1({
		schemaVersion: 1,
		sandboxId: row.sandbox_id,
		sessionId: row.conversation_id,
		agentId: row.agent_id,
		principal: { kind: row.principal_type, id: row.actor_id },
		channelId: row.channel_id,
		generation: counter(row.session_generation),
		resourceName: row.resource_name,
		workspaceScope: row.workspace_scope,
	});
	const fence = counter(row.resource_fence);
	const p = policy(row.resource_policy);
	const missing: string[] = [];
	const inputs: SessionSandboxImageProjectionInputV1[] = [];
	let retainedMetadata: {
		binding: SessionSandboxBindingV1;
		resourceFence: number;
		policy: SessionSandboxVerifiedPolicyV1;
		resources: ReturnType<typeof resources>;
		observationHash: string;
	} | null = null;
	const uniqueOutbox =
		row.outbox_count !== null && counter(row.outbox_count) === 1;
	const payloadMatches =
		row.payload_schema === 1 &&
		row.payload_conversation === binding.sessionId &&
		row.payload_generation === binding.generation;
	if (!row.conversation_matches) missing.push("conversation.composite-binding");
	if (!uniqueOutbox) missing.push("sandbox-outbox.unique-scope");
	if (!p) missing.push("allocation.resource_policy");
	if (!payloadMatches)
		missing.push("sandbox-outbox.schema/conversation/generation");
	if (row.conversation_matches && payloadMatches && uniqueOutbox) {
		const current = projectionInput(
			"allocation",
			binding,
			fence,
			p,
			row.deployment,
			row.model_projection,
		);
		if (current && current.policy.namespace === namespace) inputs.push(current);
		else if (p?.namespace === namespace)
			missing.push("sandbox-outbox.deployment matched to allocation policy");
		const source = object(row.lifecycle_source);
		if (source) {
			try {
				const retainedBinding = parseSessionSandboxBindingV1(source.sandbox);
				const retainedFence = counter(source.resourceFence);
				if (
					retainedBinding.agentId !== binding.agentId ||
					retainedBinding.sessionId !== binding.sessionId ||
					retainedBinding.sandboxId !== binding.sandboxId ||
					retainedBinding.principal.kind !== binding.principal.kind ||
					retainedBinding.principal.id !== binding.principal.id ||
					retainedBinding.channelId !== binding.channelId ||
					retainedBinding.resourceName !== binding.resourceName ||
					retainedBinding.workspaceScope !== binding.workspaceScope ||
					retainedBinding.generation > binding.generation ||
					retainedFence >= fence
				)
					throw new Error();
				const retained = projectionInput(
					"retained-lifecycle",
					retainedBinding,
					retainedFence,
					policy(source.policy),
					source.deployment,
					source.modelProjection,
				);
				if (!retained) throw new Error();
				if (retained.policy.namespace === namespace) {
					inputs.push(retained);
					retainedMetadata = {
						binding: retained.binding,
						resourceFence: retained.resourceFence,
						policy: retained.policy,
						resources: resources(source.observation),
						observationHash: hash(source.observation ?? null),
					};
				}
			} catch {
				missing.push(
					"sandbox-outbox.lifecycle.source binding/policy/deployment",
				);
			}
		}
	}
	return {
		metadata: {
			binding,
			bindingKey: `session:${binding.sandboxId}`,
			bindingStatus: row.conversation_matches
				? "VERIFIED_STORE_COMPOSITE"
				: "UNKNOWN_COMPOSITE_MISMATCH",
			resourceFence: fence,
			status: row.status,
			desiredState: row.desired_state,
			allocationRowVersion: row.allocation_version,
			namespace: p?.namespace ?? null,
			policy: p,
			policyHash: hash(row.resource_policy),
			observationHash: hash(row.resource_observation),
			resources: resources(row.resource_observation),
			identityEvidence: "persisted-store-observation; live-unverified",
			retained: retainedMetadata,
			snapshotReadCas:
				row.workload_store_revision === null ||
				row.workload_store_fence === null
					? null
					: {
							workloadRevision: counter(row.workload_store_revision),
							fence: counter(row.workload_store_fence),
						},
			managementRevision:
				row.management_revision === null
					? null
					: counter(row.management_revision),
			managementFence:
				row.management_fence === null ? null : counter(row.management_fence),
			configurationRevision:
				row.configuration_revision === null
					? null
					: counter(row.configuration_revision),
			ownerIds: row.owner_ids,
			outbox: row.outbox_id
				? {
						id: row.outbox_id,
						rowVersion: row.outbox_version,
						status: row.outbox_status,
						scopeCount:
							row.outbox_count === null ? null : counter(row.outbox_count),
						attemptCount: row.attempt_count,
						deliveryFence:
							row.delivery_fence === null ? null : counter(row.delivery_fence),
						leasePresent: row.lease_present,
					}
				: null,
			inputStatus: missing.length
				? "UNKNOWN_MISSING_TRUSTED_FIELD"
				: "STORED_INPUTS_BOUND",
			missing,
			projectionInputs: inputs.map((input) => ({
				source: input.source,
				inputHash: input.inputHash,
				generation: input.binding.generation,
				resourceFence: input.resourceFence,
				policyHash: hash(input.policy),
			})),
			casHash: hash([
				binding,
				fence,
				row.allocation_version,
				row.outbox_version,
				row.outbox_count,
				row.resource_policy,
				row.resource_observation,
				row.management_revision,
				row.management_fence,
				row.configuration_revision,
				row.lifecycle_source,
				row.workload_store_revision,
				row.workload_store_fence,
				row.owner_ids,
			]),
		},
		// Functions do not serialize: a metadata receipt cannot accidentally copy private Desired/env.
		workerProjectionInputs: () => inputs,
	};
}

/** All current/retained allocations in one bounded read-only MVCC snapshot, across principals/channels. */
export function openPostgresSessionSandboxImageReaderV1(options: {
	readonly databaseUrl: string;
}) {
	const client = postgres(
		platformDatabaseUrlFromEnvironment({
			PLATFORM_DATABASE_URL: options.databaseUrl,
		}),
		{ max: 1, connect_timeout: 5 },
	);
	return {
		async read(namespace: string) {
			try {
				if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(namespace))
					throw new Error();
				return await client.begin(
					"isolation level repeatable read read only",
					async (tx) => {
						await tx`set local statement_timeout = '5000ms'`;
						const [snapshot] = await tx<
							{ observed_at: string; snapshot: string }[]
						>`select clock_timestamp()::text as observed_at, pg_current_snapshot()::text as snapshot`;
						if (!snapshot) throw new Error();
						const items = [];
						const seen = new Set<string>();
						const deadline = Date.now() + 30_000;
						let after: string | null = null;
						let pageCount = 0;
						while (++pageCount <= 100 && Date.now() <= deadline) {
							const rows: Row[] = await tx<Row[]>`
							select a.sandbox_id, a.conversation_id, a.agent_id, a.actor_id, a.principal_type, a.channel_id,
							 a.session_generation, a.resource_name, a.workspace_scope, a.status, a.desired_state, a.resource_fence,
							 a.resource_policy, a.resource_observation, a.xmin::text as allocation_version,
							 (c.id is not null) as conversation_matches, m.management_revision, m.fence as management_fence,
							 g.current_configuration_revision as configuration_revision,
							 w.revision as workload_store_revision, w.state->>'fence' as workload_store_fence,
							 array(select owner_id from platform.agent_owners where agent_id = a.agent_id order by owner_id) as owner_ids,
							 o.id as outbox_id, o.row_version as outbox_version, o.status as outbox_status, o.attempt_count, o.scope_count as outbox_count,
							 o.delivery_fence, (o.lease_owner is not null or o.lease_expires_at is not null) as lease_present,
							 o.payload->'schemaVersion' as payload_schema, o.payload->'conversationId' as payload_conversation,
							 o.payload->'sessionGeneration' as payload_generation,
							 o.payload->'deployment' as deployment, o.payload->'modelProjection' as model_projection,
							 o.payload#>'{lifecycle,source}' as lifecycle_source
							from platform.session_sandbox_allocations a
							left join platform.conversations c on c.id = a.conversation_id and c.agent_id = a.agent_id
							 and c.actor_id = a.actor_id and c.principal_type = a.principal_type and c.channel_id = a.channel_id
							left join platform.agent_applications m on m.agent_id = a.agent_id
							left join platform.agents g on g.id = a.agent_id
							left join platform.workload_reconciliations w on w.agent_id = a.agent_id
							left join lateral (select oi.*, oi.xmin::text as row_version, count(*) over () as scope_count
							 from platform.outbox_items oi where oi.scope_type = 'conversation' and oi.scope_id = a.conversation_id
							 and oi.operation = 'conversation.sandbox.reconcile.v1' order by oi.id limit 1) o on true
							where (${after}::text is null or a.sandbox_id > ${after}) and (
							 a.resource_policy->>'namespace' = ${namespace}
							 or o.scope_count > 1
							 or a.resource_policy->>'namespace' is null
							 or jsonb_typeof(a.resource_policy->'namespace') is distinct from 'string'
							 or not (a.resource_policy->>'namespace' ~ '^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$')
							 or o.payload#>>'{lifecycle,source,policy,namespace}' = ${namespace}
							 or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(a.resource_observation->'resources') = 'array'
							   then a.resource_observation->'resources' else '[]'::jsonb end) r where r->>'namespace' = ${namespace})
							 or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(o.payload#>'{lifecycle,source,observation,resources}') = 'array'
							   then o.payload#>'{lifecycle,source,observation,resources}' else '[]'::jsonb end) r where r->>'namespace' = ${namespace}))
							order by a.sandbox_id limit 100`;
							for (const row of rows) {
								if (
									seen.has(row.sandbox_id) ||
									(after !== null && row.sandbox_id <= after)
								)
									throw new Error();
								seen.add(row.sandbox_id);
								items.push(projectRow(row, namespace));
							}
							if (rows.length < 100)
								return {
									namespace,
									observedAtDatabase: new Date(
										snapshot.observed_at,
									).toISOString(),
									storeSnapshot: snapshot.snapshot,
									pageCount,
									enumerationComplete: true,
									scope:
										"namespace-and-unattributed-allocations; all principals/channels; no reserves or future sessions",
									emptyAfterCompleteEnumeration: items.length === 0,
									items,
								};
							after = rows.at(-1)?.sandbox_id ?? null;
						}
						throw new Error();
					},
				);
			} catch {
				throw new Error("SESSION_IMAGE_READ_FAILED");
			}
		},
		close: () => client.end({ timeout: 5 }),
	};
}
