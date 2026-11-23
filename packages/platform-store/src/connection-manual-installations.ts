import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type ApprovedConnectionConsumerTargetV1,
	resolveApprovedConnectionSystemAccessV1,
} from "@agent-infra/contracts/connection-consumer-profile";
import {
	type ConnectionConsistencyExceptionApprovalV1,
	type ConnectionInstallReadbackRequestV1,
	type ConnectionManualDynamicApprovalV1,
	type ConnectionRegistrationReceiptV1,
	type ConnectionRegistrationTemplateV1,
	ConnectionRegistrationTemplateV1Schema,
	connectionManualSupplyReferenceV1,
	type RuntimeOAuthConfigurationV1,
	RuntimeOAuthConfigurationV1Schema,
} from "@agent-infra/contracts/runtime";
import {
	connectionManualConsumerTargetV1,
	resolveConnectionManualDynamicApprovalV1,
	verifyConnectionRegistrationTemplateV1,
} from "@agent-infra/contracts/runtime/connection-install-node";
import {
	type ConnectionInstallationCommandFactV1,
	ConnectionInstallationErrorV1,
	type ConnectionManualInstallationCurrentV1,
	type ConnectionManualInstallationPreparationV1,
	type ConnectionManualInstallationSavedV1,
	isAgentAccessAllowedV1,
	isTaskAuthorizationCurrentV1,
	parseCurrentTaskUserV1,
	parseTaskAuthorizationBoundaryV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import { sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import { readAgentManagementState } from "./agent-management.js";
import { connectionCredentialAssociationUsableSqlV2 } from "./connection-manual-association-reader.js";

type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];
type Row = Record<string, unknown>;

/** Deployment-approved inputs of the manual EP-1060 route; rollout stays off without them. */
export interface ConnectionManualInstallationPolicyInputV1 {
	readonly systemAccess: unknown;
	readonly approval: unknown;
	/** Fixed EP-1060 `clientName`; Owner, user and request never choose it. */
	readonly clientName: string;
	/** §13.5.1/§13.5.6 principal mapping, readback and publication approvals. */
	readonly dynamic: unknown;
	/**
	 * §13.5.1 exception item 3: Principals already confirmed outside the
	 * exception (`principalBindingsByAgentAndPrincipal`, standard receipts'
	 * `connectionPrincipalId`). They count for the per-issuer uniqueness. The
	 * caller supplies the complete server-resolved set, `[]` only when it found
	 * none; an omitted set closes the route instead of skipping the check.
	 */
	readonly confirmedPrincipals: readonly {
		readonly issuer: string;
		readonly principalId: string;
		readonly userId: string;
	}[];
}

export type ConnectionManualInstallationPolicyV1 = {
	readonly access: Extract<
		ReturnType<typeof resolveApprovedConnectionSystemAccessV1>,
		{ status: "available" }
	>;
	readonly clientName: string;
	readonly dynamic: ConnectionManualDynamicApprovalV1 & {
		readonly principalMapping: ConnectionConsistencyExceptionApprovalV1;
	};
	readonly confirmedPrincipals: readonly {
		readonly issuer: string;
		readonly principalId: string;
		readonly userId: string;
	}[];
};

function unavailable(): never {
	throw new ConnectionInstallationErrorV1("unavailable");
}

export function captureConnectionManualInstallationPolicyV1(
	input: ConnectionManualInstallationPolicyInputV1,
): ConnectionManualInstallationPolicyV1 {
	const access = resolveApprovedConnectionSystemAccessV1(
		structuredClone(input?.systemAccess),
		structuredClone(input?.approval),
	);
	if (
		access.status !== "available" ||
		typeof input.clientName !== "string" ||
		!/^[\x20-\x7e]{1,100}$/.test(input.clientName) ||
		input.clientName.trim() !== input.clientName
	)
		unavailable();
	let dynamic: ConnectionManualDynamicApprovalV1;
	try {
		dynamic = resolveConnectionManualDynamicApprovalV1(
			structuredClone(input.dynamic),
			access,
		);
	} catch {
		unavailable();
	}
	// A mapping rule's expected Principal has no server resolver yet; until it does,
	// the mapping is missing and the dynamic route stays closed (§13.5.1).
	const mapping = dynamic.principalMapping;
	if (mapping.kind !== "consistency-exception-v1") unavailable();
	// No default: a missing set is not an empty, verified one (§13.5.1 item 3).
	const confirmedPrincipals = structuredClone(input.confirmedPrincipals);
	if (
		!Array.isArray(confirmedPrincipals) ||
		confirmedPrincipals.some(
			(entry) =>
				typeof entry?.issuer !== "string" ||
				!entry.issuer ||
				typeof entry.principalId !== "string" ||
				!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(entry.principalId) ||
				typeof entry.userId !== "string" ||
				!entry.userId,
		)
	)
		unavailable();
	return {
		access,
		clientName: input.clientName,
		dynamic: { ...dynamic, principalMapping: mapping },
		confirmedPrincipals,
	};
}

/** The exception's `notAfter` against the database clock (§13.5.1 item 8). */
export function connectionManualExceptionLiveV1(
	policy: ConnectionManualInstallationPolicyV1,
) {
	return sql`${policy.dynamic.principalMapping.notAfter}::timestamptz > clock_timestamp()`;
}

const runtimeOperations = [
	"conversation.turn.submit.v1",
	"conversation.turn.regenerate.v1",
	"conversation.turn.supplement.v1",
];

/** Association first, then authorization, installation and command. Owner writers hold the association exclusively. */
export async function lockConnectionManualAssociationForInstallationV1(
	tx: Pick<Transaction, "execute">,
	authorizationId: string,
) {
	const locked = await tx.execute(sql`
		select association.agent_id from platform.connection_manual_associations association
		join platform.connection_manual_installations installation on installation.agent_id=association.agent_id
		where installation.authorization_id=${authorizationId}
			and installation.association_revision=association.association_revision
			and installation.connection_agent_id=association.connection_agent_id
			and ${sql.raw(connectionCredentialAssociationUsableSqlV2("association"))}
		for share of association
	`);
	return locked.length === 1;
}

/**
 * Original Web user Execution facts for an Agent whose Owner manual association
 * is current (§13.5.6 Session Host 启动供应): processing V4 Execution, live
 * original outbox claim, ready Sandbox with exactly one observed Pod. No static,
 * shared or automatic Consumer is consulted.
 */
export async function readConnectionManualInstallationFactsV1(
	tx: Transaction,
	directory: TaskUserDirectoryV1,
	userId: string,
	executionId: string,
): Promise<ConnectionManualInstallationCurrentV1 | null> {
	await tx.execute(
		sql`lock table platform.platform_user_disables in share mode`,
	);
	const rows = await tx.execute(sql`
		select e.execution_id, e.conversation_id, e.agent_id, e.session_generation, e.authorization_revision,
			e.delivery_fence, c.host_session_ref, a.authorization_revision as agent_revision, t.boundary,
			s.sandbox_id, s.resource_name, s.workspace_scope, s.resource_observation, s.resource_fence,
			m.connection_agent_id, m.association_revision,
			(select array_agg(o.lease_owner) from platform.outbox_items o
				where o.scope_type='conversation' and o.scope_id=e.conversation_id
				and o.payload->>'executionId'=e.execution_id and o.status='processing'
				and o.lease_owner is not null and o.lease_expires_at > clock_timestamp()
				and o.operation in (${sql.join(
					runtimeOperations.map((operation) => sql`${operation}`),
					sql`, `,
				)})) as lease_owners
		from platform.agents a
		join platform.conversation_executions e on e.agent_id = a.id
		join platform.conversations c on c.id=e.conversation_id and c.agent_id=e.agent_id and c.actor_id=e.actor_id
			and c.principal_type=e.principal_type and c.channel_id=e.channel_id and c.session_generation=e.session_generation
		join platform.task_authorization_records t on t.execution_id=e.execution_id and t.revoked_at is null
		join platform.session_sandbox_allocations s on s.sandbox_id=e.sandbox_id and s.conversation_id=e.conversation_id
			and s.agent_id=e.agent_id and s.actor_id=e.actor_id and s.principal_type=e.principal_type
			and s.channel_id=e.channel_id and s.session_generation=e.session_generation
		join platform.connection_manual_associations m on m.agent_id=a.id
		where e.execution_id=${executionId} and e.actor_id=${userId} and e.principal_type='user' and e.channel_id='web'
			and e.status='processing' and e.runtime_submit_protocol='v4' and c.host_session_ref is not null
			and s.status='ready' and s.desired_state='running'
			and not exists(select 1 from platform.platform_user_disables where user_id=${userId})
			and not exists(select 1 from platform.conversation_stops where execution_id=e.execution_id and status='submitted')
			and not exists(select 1 from platform.conversation_generation_tombstones where execution_id=e.execution_id and status='pending')
			and ${sql.raw(connectionCredentialAssociationUsableSqlV2("m"))}
		for share of a,c,e,t,s,m
	`);
	const row = rows[0];
	if (
		rows.length !== 1 ||
		!row ||
		row.authorization_revision !== row.agent_revision ||
		row.workspace_scope !== row.sandbox_id
	)
		return null;
	const owners = row.lease_owners as unknown;
	if (
		!Array.isArray(owners) ||
		owners.length !== 1 ||
		typeof owners[0] !== "string" ||
		!owners[0]
	)
		return null;
	const observation = row.resource_observation as {
		status?: string;
		resources?: { kind: string; uid: string; name: string }[];
	} | null;
	const pods = observation?.resources?.filter((r) => r.kind === "Pod");
	const resourceFence = Number(row.resource_fence);
	const deliveryFence = Number(row.delivery_fence);
	if (
		observation?.status !== "ready" ||
		pods?.length !== 1 ||
		!pods[0]?.uid ||
		pods[0].name !== row.resource_name ||
		!Number.isSafeInteger(resourceFence) ||
		resourceFence < 1 ||
		!Number.isSafeInteger(deliveryFence) ||
		deliveryFence < 1
	)
		return null;
	const userValue = await directory.resolveUser(userId);
	if (!userValue) return null;
	const user = parseCurrentTaskUserV1(userValue);
	const agent = await readAgentManagementState(tx, row.agent_id as string);
	if (!agent) return null;
	const reference = {
		agentId: row.agent_id as string,
		conversationId: row.conversation_id as string,
		executionId: row.execution_id as string,
		sessionGeneration: Number(row.session_generation),
	};
	return {
		user,
		agent,
		boundary: parseTaskAuthorizationBoundaryV1(row.boundary),
		agentAuthorizationRevision: row.agent_revision as string,
		reference,
		preparation: {
			agentId: reference.agentId,
			sandboxId: row.sandbox_id as string,
			podUid: pods[0].uid,
			sessionGeneration: reference.sessionGeneration,
			hostRef: row.host_session_ref as string,
			resourceFence,
			resourceName: row.resource_name as string,
			association: {
				connectionAgentId: row.connection_agent_id as string,
				revision: Number(row.association_revision),
			},
		},
		claim: { owner: owners[0], fence: deliveryFence },
	};
}

/** Core requireCurrent equivalent for Worker and readback callers. */
function currentAllowed(
	current: ConnectionManualInstallationCurrentV1 | null,
	userId: string,
): current is ConnectionManualInstallationCurrentV1 {
	return (
		!!current &&
		current.user.userId === userId &&
		current.user.accountStatus === "active" &&
		current.boundary.principal.kind === "user" &&
		current.boundary.principal.id === userId &&
		current.boundary.agentId === current.reference.agentId &&
		current.agent.agentId === current.reference.agentId &&
		current.boundary.agentAuthorizationRevision ===
			current.agentAuthorizationRevision &&
		current.agent.status === "available" &&
		current.agent.desiredState === "running" &&
		isTaskAuthorizationCurrentV1({
			boundary: current.boundary,
			user: current.user,
			agent: current.agent,
		}) &&
		isAgentAccessAllowedV1(
			current.agent,
			{
				schemaVersion: 1,
				userId,
				accountStatus: current.user.accountStatus,
				organizationIds: current.user.organizationIds,
				isAdministrator: false,
			},
			"use",
		)
	);
}

function preparationFrom(
	value: unknown,
): ConnectionManualInstallationPreparationV1 {
	const p = value as ConnectionManualInstallationPreparationV1;
	if (
		!p ||
		typeof p !== "object" ||
		Object.keys(p).sort().join(",") !==
			"agentId,association,hostRef,podUid,resourceFence,resourceName,sandboxId,sessionGeneration" ||
		!p.association ||
		Object.keys(p.association).sort().join(",") !== "connectionAgentId,revision"
	)
		unavailable();
	return structuredClone(p);
}

function savedFrom(row: Row): ConnectionManualInstallationSavedV1 {
	const binding = row.binding as Record<string, unknown>;
	const principal = binding.principal as { kind: "user"; id: string };
	const reference =
		binding.reference as ConnectionManualInstallationSavedV1["reference"];
	return {
		schemaVersion: 1,
		authorizationId: row.id as string,
		confirmationRevision: row.confirmation_revision as string,
		principal: { kind: "user", id: principal.id },
		reference: structuredClone(reference),
		preparation: preparationFrom(row.preparation),
		status: row.status as ConnectionManualInstallationSavedV1["status"],
		expiresAt: new Date(row.expires_at as string).getTime(),
		identityRevision: row.identity_revision as string,
		agentAuthorizationRevision: row.agent_authorization_revision as string,
		registrationState:
			row.registration_state as ConnectionManualInstallationSavedV1["registrationState"],
	};
}

export async function createConnectionManualInstallationV1(
	tx: Transaction,
	policy: ConnectionManualInstallationPolicyV1,
	record: ConnectionManualInstallationSavedV1,
	command: ConnectionInstallationCommandFactV1,
	key: string,
) {
	if (
		record.status !== "preparing" ||
		record.registrationState !== "pending" ||
		command.command !== "prepare" ||
		command.status !== "pending" ||
		command.authorizationId !== record.authorizationId
	)
		unavailable();
	// After `notAfter` the exception accepts no new installation (§13.5.1 item 8).
	const [exception] = await tx.execute(
		sql`select ${connectionManualExceptionLiveV1(policy)} as live`,
	);
	if (exception?.live !== true)
		throw new ConnectionInstallationErrorV1("denied");
	const preparation = preparationFrom(record.preparation);
	const binding = { principal: record.principal, reference: record.reference };
	await tx.execute(sql`
		insert into platform.connection_installation_authorizations
			(id, execution_id, user_id, confirmation_revision, binding, identity_revision,
			 agent_authorization_revision, status, expires_at)
		values (${record.authorizationId}, ${record.reference.executionId}, ${record.principal.id},
			${record.confirmationRevision}, ${JSON.stringify(binding)}::jsonb, ${record.identityRevision},
			${record.agentAuthorizationRevision}, 'preparing', ${new Date(record.expiresAt).toISOString()}::timestamptz)
	`);
	await tx.execute(sql`
		insert into platform.connection_manual_installations
			(authorization_id, agent_id, user_id, execution_id, association_revision, connection_agent_id, preparation)
		values (${record.authorizationId}, ${record.reference.agentId}, ${record.principal.id},
			${record.reference.executionId}, ${preparation.association.revision},
			${preparation.association.connectionAgentId}, ${JSON.stringify(preparation)}::jsonb)
	`);
	await tx.execute(sql`
		insert into platform.connection_installation_commands
			(id, authorization_id, command, idempotency_key, request_digest, status, created_at, updated_at)
		values (${command.commandId}, ${command.authorizationId}, 'prepare', ${key}, ${command.requestDigest},
			'pending', ${new Date(command.createdAt).toISOString()}::timestamptz, ${new Date(command.updatedAt).toISOString()}::timestamptz)
	`);
}

export async function readConnectionManualInstallationV1(
	tx: Transaction,
	userId: string,
	authorizationId: string,
): Promise<ConnectionManualInstallationSavedV1 | null> {
	if (
		!(await lockConnectionManualAssociationForInstallationV1(
			tx,
			authorizationId,
		))
	)
		return null;
	const rows = await tx.execute(sql`
		select a.id, a.confirmation_revision, a.binding, a.status, a.expires_at, a.identity_revision,
			a.agent_authorization_revision,
			case when m.supply_state = 'unknown' and m.registration_state = 'pending' then 'unknown'
				else m.registration_state end as registration_state, m.preparation
		from platform.connection_installation_authorizations a
		join platform.connection_manual_installations m on m.authorization_id = a.id
		where a.id = ${authorizationId} and a.user_id = ${userId} and m.user_id = ${userId}
		for update of a, m
	`);
	const row = rows[0];
	return row ? savedFrom(row) : null;
}

export async function receiptConnectionManualInstallationV1(
	tx: Transaction,
	userId: string,
	key: string,
	command: string,
	digest: string,
): Promise<ConnectionManualInstallationSavedV1 | null> {
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["connection_installation", userId, command, key])},0))`,
	);
	const rows = await tx.execute(
		sql`select request_digest, result from platform.idempotency_records where scope_type='connection_installation' and scope_id=${userId} and actor_id=${userId} and command_type=${command} and idempotency_key=${key}`,
	);
	const row = rows[0];
	if (!row) return null;
	if (row.request_digest !== digest)
		throw new ConnectionInstallationErrorV1("conflict");
	const value = row.result as { authorizationId?: unknown };
	if (typeof value?.authorizationId !== "string") unavailable();
	const saved = await readConnectionManualInstallationV1(
		tx,
		userId,
		value.authorizationId,
	);
	if (!saved) unavailable();
	return saved;
}

/**
 * Original user's explicit read-only verification (§13.5.6/§13.5.7): one signed
 * `status` for an unknown registration under the same claim, or one
 * `begin_status` for a first begin whose result is unknown. Never a POST replay.
 */
/**
 * §13.5.6 dynamic manual confirm: the original user's explicit confirmation and
 * its single logical confirm command, in one CAS on the original installation.
 * The callback of the first begin must have been consumed, the association,
 * descriptor and receipt still hold, nothing else is in flight, and the
 * authorization and exception deadlines hold on the database clock.
 */
export async function confirmConnectionManualInstallationV1(
	tx: Transaction,
	policy: ConnectionManualInstallationPolicyV1,
	input: {
		readonly userId: string;
		readonly authorizationId: string;
		readonly confirmationRevision: string;
		readonly command: ConnectionInstallationCommandFactV1;
		readonly key: string;
	},
): Promise<boolean> {
	if (
		input.command.command !== "confirm" ||
		input.command.status !== "pending" ||
		input.command.authorizationId !== input.authorizationId
	)
		unavailable();
	if (
		!(await lockConnectionManualAssociationForInstallationV1(
			tx,
			input.authorizationId,
		))
	)
		return false;
	const confirmed = await tx.execute(sql`
		update platform.connection_installation_authorizations a
		set status='confirmed', revision=a.revision+1, updated_at=clock_timestamp()
		from platform.connection_manual_installations m
		where a.id=${input.authorizationId} and m.authorization_id=a.id
			and a.user_id=${input.userId} and m.user_id=${input.userId}
			and a.status='awaiting_confirmation' and a.confirmation_revision=${input.confirmationRevision}
			and a.expires_at > clock_timestamp() and ${connectionManualExceptionLiveV1(policy)}
			and a.binding->'callback'->>'status'='delivered'
			and m.registration_state='registered' and m.supply_state='confirmed'
			and m.revoke_state='not_required' and m.descriptor_digest is not null
			and not exists (select 1 from platform.connection_installation_commands c
				where c.authorization_id=a.id
					and (c.command='confirm' or c.status in ('pending','sending','unknown')))
		returning a.id
	`);
	if (confirmed.length !== 1) return false;
	await tx.execute(sql`
		insert into platform.connection_installation_commands
			(id, authorization_id, command, idempotency_key, request_digest, status)
		values (${input.command.commandId}, ${input.authorizationId}, 'confirm', ${input.key},
			${input.command.requestDigest}, 'pending')
	`);
	return true;
}

export async function requestConnectionManualInstallationStatusV1(
	tx: Transaction,
	userId: string,
	authorizationId: string,
) {
	if (
		!(await lockConnectionManualAssociationForInstallationV1(
			tx,
			authorizationId,
		))
	)
		return;
	const rows = await tx.execute(sql`
		select a.id, a.status, a.binding, a.execution_id, m.registration_state, m.supply_state
		from platform.connection_installation_authorizations a
		join platform.connection_manual_installations m on m.authorization_id = a.id
		where a.id = ${authorizationId} and a.user_id = ${userId} and a.expires_at > clock_timestamp()
		for update of a, m
	`);
	const row = rows[0];
	if (!row) return;
	const open = await tx.execute(sql`
		select command, status from platform.connection_installation_commands
		where authorization_id = ${authorizationId}
	`);
	const unresolved = (command: string) =>
		open.some(
			(entry) =>
				entry.command === command &&
				(entry.status === "pending" || entry.status === "sending"),
		);
	let command: "status" | "begin_status" | undefined;
	if (
		row.status === "preparing" &&
		((row.registration_state === "unknown" &&
			row.supply_state === "confirmed") ||
			(row.registration_state === "pending" &&
				row.supply_state === "unknown")) &&
		!unresolved("status") &&
		!unresolved("prepare")
	)
		command = "status";
	const binding = row.binding as { callback?: unknown };
	if (
		(row.status === "awaiting_confirmation" || row.status === "confirmed") &&
		row.registration_state === "registered" &&
		binding.callback === undefined &&
		open.some(
			(entry) => entry.command === "begin" && entry.status === "unknown",
		) &&
		!unresolved("begin_status")
	)
		command = "begin_status";
	if (!command) return;
	const now = Date.now();
	await tx.execute(sql`
		insert into platform.connection_installation_commands
			(id, authorization_id, command, idempotency_key, request_digest, status)
		values (${randomUUID()}, ${authorizationId}, ${command}, ${`manual-${command}:${randomUUID()}`},
			${createHash("sha256")
				.update(
					JSON.stringify([command, row.execution_id, authorizationId, now]),
				)
				.digest("hex")},
			'pending')
	`);
}

/**
 * Per-install bound configuration for a confirmed receipt CAS, reselected from
 * the original installation record and the still-current Owner association.
 */
export async function readConnectionManualInstallationBindingV1(
	tx: Transaction,
	policy: ConnectionManualInstallationPolicyV1,
	input: {
		readonly authorizationId: string;
		readonly userId: string;
		readonly agentId: string;
		readonly executionId: string;
		readonly sandboxId: string;
		readonly podUid: string;
		readonly sessionGeneration: number;
	},
): Promise<{
	readonly configuration: RuntimeOAuthConfigurationV1;
	readonly target: ApprovedConnectionConsumerTargetV1;
} | null> {
	if (
		!(await lockConnectionManualAssociationForInstallationV1(
			tx,
			input.authorizationId,
		))
	)
		return null;
	const rows = await tx.execute(sql`
		select m.template, m.configuration, m.registration_state, m.supply_state,
			m.association_revision, m.connection_agent_id,
			current.association_revision as current_revision, current.connection_agent_id as current_agent
		from platform.connection_manual_installations m
		join platform.connection_manual_associations current on current.agent_id = m.agent_id
		where m.authorization_id = ${input.authorizationId} and m.user_id = ${input.userId}
			and m.agent_id = ${input.agentId} and m.execution_id = ${input.executionId}
		for share of m
	`);
	const row = rows[0];
	if (
		row?.registration_state !== "registered" ||
		row.supply_state !== "confirmed" ||
		row.configuration === null ||
		String(row.association_revision) !== String(row.current_revision) ||
		row.connection_agent_id !== row.current_agent
	)
		return null;
	try {
		const template = ConnectionRegistrationTemplateV1Schema.parse(row.template);
		const configuration = RuntimeOAuthConfigurationV1Schema.parse(
			row.configuration,
		);
		const target = connectionManualConsumerTargetV1(policy.access, {
			agentId: input.agentId,
			connectionAgentId: template.association.connectionAgentId,
			associationRevision: template.association.revision,
		});
		if (
			template.target.sandboxId !== input.sandboxId ||
			template.target.podUid !== input.podUid ||
			template.target.sessionGeneration !== input.sessionGeneration ||
			configuration.configFingerprint !== target.configFingerprint ||
			!isDeepStrictEqual(configuration.source, target.source) ||
			configuration.resource !== target.url ||
			configuration.runtimeOrigin !== template.target.runtimeOrigin
		)
			return null;
		return { configuration, target };
	} catch {
		return null;
	}
}

/** Owner replacement or disconnect closes every installation of the retired revision. */
export async function fenceRetiredConnectionManualInstallationsV1(
	tx: Pick<Transaction, "execute">,
	agentId: string,
	associationRevision: number,
) {
	// The retired credential ciphertext is deleted in the same transaction, so no
	// approved authentication remains for a per-install DELETE: an install whose
	// registration may exist is kept closed with its original key as unknown.
	await tx.execute(sql`
		update platform.connection_installation_authorizations a
		set status = 'revoked', revision = a.revision + 1, updated_at = clock_timestamp()
		from platform.connection_manual_installations m
		where m.authorization_id = a.id and m.agent_id = ${agentId}
			and m.association_revision = ${associationRevision}
			and a.status in ('preparing','awaiting_confirmation','confirmed')
	`);
	await tx.execute(sql`
		update platform.connection_manual_installations
		set supply_state = case when template is null then 'pending' else 'closed' end,
			registration_state = case when registration_state in ('pending') then 'closed' else registration_state end,
			revoke_state = case
				when revoke_state in ('pending','sending')
					or (revoke_state = 'not_required' and registration_state in ('sending','unknown','registered'))
					then 'unknown'
				else revoke_state end,
			revision = revision + 1, updated_at = clock_timestamp()
		where agent_id = ${agentId} and association_revision = ${associationRevision}
	`);
	await tx.execute(sql`
		update platform.connection_installation_commands c
		set status='unknown', updated_at=clock_timestamp()
		from platform.connection_manual_installations m
		where c.authorization_id=m.authorization_id and m.agent_id=${agentId}
			and m.association_revision=${associationRevision} and m.revoke_state='unknown'
			and c.command='revoke' and c.status in ('pending','sending')
	`);
}

export interface ConnectionManualInstallationClaimV1 {
	readonly command: {
		readonly commandId: string;
		readonly command:
			| "prepare"
			| "status"
			| "revoke"
			| "begin"
			| "begin_status"
			| "confirm";
		readonly attemptId: string;
		readonly attemptOwner: string;
	};
	readonly authorization: {
		readonly authorizationId: string;
		readonly confirmationRevision: string;
		readonly principal: { readonly kind: "user"; readonly id: string };
		readonly reference: ConnectionManualInstallationSavedV1["reference"];
		readonly expiresAt: number;
	};
	readonly current: ConnectionManualInstallationCurrentV1;
	readonly installation: {
		readonly template?: ConnectionRegistrationTemplateV1;
		readonly registrationKey?: string;
		readonly supplyAttemptId?: string;
		readonly supplyState: string;
		readonly registrationState: string;
		readonly receipt?: ConnectionRegistrationReceiptV1;
		readonly configuration?: RuntimeOAuthConfigurationV1;
		readonly revokeState: string;
	};
}

export interface ConnectionManualInstallationReadbackFactsV1 {
	readonly request: ConnectionInstallReadbackRequestV1;
}

/** Shared deep check of a Worker-fixed template against current Store facts. */
export function manualTemplateMatchesCurrentV1(
	policy: ConnectionManualInstallationPolicyV1,
	template: ConnectionRegistrationTemplateV1,
	authorization: ConnectionManualInstallationClaimV1["authorization"],
	current: ConnectionManualInstallationCurrentV1,
	registrationKeyHash: string,
): boolean {
	try {
		verifyConnectionRegistrationTemplateV1(
			template,
			policy.access,
			policy.clientName,
		);
	} catch {
		return false;
	}
	const origin = new URL(template.target.runtimeOrigin);
	const supply = connectionManualSupplyReferenceV1({
		agentId: current.reference.agentId,
		associationRevision: current.preparation.association.revision,
	});
	return (
		isDeepStrictEqual(template.principal, authorization.principal) &&
		isDeepStrictEqual(template.reference, authorization.reference) &&
		isDeepStrictEqual(template.reference, current.reference) &&
		template.authorizationId === authorization.authorizationId &&
		template.confirmationRevision === authorization.confirmationRevision &&
		template.association.connectionAgentId ===
			current.preparation.association.connectionAgentId &&
		template.association.revision ===
			current.preparation.association.revision &&
		template.claim.owner === current.claim.owner &&
		template.claim.fence === current.claim.fence &&
		template.target.hostRef === current.preparation.hostRef &&
		template.target.sandboxId === current.preparation.sandboxId &&
		template.target.podUid === current.preparation.podUid &&
		template.target.sessionGeneration ===
			current.preparation.sessionGeneration &&
		template.target.resourceFence === current.preparation.resourceFence &&
		origin.hostname.startsWith(`${current.preparation.resourceName}.`) &&
		origin.hostname.endsWith(".svc") &&
		template.registration.registrationKeyHash === registrationKeyHash &&
		isDeepStrictEqual(template.supply, supply)
	);
}

export { currentAllowed as connectionManualCurrentAllowedV1 };
