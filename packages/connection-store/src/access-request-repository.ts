import { randomUUID } from "node:crypto";
import {
	type AccessOption,
	type AccessRequestInput,
	type AccessRequestProjection,
	type ApprovalDecisionInput,
	type ApprovalDelegation,
	type ApprovalDelegationInput,
	type ApprovalNotifications,
	type ApprovalQueueItem,
	type ApprovalRerouteInput,
	type ConnectionAccessApprovalRepository,
	ConnectionError,
	type ConnectionWorkItem,
	canonicalHash,
	type ReapprovalCampaignInput,
} from "@agent-infra/connection-core";
import postgres, { type Sql } from "postgres";

export type ConsumeConnectPermitInput = {
	accessAuthorizationId: string;
	connectionId: string;
	grantedScopes: readonly string[];
	principalId: string;
	requestId: string;
};

export async function lookupApprovedConnectPermit(
	sql: Sql,
	principalId: string,
	requestId: string,
) {
	const [row] = await sql<
		{
			connect_expires_at: Date;
			provider_id: string;
			provider_release_id: string;
		}[]
	>`
		SELECT request.connect_expires_at, release.provider AS provider_id,
			request.provider_release_id
		FROM connection_access_requests request
		JOIN connection_provider_releases release
			ON release.id = request.provider_release_id
		JOIN connection_capability_profiles profile
			ON profile.id = request.capability_profile_id
		JOIN connection_access_policy_versions policy
			ON policy.id = request.policy_version_id
		JOIN connection_connect_permits permit
			ON permit.request_id = request.id
		WHERE request.id = ${requestId}
			AND request.applicant_principal_id = ${principalId}
			AND request.state = 'APPROVED_PENDING_CONNECTION'
			AND request.connect_expires_at > now()
			AND release.status = 'PUBLISHED'
			AND profile.status IN ('PUBLISHED', 'SUPERSEDED')
			AND policy.status IN ('PUBLISHED', 'SUPERSEDED')
			AND permit.consumed_at IS NULL AND permit.expires_at > now()
	`;
	if (!row) forbidden();
	return {
		connectExpiresAt: row.connect_expires_at.toISOString(),
		providerId: row.provider_id,
		providerReleaseId: row.provider_release_id,
		requestId,
	};
}

type PolicyRow = {
	capability_profile_id: string;
	connect_ttl_seconds: number;
	provider_release_id: string;
	renewal_lead_seconds: number;
	request_ttl_seconds: number;
};

type StageApproverRow = {
	display_snapshot: postgres.JSONValue;
	name: string;
	ordinal: number;
	policy_stage_id: string;
	principal_id: string;
	quorum_count: number | null;
	quorum_type: "ALL" | "ANY" | "AT_LEAST_N";
	timeout_seconds: number;
};

type DecisionTarget = {
	applicant_principal_id: string;
	connect_ttl_seconds: number;
	current_stage_ordinal: number;
	policy_stage_id: string;
	quorum_count: number | null;
	quorum_type: "ALL" | "ANY" | "AT_LEAST_N";
	request_revision: string;
	request_stage_id: string;
	routing_revision: string;
	stage_revision: string;
};

type RequestRow = {
	capability_profile_name: string;
	connect_expires_at: Date | null;
	created_at: Date;
	current_stage_ordinal: number | null;
	duration_days: number | null;
	duration_kind: "FINITE" | "PERMANENT";
	expires_at: Date;
	id: string;
	provider_id: string;
	provider_release_id: string;
	purpose: string;
	renewal: boolean;
	revision: string;
	state: string;
};

function invalid(message: string): never {
	throw new ConnectionError("INVALID_REQUEST", message);
}

function forbidden(): never {
	throw new ConnectionError("FORBIDDEN", "Approval action is not available");
}

function exactSet(left: readonly string[], right: readonly string[]) {
	return (
		left.length === right.length &&
		[...left].sort().every((value, index) => value === [...right].sort()[index])
	);
}

function quorumSatisfied(
	type: DecisionTarget["quorum_type"],
	configuredCount: number | null,
	approvals: number,
	candidates: number,
) {
	if (type === "ANY") return approvals >= 1;
	if (type === "ALL") return approvals >= candidates;
	return configuredCount !== null && approvals >= configuredCount;
}

export class PostgresConnectionAccessRequestRepository
	implements ConnectionAccessApprovalRepository
{
	private readonly sql: Sql;

	constructor(
		databaseUrl: string,
		private readonly restoreRenewedGrants?: (
			sql: postgres.TransactionSql,
			connectionId: string,
		) => Promise<void>,
	) {
		this.sql = postgres(databaseUrl, { max: 10 });
	}

	close() {
		return this.sql.end();
	}

	async createDelegation(input: ApprovalDelegationInput) {
		const startsAt = new Date(input.startsAt);
		const endsAt = new Date(input.endsAt);
		if (
			!Number.isFinite(startsAt.getTime()) ||
			!Number.isFinite(endsAt.getTime()) ||
			startsAt >= endsAt ||
			endsAt <= new Date() ||
			input.principalId === input.delegatePrincipalId
		) {
			invalid("Approval delegation interval or participants are invalid");
		}
		return this.sql.begin(async (sql) => {
			const [admin] = await sql<{ id: string }[]>`
				SELECT principal.id FROM connection_principals principal
				JOIN connection_principal_roles role_binding ON role_binding.principal_id = principal.id
				WHERE principal.id = ${input.actorPrincipalId} AND principal.status = 'ACTIVE'
					AND role_binding.role = 'CONNECTION_ADMIN' AND role_binding.status = 'ACTIVE'
				FOR SHARE OF principal, role_binding
			`;
			if (!admin) forbidden();
			const participants = await sql<{ id: string }[]>`
				SELECT id FROM connection_principals
				WHERE id IN (${input.principalId}, ${input.delegatePrincipalId}) AND status = 'ACTIVE'
				ORDER BY id FOR UPDATE
			`;
			if (participants.length !== 2)
				invalid("Approval delegation participants must be active");
			const [overlap] = await sql<{ id: string }[]>`
				SELECT id FROM connection_approval_delegations
				WHERE principal_id = ${input.principalId}
					AND delegate_principal_id = ${input.delegatePrincipalId}
					AND status = 'ACTIVE'
					AND starts_at < ${endsAt} AND ends_at > ${startsAt}
				LIMIT 1
			`;
			if (overlap)
				invalid("Approval delegation interval overlaps an active delegation");
			await sql`
				INSERT INTO connection_approval_delegations (
					id, principal_id, delegate_principal_id, starts_at, ends_at,
					status, created_by_principal_id
				) VALUES (
					${input.id}, ${input.principalId}, ${input.delegatePrincipalId},
					${startsAt}, ${endsAt}, 'ACTIVE', ${input.actorPrincipalId}
				)
			`;
			await auditAndEnqueue(sql, {
				actorPrincipalId: input.actorPrincipalId,
				aggregateId: input.id,
				event: "connection.approval-delegation.created",
			});
			return { delegationId: input.id };
		});
	}

	async listDelegations(
		principalId: string,
	): Promise<readonly ApprovalDelegation[]> {
		const rows = await this.sql<
			{
				delegate_name: string;
				delegate_principal_id: string;
				ends_at: Date;
				id: string;
				principal_id: string;
				principal_name: string;
				revision: string;
				starts_at: Date;
				status: "ACTIVE" | "REVOKED" | "EXPIRED";
			}[]
		>`
			SELECT delegation.id, delegation.principal_id, approver.display_name AS principal_name,
				delegation.delegate_principal_id, delegate.display_name AS delegate_name,
				delegation.starts_at, delegation.ends_at, delegation.revision::text,
				CASE WHEN delegation.status = 'ACTIVE' AND delegation.ends_at <= now()
					THEN 'EXPIRED' ELSE delegation.status END AS status
			FROM connection_approval_delegations delegation
			JOIN connection_principals approver ON approver.id = delegation.principal_id
			JOIN connection_principals delegate ON delegate.id = delegation.delegate_principal_id
			WHERE EXISTS (
				SELECT 1 FROM connection_principal_roles role_binding
				JOIN connection_principals admin ON admin.id = role_binding.principal_id
				WHERE admin.id = ${principalId} AND admin.status = 'ACTIVE'
					AND role_binding.role = 'CONNECTION_ADMIN' AND role_binding.status = 'ACTIVE'
			)
			ORDER BY delegation.created_at DESC LIMIT 100
		`;
		return rows.map((row) => ({
			delegateName: row.delegate_name,
			delegatePrincipalId: row.delegate_principal_id,
			endsAt: row.ends_at.toISOString(),
			id: row.id,
			principalId: row.principal_id,
			principalName: row.principal_name,
			revision: row.revision,
			startsAt: row.starts_at.toISOString(),
			status: row.status,
		}));
	}

	async revokeDelegation(input: {
		actorPrincipalId: string;
		delegationId: string;
		expectedRevision: string;
	}) {
		return this.sql.begin(async (sql) => {
			const [admin] = await sql<{ id: string }[]>`
				SELECT principal.id FROM connection_principals principal
				JOIN connection_principal_roles role_binding ON role_binding.principal_id = principal.id
				WHERE principal.id = ${input.actorPrincipalId} AND principal.status = 'ACTIVE'
					AND role_binding.role = 'CONNECTION_ADMIN' AND role_binding.status = 'ACTIVE'
				FOR SHARE OF principal, role_binding
			`;
			if (!admin) forbidden();
			const [delegation] = await sql<{ id: string }[]>`
				UPDATE connection_approval_delegations
				SET status = 'REVOKED', revision = revision + 1
				WHERE id = ${input.delegationId} AND status = 'ACTIVE'
					AND revision::text = ${input.expectedRevision}
				RETURNING id
			`;
			if (!delegation)
				throw new ConnectionError(
					"IDEMPOTENCY_CONFLICT",
					"Approval delegation changed",
				);
			await auditAndEnqueue(sql, {
				actorPrincipalId: input.actorPrincipalId,
				aggregateId: input.delegationId,
				event: "connection.approval-delegation.revoked",
			});
			return { delegationId: input.delegationId };
		});
	}

	async listAccessOptions(
		principalId: string,
	): Promise<readonly AccessOption[]> {
		await this.requireActivePrincipal(principalId);
		return this.sql.begin(async (sql) => {
			const policies = await sql<
				{
					capability_profile_id: string;
					capability_profile_name: string;
					effect_ceiling: "READ" | "WRITE";
					policy_version_id: string;
					provider_id: string;
					provider_release_id: string;
					required_scopes: unknown;
				}[]
			>`
			SELECT policy.id AS policy_version_id, policy.provider_release_id,
				profile.id AS capability_profile_id,
				profile.name AS capability_profile_name, profile.effect_ceiling,
				profile.required_scopes, release.provider AS provider_id
			FROM connection_access_policy_versions policy
			JOIN connection_capability_profiles profile
				ON profile.id = policy.capability_profile_id
				AND profile.provider_release_id = policy.provider_release_id
			JOIN connection_provider_releases release
				ON release.id = policy.provider_release_id
			WHERE policy.status = 'PUBLISHED'
				AND profile.status = 'PUBLISHED' AND release.status = 'PUBLISHED'
			ORDER BY release.provider, profile.name
		`;
			return Promise.all(
				policies.map(async (policy) => {
					const durations = await sql<
						{
							duration_days: number | null;
							duration_kind: "FINITE" | "PERMANENT";
						}[]
					>`
					SELECT duration_kind, duration_days
					FROM connection_access_policy_durations
					WHERE policy_version_id = ${policy.policy_version_id}
					ORDER BY duration_kind, duration_days
				`;
					const disclaimers = await sql<
						{
							content: string;
							content_sha256: string;
							id: string;
							locale: string;
						}[]
					>`
					SELECT disclaimer.id, disclaimer.content, disclaimer.content_sha256,
						disclaimer.locale
					FROM connection_access_policy_disclaimers link
					JOIN connection_disclaimer_versions disclaimer
						ON disclaimer.id = link.disclaimer_version_id
					WHERE link.policy_version_id = ${policy.policy_version_id}
						AND disclaimer.status = 'PUBLISHED'
					ORDER BY link.ordinal
				`;
					if (disclaimers.length === 0)
						invalid("Approval disclaimers are unavailable");
					const presentationId = `disclaimer-presentation-${randomUUID()}`;
					await sql`
					INSERT INTO connection_disclaimer_presentations (
						id, principal_id, policy_version_id, disclaimer_bundle_digest
					) VALUES (
						${presentationId}, ${principalId}, ${policy.policy_version_id},
						${canonicalHash(
							disclaimers.map((item) => ({
								id: item.id,
								sha256: item.content_sha256,
								locale: item.locale,
							})),
						)}
					)
				`;
					return {
						capabilityProfileId: policy.capability_profile_id,
						capabilityProfileName: policy.capability_profile_name,
						disclaimers: disclaimers.map((item) => ({
							content: item.content,
							contentSha256: item.content_sha256,
							id: item.id,
							locale: item.locale,
						})),
						durations: durations.map((duration) =>
							duration.duration_kind === "FINITE"
								? { days: duration.duration_days ?? 0, kind: "FINITE" as const }
								: { kind: "PERMANENT" as const },
						),
						effectCeiling: policy.effect_ceiling,
						policyVersionId: policy.policy_version_id,
						presentationId,
						providerId: policy.provider_id,
						providerReleaseId: policy.provider_release_id,
						requiredScopes: Array.isArray(policy.required_scopes)
							? policy.required_scopes.filter(
									(scope): scope is string => typeof scope === "string",
								)
							: [],
					};
				}),
			);
		});
	}

	prepareConnect(principalId: string, requestId: string) {
		return lookupApprovedConnectPermit(this.sql, principalId, requestId);
	}

	async listRequests(
		principalId: string,
	): Promise<readonly AccessRequestProjection[]> {
		const rows = await this.requestRowsForApplicant(principalId);
		return Promise.all(rows.map((row) => this.projectRequest(row)));
	}

	async getRequest(principalId: string, requestId: string) {
		const rows = await this.requestRowsForApplicant(principalId, requestId);
		const row = rows[0];
		if (!row) forbidden();
		return this.projectRequest(row);
	}

	async listApprovalQueue(
		principalId: string,
	): Promise<readonly ApprovalQueueItem[]> {
		const rows = await this.sql<
			(RequestRow & {
				applicant_display_name: string;
				approver_principal_id: string;
				current_request_stage_id: string;
			})[]
		>`
			SELECT request.id, request.provider_release_id, release.provider AS provider_id,
				request.purpose, request.duration_kind, request.duration_days,
				request.state, request.current_stage_ordinal,
				request.revision::text, request.expires_at, request.connect_expires_at,
				EXISTS (SELECT 1 FROM connection_authorization_renewals renewal
					WHERE renewal.request_id = request.id) AS renewal,
				request.created_at,
				profile.name AS capability_profile_name,
				applicant.display_name AS applicant_display_name,
				candidate.approver_principal_id,
				stage.id AS current_request_stage_id
			FROM connection_access_requests request
			JOIN connection_principals applicant
				ON applicant.id = request.applicant_principal_id
			JOIN connection_provider_releases release
				ON release.id = request.provider_release_id
			JOIN connection_capability_profiles profile
				ON profile.id = request.capability_profile_id
			JOIN connection_request_stages stage
				ON stage.request_id = request.id
				AND stage.ordinal = request.current_stage_ordinal
			JOIN connection_request_routing_revisions routing
				ON routing.request_stage_id = stage.id
				AND routing.revision = stage.routing_revision
			JOIN connection_request_stage_approvers candidate
				ON candidate.routing_revision_id = routing.id
			JOIN connection_principals approver
				ON approver.id = candidate.approver_principal_id
				AND approver.status = 'ACTIVE'
			WHERE request.state = 'IN_REVIEW' AND stage.state = 'PENDING'
				AND request.expires_at > now()
				AND EXISTS (
					SELECT 1 FROM connection_principals actor
					WHERE actor.id = ${principalId} AND actor.status = 'ACTIVE'
				)
				AND request.applicant_principal_id <> ${principalId}
				AND (
					candidate.approver_principal_id = ${principalId}
					OR EXISTS (
						SELECT 1 FROM connection_approval_delegations delegation
						WHERE delegation.principal_id = candidate.approver_principal_id
							AND delegation.delegate_principal_id = ${principalId}
							AND delegation.status = 'ACTIVE'
							AND delegation.starts_at <= now() AND delegation.ends_at > now()
					)
				)
				AND NOT EXISTS (
					SELECT 1 FROM connection_approval_decisions decision
					WHERE decision.request_stage_id = stage.id
						AND decision.approver_principal_id = candidate.approver_principal_id
				)
			ORDER BY request.expires_at, request.created_at
		`;
		return Promise.all(
			rows.map(async (row) => ({
				...(await this.projectRequest(row)),
				applicantDisplayName: row.applicant_display_name,
				approverPrincipalId: row.approver_principal_id,
				currentRequestStageId: row.current_request_stage_id,
			})),
		);
	}

	async listRoutingBlocked(principalId: string) {
		const rows = await this.sql<
			(RequestRow & { applicant_display_name: string })[]
		>`
			SELECT request.id, request.provider_release_id, release.provider AS provider_id,
				request.purpose, request.duration_kind, request.duration_days,
				request.state, request.current_stage_ordinal,
				request.revision::text, request.expires_at, request.connect_expires_at,
				EXISTS (SELECT 1 FROM connection_authorization_renewals renewal
					WHERE renewal.request_id = request.id) AS renewal,
				request.created_at,
				profile.name AS capability_profile_name,
				applicant.display_name AS applicant_display_name
			FROM connection_access_requests request
			JOIN connection_principals applicant ON applicant.id = request.applicant_principal_id
			JOIN connection_provider_releases release ON release.id = request.provider_release_id
			JOIN connection_capability_profiles profile ON profile.id = request.capability_profile_id
			WHERE request.state = 'ROUTING_BLOCKED' AND request.expires_at > now()
				AND EXISTS (
					SELECT 1 FROM connection_principal_roles role_binding
					JOIN connection_principals admin ON admin.id = role_binding.principal_id
					WHERE role_binding.principal_id = ${principalId}
						AND role_binding.role = 'CONNECTION_ADMIN'
						AND role_binding.status = 'ACTIVE' AND admin.status = 'ACTIVE'
				)
			ORDER BY request.created_at LIMIT 100
		`;
		return Promise.all(
			rows.map(async (row) => ({
				...(await this.projectRequest(row)),
				applicantDisplayName: row.applicant_display_name,
			})),
		);
	}

	async reroute(input: ApprovalRerouteInput) {
		if (
			!input.reason.trim() ||
			input.reason.length > 1_000 ||
			input.approvers.length < 1 ||
			input.approvers.length > 50 ||
			new Set(input.approvers.map((item) => item.principalId)).size !==
				input.approvers.length
		) {
			invalid("Approval reroute is invalid");
		}
		return this.sql.begin(async (sql) => {
			const [admin] = await sql<{ id: string }[]>`
				SELECT principal.id FROM connection_principal_roles role_binding
				JOIN connection_principals principal ON principal.id = role_binding.principal_id
				WHERE role_binding.principal_id = ${input.actorPrincipalId}
					AND role_binding.role = 'CONNECTION_ADMIN'
					AND role_binding.status = 'ACTIVE' AND principal.status = 'ACTIVE'
				FOR SHARE OF role_binding, principal
			`;
			if (!admin) forbidden();
			const [target] = await sql<
				{
					applicant_principal_id: string;
					quorum_count: number | null;
					quorum_type: "ALL" | "ANY" | "AT_LEAST_N";
					original_approver_count: number;
					request_revision: string;
					request_stage_id: string;
					routing_revision: string;
					stage_revision: string;
				}[]
			>`
				SELECT request.applicant_principal_id,
					request.revision::text AS request_revision,
					stage.id AS request_stage_id,
					stage.revision::text AS stage_revision,
					stage.routing_revision::text AS routing_revision,
					policy_stage.quorum_type, policy_stage.quorum_count,
					(SELECT count(*)::int FROM connection_approval_stage_approvers original
					 WHERE original.stage_id = policy_stage.id) AS original_approver_count
				FROM connection_access_requests request
				JOIN connection_request_stages stage
					ON stage.request_id = request.id
					AND stage.ordinal = request.current_stage_ordinal
				JOIN connection_approval_stages policy_stage
					ON policy_stage.id = stage.policy_stage_id
				WHERE request.id = ${input.requestId}
					AND request.state IN ('IN_REVIEW', 'ROUTING_BLOCKED')
					AND request.expires_at > now() AND stage.state = 'PENDING'
				FOR UPDATE OF request, stage
			`;
			if (
				!target ||
				target.request_revision !== input.expectedRequestRevision ||
				target.stage_revision !== input.expectedStageRevision ||
				target.routing_revision !== input.expectedRoutingRevision
			) {
				throw new ConnectionError(
					"IDEMPOTENCY_CONFLICT",
					"Approval routing changed",
				);
			}
			if (
				target.quorum_type === "AT_LEAST_N" &&
				(target.quorum_count ?? 0) > input.approvers.length
			)
				invalid("Reroute quorum is unsatisfiable");
			if (
				target.quorum_type === "ALL" &&
				input.approvers.length < target.original_approver_count
			)
				invalid("Reroute cannot lower the required approver count");
			if (
				input.approvers.some(
					(item) => item.principalId === target.applicant_principal_id,
				)
			)
				forbidden();
			const [decided] = await sql<{ id: string }[]>`
				SELECT id FROM connection_approval_decisions
				WHERE request_stage_id = ${target.request_stage_id} LIMIT 1
			`;
			if (decided) invalid("A stage with decisions cannot be rerouted");
			const principals = await sql<{ id: string }[]>`
				SELECT id FROM connection_principals
				WHERE id IN ${sql(input.approvers.map((item) => item.principalId))}
					AND status = 'ACTIVE'
			`;
			if (principals.length !== input.approvers.length) forbidden();
			const nextRevision = Number(target.routing_revision) + 1;
			const routingId = `approval-routing-${randomUUID()}`;
			await sql`
				INSERT INTO connection_request_routing_revisions (
					id, request_id, request_stage_id, revision,
					approver_principal_ids, reason, created_by_principal_id
				) VALUES (
					${routingId}, ${input.requestId}, ${target.request_stage_id},
					${nextRevision}, ${sql.json(input.approvers.map((item) => item.principalId))},
					${input.reason.trim()}, ${input.actorPrincipalId}
				)
			`;
			for (const approver of input.approvers) {
				await sql`
					INSERT INTO connection_request_stage_approvers (
						routing_revision_id, request_id, request_stage_id,
						approver_principal_id, display_snapshot
					) VALUES (
						${routingId}, ${input.requestId}, ${target.request_stage_id},
						${approver.principalId}, ${sql.json({ ...approver.displaySnapshot })}
					)
				`;
			}
			await sql`
				UPDATE connection_request_stages
				SET routing_revision = ${nextRevision}, revision = revision + 1
				WHERE id = ${target.request_stage_id}
			`;
			await sql`
				UPDATE connection_access_requests
				SET state = 'IN_REVIEW', revision = revision + 1, updated_at = now()
				WHERE id = ${input.requestId}
			`;
			await syncApprovalProjections(sql, input.requestId, "REROUTED", true);
			await auditAndEnqueue(sql, {
				actorPrincipalId: input.actorPrincipalId,
				aggregateId: routingId,
				event: "connection.access-request.rerouted",
			});
			return { requestId: input.requestId };
		});
	}

	async listNotifications(principalId: string): Promise<ApprovalNotifications> {
		await this.requireActivePrincipal(principalId);
		const [items, counts] = await Promise.all([
			this.sql<
				{
					archived_at: string | null;
					business_id: string;
					business_type:
						| "CONNECTION_ACCESS_AUTHORIZATION"
						| "CONNECTION_ACCESS_REQUEST"
						| "CONNECTION_DISPATCH_FAILURE"
						| "PROVIDER_UPGRADE_TASK";
					created_at: string;
					event_type: string;
					id: string;
					provider_id: string;
					read_at: string | null;
					state: string;
				}[]
			>`
				SELECT notification.id, notification.business_id, notification.business_type,
					notification.event_type, notification.created_at,
					notification.summary->>'providerId' AS provider_id,
					notification.summary->>'state' AS state,
					receipt.read_at, receipt.archived_at
				FROM connection_notifications notification
				JOIN connection_notification_receipts receipt
					ON receipt.notification_id = notification.id
					AND receipt.recipient_principal_id = notification.recipient_principal_id
				WHERE notification.recipient_principal_id = ${principalId}
					AND notification.business_type IN ('CONNECTION_ACCESS_REQUEST', 'CONNECTION_ACCESS_AUTHORIZATION', 'CONNECTION_DISPATCH_FAILURE', 'PROVIDER_UPGRADE_TASK')
					AND (notification.event_type NOT IN ('ROUTING_BLOCKED', 'DISPATCH_FAILED') OR EXISTS (
						SELECT 1 FROM connection_principal_roles role_binding
						WHERE role_binding.principal_id = ${principalId}
							AND role_binding.role = 'CONNECTION_ADMIN'
							AND role_binding.status = 'ACTIVE'
					))
					AND receipt.archived_at IS NULL
				ORDER BY notification.created_at DESC, notification.id DESC
				LIMIT 50
			`,
			this.sql<
				{
					admin_work_items: number;
					open_work_items: number;
					reapproval_work_items: number;
					unread_count: number;
					upgrade_work_items: number;
				}[]
			>`
				SELECT
				(SELECT count(*)::int FROM connection_work_items
				 WHERE recipient_principal_id = ${principalId}
					AND ((business_type = 'CONNECTION_ACCESS_REQUEST' AND action_type = 'REROUTE')
						OR (business_type = 'CONNECTION_DISPATCH_FAILURE' AND action_type = 'RETRY'))
					AND status = 'OPEN'
					AND EXISTS (
						SELECT 1 FROM connection_principal_roles role_binding
						WHERE role_binding.principal_id = ${principalId}
							AND role_binding.role = 'CONNECTION_ADMIN'
							AND role_binding.status = 'ACTIVE'
					)) AS admin_work_items,
				(SELECT count(*)::int FROM connection_work_items
				 WHERE recipient_principal_id = ${principalId}
					AND business_type = 'CONNECTION_ACCESS_REQUEST'
					AND action_type = 'REVIEW' AND status = 'OPEN') AS open_work_items,
					(SELECT count(*)::int FROM connection_work_items
					 WHERE recipient_principal_id = ${principalId}
						AND business_type = 'CONNECTION_ACCESS_AUTHORIZATION'
						AND action_type = 'REAPPROVE' AND status = 'OPEN') AS reapproval_work_items,
					(SELECT count(*)::int FROM connection_work_items
					 WHERE recipient_principal_id = ${principalId}
						AND business_type = 'PROVIDER_UPGRADE_TASK'
						AND status = 'OPEN') AS upgrade_work_items,
					(SELECT count(*)::int FROM connection_notification_receipts receipt
					 JOIN connection_notifications notification
						ON notification.id = receipt.notification_id
					 WHERE receipt.recipient_principal_id = ${principalId}
						AND notification.business_type IN ('CONNECTION_ACCESS_REQUEST', 'CONNECTION_ACCESS_AUTHORIZATION', 'CONNECTION_DISPATCH_FAILURE', 'PROVIDER_UPGRADE_TASK')
						AND (notification.event_type NOT IN ('ROUTING_BLOCKED', 'DISPATCH_FAILED') OR EXISTS (
							SELECT 1 FROM connection_principal_roles role_binding
							WHERE role_binding.principal_id = ${principalId}
								AND role_binding.role = 'CONNECTION_ADMIN'
								AND role_binding.status = 'ACTIVE'
						))
						AND NOT EXISTS (
							SELECT 1 FROM connection_work_items item
							WHERE item.recipient_principal_id = ${principalId}
								AND item.business_type = notification.business_type
								AND item.business_id = notification.business_id
								AND item.status = 'OPEN'
						)
						AND receipt.read_at IS NULL AND receipt.archived_at IS NULL)
						AS unread_count
			`,
		]);
		return {
			adminWorkItems: counts[0]?.admin_work_items ?? 0,
			items: items.map((item) => ({
				archivedAt: item.archived_at,
				businessId: item.business_id,
				businessType: item.business_type,
				createdAt: item.created_at,
				eventType: item.event_type,
				id: item.id,
				providerId: item.provider_id,
				readAt: item.read_at,
				state: item.state,
			})),
			openWorkItems: counts[0]?.open_work_items ?? 0,
			reapprovalWorkItems: counts[0]?.reapproval_work_items ?? 0,
			unreadCount: counts[0]?.unread_count ?? 0,
			upgradeWorkItems: counts[0]?.upgrade_work_items ?? 0,
		};
	}

	async listWorkItems(
		principalId: string,
	): Promise<readonly ConnectionWorkItem[]> {
		await this.requireActivePrincipal(principalId);
		const rows = await this.sql<
			{
				action_type: string;
				business_id: string;
				business_type: ConnectionWorkItem["businessType"];
				created_at: Date;
				due_at: Date | null;
				id: string;
				revision: string;
				status: string;
			}[]
		>`
			SELECT id, business_id, business_type, action_type,
				status, business_revision::text AS revision, due_at, created_at
			FROM connection_work_items
			WHERE recipient_principal_id = ${principalId}
				AND business_type IN (
					'CONNECTION_ACCESS_REQUEST', 'CONNECTION_ACCESS_AUTHORIZATION',
					'CONNECTION_DISPATCH_FAILURE',
					'PROVIDER_UPGRADE_TASK'
				)
				AND (action_type NOT IN ('REROUTE', 'RETRY') OR EXISTS (
					SELECT 1 FROM connection_principal_roles role_binding
					WHERE role_binding.principal_id = ${principalId}
						AND role_binding.role = 'CONNECTION_ADMIN'
						AND role_binding.status = 'ACTIVE'
				))
			ORDER BY (status = 'OPEN') DESC, due_at NULLS LAST, created_at DESC
			LIMIT 100
		`;
		return rows.map((row) => ({
			actionType: row.action_type,
			businessId: row.business_id,
			businessType: row.business_type,
			createdAt: row.created_at.toISOString(),
			dueAt: row.due_at?.toISOString() ?? null,
			id: row.id,
			revision: row.revision,
			status: row.status,
		}));
	}

	async markNotifications(
		principalId: string,
		notificationIds: readonly string[],
		archive: boolean,
	) {
		if (
			notificationIds.length < 1 ||
			notificationIds.length > 100 ||
			new Set(notificationIds).size !== notificationIds.length
		)
			invalid("Notification IDs are invalid");
		await this.sql.begin(async (sql) => {
			const owned = await sql<{ notification_id: string }[]>`
				SELECT receipt.notification_id
				FROM connection_notification_receipts receipt
				JOIN connection_notifications notification ON notification.id = receipt.notification_id
				WHERE receipt.notification_id IN ${sql([...notificationIds])}
					AND receipt.recipient_principal_id = ${principalId}
					AND notification.recipient_principal_id = ${principalId}
					AND notification.business_type IN (
						'CONNECTION_ACCESS_REQUEST', 'CONNECTION_ACCESS_AUTHORIZATION',
						'CONNECTION_DISPATCH_FAILURE',
						'PROVIDER_UPGRADE_TASK'
					)
					AND (notification.event_type NOT IN ('ROUTING_BLOCKED', 'DISPATCH_FAILED') OR EXISTS (
						SELECT 1 FROM connection_principal_roles role_binding
						WHERE role_binding.principal_id = ${principalId}
							AND role_binding.role = 'CONNECTION_ADMIN'
							AND role_binding.status = 'ACTIVE'
					))
				FOR UPDATE OF receipt
			`;
			if (owned.length !== notificationIds.length) forbidden();
			await sql`
				UPDATE connection_notification_receipts
				SET read_at = COALESCE(read_at, now()),
					archived_at = CASE WHEN ${archive} THEN COALESCE(archived_at, now())
						ELSE archived_at END
				WHERE recipient_principal_id = ${principalId}
					AND notification_id IN ${sql([...notificationIds])}
			`;
		});
	}

	async markNotification(
		principalId: string,
		notificationId: string,
		archive: boolean,
	) {
		return this.markNotifications(principalId, [notificationId], archive);
	}

	async expireDueAuthorizations(limit = 50) {
		const candidates = await this.sql<{ connection_id: string; id: string }[]>`
			SELECT id, connection_id FROM connection_access_authorizations
			WHERE state IN ('ACTIVE', 'REAPPROVAL_REQUIRED')
				AND (valid_until <= now() OR (
					state = 'REAPPROVAL_REQUIRED' AND reapproval_deadline_at <= now()
				))
			ORDER BY valid_until NULLS LAST, id LIMIT ${limit}
		`;
		let expired = 0;
		for (const candidate of candidates) {
			const changed = await this.sql.begin(async (sql) => {
				const [account] = await sql<
					{ id: string; owner_principal_id: string; provider_id: string }[]
				>`
					SELECT id, owner_principal_id, provider_id FROM connection_accounts
					WHERE id = ${candidate.connection_id} AND owner_type = 'PERSONAL'
					FOR UPDATE
				`;
				if (!account) return false;
				const [authorization] = await sql<
					{ id: string; state: "EXPIRED" | "SUSPENDED" }[]
				>`
					UPDATE connection_access_authorizations
					SET state = CASE WHEN valid_until <= now() THEN 'EXPIRED'
						ELSE 'SUSPENDED' END,
						revision = revision + 1, updated_at = now()
					WHERE id = ${candidate.id} AND connection_id = ${account.id}
						AND state IN ('ACTIVE', 'REAPPROVAL_REQUIRED')
						AND (valid_until <= now() OR (
							state = 'REAPPROVAL_REQUIRED' AND reapproval_deadline_at <= now()
						))
					RETURNING id, state
				`;
				if (!authorization) return false;
				await sql`
					UPDATE connection_accounts
					SET revision = revision + 1, execution_fence = execution_fence + 1
					WHERE id = ${account.id}
				`;
				await sql`
					UPDATE connection_grants
					SET status = 'PAUSED_CONNECTION'
					WHERE connection_id = ${account.id} AND status = 'ACTIVE'
				`;
				await sql`
					UPDATE connection_work_items
					SET status = 'EXPIRED', completed_at = now(), updated_at = now()
					WHERE business_type = 'CONNECTION_ACCESS_AUTHORIZATION'
						AND business_id = ${authorization.id}
						AND action_type = 'REAPPROVE' AND status = 'OPEN'
				`;
				await sql`
					UPDATE connection_access_reapproval_targets
					SET status = 'CANCELED', completed_at = now()
					WHERE access_authorization_id = ${authorization.id} AND status = 'PENDING'
				`;
				await sql`
					WITH created AS (
						INSERT INTO connection_notifications (
							id, recipient_principal_id, business_type, business_id,
							business_revision, event_type, summary
						) VALUES (
							${`approval-notification-${randomUUID()}`},
							${account.owner_principal_id}, 'CONNECTION_ACCESS_AUTHORIZATION',
							${authorization.id}, 1, ${authorization.state},
							${sql.json({ providerId: account.provider_id, state: authorization.state })}
						)
						ON CONFLICT DO NOTHING
						RETURNING id, recipient_principal_id
					)
					INSERT INTO connection_notification_receipts (
						notification_id, recipient_principal_id
					)
					SELECT id, recipient_principal_id FROM created
				`;
				await auditAndEnqueue(sql, {
					actorPrincipalId: account.owner_principal_id,
					aggregateId: authorization.id,
					event: `connection.access-authorization.${authorization.state.toLowerCase()}`,
				});
				return true;
			});
			if (changed) expired++;
		}
		return expired;
	}

	async revokeAuthorization(input: {
		actorPrincipalId: string;
		authorizationId: string;
		expectedRevision: string;
	}) {
		return this.sql.begin(async (sql) => {
			const [admin] = await sql<{ id: string }[]>`
				SELECT principal.id FROM connection_principal_roles role_binding
				JOIN connection_principals principal ON principal.id = role_binding.principal_id
				WHERE role_binding.principal_id = ${input.actorPrincipalId}
					AND role_binding.role = 'CONNECTION_ADMIN'
					AND role_binding.status = 'ACTIVE' AND principal.status = 'ACTIVE'
				FOR SHARE OF role_binding, principal
			`;
			if (!admin) forbidden();
			const [candidate] = await sql<{ connection_id: string }[]>`
				SELECT connection_id FROM connection_access_authorizations
				WHERE id = ${input.authorizationId}
			`;
			if (!candidate) forbidden();
			const [account] = await sql<
				{ id: string; owner_principal_id: string; provider_id: string }[]
			>`
				SELECT id, owner_principal_id, provider_id FROM connection_accounts
				WHERE id = ${candidate.connection_id} AND owner_type = 'PERSONAL'
				FOR UPDATE
			`;
			if (!account) forbidden();
			const [authorization] = await sql<{ revision: string; state: string }[]>`
				SELECT revision::text, state FROM connection_access_authorizations
				WHERE id = ${input.authorizationId} AND connection_id = ${account.id}
				FOR UPDATE
			`;
			if (
				!authorization ||
				authorization.revision !== input.expectedRevision ||
				authorization.state === "REVOKED"
			) {
				throw new ConnectionError(
					"IDEMPOTENCY_CONFLICT",
					"Access authorization changed",
				);
			}
			await sql`
				UPDATE connection_access_authorizations
				SET state = 'REVOKED', reapproval_deadline_at = NULL,
					revision = revision + 1, updated_at = now()
				WHERE id = ${input.authorizationId}
			`;
			await sql`
				UPDATE connection_accounts
				SET revision = revision + 1, execution_fence = execution_fence + 1
				WHERE id = ${account.id}
			`;
			await sql`
				UPDATE connection_grants SET status = 'PAUSED_CONNECTION'
				WHERE connection_id = ${account.id} AND status = 'ACTIVE'
			`;
			await sql`
				UPDATE connection_work_items
				SET status = 'CANCELED', updated_at = now(), completed_at = now()
				WHERE business_type = 'CONNECTION_ACCESS_AUTHORIZATION'
					AND business_id = ${input.authorizationId}
					AND status = 'OPEN'
			`;
			await sql`
				UPDATE connection_access_reapproval_targets
				SET status = 'CANCELED', completed_at = now()
				WHERE access_authorization_id = ${input.authorizationId}
					AND status = 'PENDING'
			`;
			await sql`
				WITH created AS (
					INSERT INTO connection_notifications (
						id, recipient_principal_id, business_type, business_id,
						business_revision, event_type, summary
					) VALUES (
						${`approval-notification-${randomUUID()}`},
						${account.owner_principal_id}, 'CONNECTION_ACCESS_AUTHORIZATION',
						${input.authorizationId}, ${input.expectedRevision}::bigint + 1, 'REVOKED',
						${sql.json({ providerId: account.provider_id, state: "REVOKED" })}
					)
					RETURNING id, recipient_principal_id
				)
				INSERT INTO connection_notification_receipts (notification_id, recipient_principal_id)
				SELECT id, recipient_principal_id FROM created
			`;
			await auditAndEnqueue(sql, {
				actorPrincipalId: input.actorPrincipalId,
				aggregateId: input.authorizationId,
				event: "connection.access-authorization.revoked",
			});
			return { authorizationId: input.authorizationId };
		});
	}

	async listCurrentAuthorizations(principalId: string) {
		const rows = await this.sql<
			{
				connection_id: string;
				id: string;
				owner_display_name: string;
				provider_id: string;
				revision: string;
				state: string;
				valid_until: Date | null;
			}[]
		>`
			SELECT access.id, access.connection_id, access.revision::text,
				access.state, access.valid_until,
				owner.display_name AS owner_display_name,
				account.provider_id
			FROM connection_access_authorizations access
			JOIN connection_accounts account ON account.id = access.connection_id
			JOIN connection_principals owner ON owner.id = access.principal_id
			WHERE account.owner_type = 'PERSONAL'
				AND access.state <> 'REVOKED'
				AND EXISTS (
					SELECT 1 FROM connection_principal_roles role_binding
					JOIN connection_principals admin ON admin.id = role_binding.principal_id
					WHERE role_binding.principal_id = ${principalId}
						AND role_binding.role = 'CONNECTION_ADMIN'
						AND role_binding.status = 'ACTIVE' AND admin.status = 'ACTIVE'
				)
			ORDER BY access.updated_at DESC, access.id DESC LIMIT 100
		`;
		return rows.map((row) => ({
			connectionId: row.connection_id,
			id: row.id,
			ownerDisplayName: row.owner_display_name,
			providerId: row.provider_id,
			revision: row.revision,
			state: row.state,
			validUntil: row.valid_until?.toISOString() ?? null,
		}));
	}

	async createReapprovalCampaign(input: ReapprovalCampaignInput) {
		return this.sql.begin((sql) =>
			PostgresConnectionAccessRequestRepository.createReapprovalCampaignInTransaction(
				sql,
				input,
			),
		);
	}

	static async createReapprovalCampaignInTransaction(
		sql: postgres.TransactionSql,
		input: ReapprovalCampaignInput,
	) {
		if (
			!input.reason.trim() ||
			input.reason.length > 1_000 ||
			!Number.isFinite(Date.parse(input.deadlineAt))
		)
			invalid("Reapproval campaign is invalid");
		const [admin] = await sql<{ id: string }[]>`
				SELECT principal.id FROM connection_principal_roles role_binding
				JOIN connection_principals principal ON principal.id = role_binding.principal_id
				WHERE role_binding.principal_id = ${input.actorPrincipalId}
					AND role_binding.role = 'CONNECTION_ADMIN'
					AND role_binding.status = 'ACTIVE' AND principal.status = 'ACTIVE'
				FOR SHARE OF role_binding, principal
			`;
		if (!admin) forbidden();
		const [target] = await sql<{ provider: string }[]>`
				SELECT release.provider
				FROM connection_capability_profiles profile
				JOIN connection_provider_releases release
					ON release.id = profile.provider_release_id
				WHERE profile.id = ${input.capabilityProfileId}
					AND profile.provider_release_id = ${input.providerReleaseId}
			`;
		if (!target) forbidden();
		const [validation] = await sql<{ valid: boolean; future: boolean }[]>`
				SELECT ${input.deadlineAt}::timestamptz > now() AS future,
					CASE ${input.triggerKind}
						WHEN 'DISCLAIMER' THEN EXISTS (
							SELECT 1 FROM connection_disclaimer_versions disclaimer
							JOIN connection_access_policy_disclaimers bundle
								ON bundle.disclaimer_version_id = disclaimer.id
							JOIN connection_access_policy_versions policy
								ON policy.id = bundle.policy_version_id
							WHERE disclaimer.id = ${input.triggerVersionId}
								AND disclaimer.status = 'PUBLISHED'
								AND disclaimer.material_change = true
								AND (disclaimer.kind = 'GLOBAL' OR disclaimer.provider_id = ${target.provider})
								AND policy.provider_release_id = ${input.providerReleaseId}
								AND policy.capability_profile_id = ${input.capabilityProfileId}
								AND policy.status = 'PUBLISHED'
						)
						WHEN 'POLICY' THEN EXISTS (
							SELECT 1 FROM connection_access_policy_versions policy
							WHERE policy.id = ${input.triggerVersionId}
								AND policy.provider_release_id = ${input.providerReleaseId}
								AND policy.capability_profile_id = ${input.capabilityProfileId}
								AND policy.status = 'PUBLISHED'
						)
						WHEN 'PROVIDER_RELEASE' THEN EXISTS (
							SELECT 1 FROM connection_provider_releases release
							WHERE release.id = ${input.triggerVersionId}
								AND release.provider = ${target.provider}
								AND release.id <> ${input.providerReleaseId}
								AND release.status = 'PUBLISHED'
						)
						ELSE false END AS valid
			`;
		if (!validation?.future || !validation.valid)
			invalid("Reapproval trigger is unavailable");
		await sql`
				INSERT INTO connection_access_reapproval_campaigns (
					id, provider_release_id, capability_profile_id, trigger_kind,
					trigger_version_id, reason, deadline_at, created_by_principal_id
				) VALUES (
					${input.id}, ${input.providerReleaseId}, ${input.capabilityProfileId},
					${input.triggerKind}, ${input.triggerVersionId}, ${input.reason.trim()},
					${input.deadlineAt}, ${input.actorPrincipalId}
				)
			`;
		// ponytail: one transaction holds all matching accounts; batch campaigns if the population grows beyond bounded admin operations.
		const affected = await sql<
			{
				external_account: string;
				external_account_fingerprint: string;
				id: string;
				owner_principal_id: string;
				provider_id: string;
			}[]
		>`
				SELECT access.id, access.external_account_fingerprint,
					account.external_account, account.owner_principal_id, account.provider_id
				FROM connection_access_authorizations access
				JOIN connection_accounts account ON account.id = access.connection_id
				WHERE access.provider_release_id = ${input.providerReleaseId}
					AND access.capability_profile_id = ${input.capabilityProfileId}
					AND access.state IN ('ACTIVE', 'REAPPROVAL_REQUIRED', 'DISCONNECTED')
					AND (access.valid_until IS NULL OR access.valid_until > now())
					AND NOT (
						${input.triggerKind} = 'DISCLAIMER' AND EXISTS (
							SELECT 1 FROM connection_request_disclaimer_confirmations confirmation
							WHERE confirmation.request_id = access.source_request_id
								AND confirmation.disclaimer_version_id = ${input.triggerVersionId}
						)
					)
					AND NOT (
						${input.triggerKind} = 'POLICY' AND EXISTS (
							SELECT 1 FROM connection_access_requests original_request
							WHERE original_request.id = access.source_request_id
								AND original_request.policy_version_id = ${input.triggerVersionId}
						)
					)
					AND account.status IN ('ACTIVE', 'DISCONNECTED')
					AND account.owner_type = 'PERSONAL'
				ORDER BY account.id
				FOR UPDATE OF account, access
			`;
		for (const authorization of affected) {
			if (
				authorization.external_account_fingerprint !==
				canonicalHash({
					externalAccount: authorization.external_account,
					providerReleaseId: input.providerReleaseId,
				})
			)
				forbidden();
			const [updated] = await sql<
				{ revision: string; reapproval_deadline_at: Date }[]
			>`
					UPDATE connection_access_authorizations
					SET state = 'REAPPROVAL_REQUIRED',
						reapproval_deadline_at = LEAST(
							COALESCE(reapproval_deadline_at, ${input.deadlineAt}::timestamptz),
							${input.deadlineAt}::timestamptz),
						revision = revision + 1, updated_at = now()
					WHERE id = ${authorization.id}
					RETURNING revision::text, reapproval_deadline_at
				`;
			if (!updated) forbidden();
			await sql`
					INSERT INTO connection_access_reapproval_targets (
						campaign_id, access_authorization_id, status
					) VALUES (${input.id}, ${authorization.id}, 'PENDING')
				`;
			await sql`
					INSERT INTO connection_work_items (
						id, recipient_principal_id, business_type, business_id,
						business_revision, action_type, status, due_at
					) VALUES (
						${`reapproval-work-${authorization.id}`}, ${authorization.owner_principal_id},
						'CONNECTION_ACCESS_AUTHORIZATION', ${authorization.id},
						${updated.revision}, 'REAPPROVE', 'OPEN', ${updated.reapproval_deadline_at}
					)
					ON CONFLICT (recipient_principal_id, business_type, business_id, action_type)
					DO UPDATE SET status = 'OPEN', due_at = EXCLUDED.due_at,
						completed_at = NULL, updated_at = now(),
						business_revision = EXCLUDED.business_revision
				`;
			await sql`
					WITH created AS (
						INSERT INTO connection_notifications (
							id, recipient_principal_id, business_type, business_id,
							business_revision, event_type, summary
						) VALUES (
							${`approval-notification-${randomUUID()}`}, ${authorization.owner_principal_id},
							'CONNECTION_ACCESS_AUTHORIZATION', ${authorization.id},
							${updated.revision}, 'REAPPROVAL_REQUIRED',
							${sql.json({ providerId: authorization.provider_id, state: "REAPPROVAL_REQUIRED" })}
						)
						RETURNING id, recipient_principal_id
					)
					INSERT INTO connection_notification_receipts (notification_id, recipient_principal_id)
					SELECT id, recipient_principal_id FROM created
				`;
			await auditAndEnqueue(sql, {
				actorPrincipalId: input.actorPrincipalId,
				aggregateId: `${input.id}:${authorization.id}`,
				event: "connection.access-authorization.reapproval-required",
			});
		}
		await auditAndEnqueue(sql, {
			actorPrincipalId: input.actorPrincipalId,
			aggregateId: input.id,
			event: "connection.reapproval-campaign.created",
		});
		return { campaignId: input.id, affectedConnections: affected.length };
	}

	async expireDueRequests(limit = 50) {
		const candidates = await this.sql<{ id: string }[]>`
			SELECT id FROM connection_access_requests
			WHERE (state IN ('SUBMITTED', 'IN_REVIEW', 'ROUTING_BLOCKED')
					AND expires_at <= now())
				OR (state = 'APPROVED_PENDING_CONNECTION'
					AND connect_expires_at <= now())
			ORDER BY expires_at, id LIMIT ${limit}
		`;
		let expired = 0;
		for (const candidate of candidates) {
			const changed = await this.sql.begin(async (sql) => {
				const [request] = await sql<
					{ applicant_principal_id: string; id: string }[]
				>`
					UPDATE connection_access_requests
					SET state = 'EXPIRED', current_stage_ordinal = NULL,
						revision = revision + 1, updated_at = now()
					WHERE id = ${candidate.id}
						AND ((state IN ('SUBMITTED', 'IN_REVIEW', 'ROUTING_BLOCKED')
							AND expires_at <= now())
							OR (state = 'APPROVED_PENDING_CONNECTION'
								AND connect_expires_at <= now()))
					RETURNING id, applicant_principal_id
				`;
				if (!request) return false;
				await sql`
					UPDATE connection_request_stages
					SET state = 'SKIPPED_BY_CANCEL', completed_at = now(), revision = revision + 1
					WHERE request_id = ${request.id}
						AND state IN ('PENDING', 'NOT_STARTED')
				`;
				await sql`
					UPDATE connection_authorization_renewals
					SET status = 'EXPIRED', completed_at = now()
					WHERE request_id = ${request.id} AND status = 'PENDING'
				`;
				await syncApprovalProjections(sql, request.id, "EXPIRED", false);
				await auditAndEnqueue(sql, {
					actorPrincipalId: request.applicant_principal_id,
					aggregateId: request.id,
					event: "connection.access-request.expired",
				});
				return true;
			});
			if (changed) expired++;
		}
		return expired;
	}

	createRenewalRequest(
		input: AccessRequestInput & { authorizationId: string },
	) {
		return this.createRequest({
			...input,
			renewalAuthorizationId: input.authorizationId,
		});
	}

	async createRequest(
		input: AccessRequestInput & { renewalAuthorizationId?: string },
	) {
		if (!input.purpose.trim() || input.purpose.length > 2_000) {
			invalid("Approval request purpose is invalid");
		}
		await this.sql.begin(async (sql) => {
			const [applicant] = await sql<{ id: string }[]>`
				SELECT id FROM connection_principals
				WHERE id = ${input.applicantPrincipalId} AND status = 'ACTIVE'
				FOR SHARE
			`;
			if (!applicant) forbidden();
			const [policy] = await sql<PolicyRow[]>`
				SELECT policy.provider_release_id, policy.capability_profile_id,
					policy.request_ttl_seconds, policy.connect_ttl_seconds, policy.renewal_lead_seconds
				FROM connection_access_policy_versions policy
				JOIN connection_capability_profiles profile ON profile.id = policy.capability_profile_id
					AND profile.provider_release_id = policy.provider_release_id
				JOIN connection_provider_releases release ON release.id = policy.provider_release_id
				WHERE policy.id = ${input.policyVersionId} AND policy.status = 'PUBLISHED'
					AND profile.status = 'PUBLISHED' AND release.status = 'PUBLISHED'
				FOR SHARE OF policy, profile, release
			`;
			if (
				!policy ||
				policy.provider_release_id !== input.providerReleaseId ||
				policy.capability_profile_id !== input.capabilityProfileId
			) {
				invalid("Approval policy does not match the requested capability");
			}
			let renewalValidUntil: Date | undefined;
			if (input.renewalAuthorizationId) {
				if (input.duration.kind !== "FINITE")
					invalid("Renewal must have a finite duration");
				const [renewalTarget] = await sql<
					{
						external_account: string;
						external_account_fingerprint: string;
						id: string;
						valid_until: Date;
					}[]
				>`
					SELECT access.id, access.valid_until, access.external_account_fingerprint,
						account.external_account
					FROM connection_access_authorizations access
					JOIN connection_accounts account ON account.id = access.connection_id
					JOIN connection_credential_versions credential
						ON credential.connection_id = account.id AND credential.status = 'ACTIVE'
					JOIN connection_capability_profiles profile
						ON profile.id = access.capability_profile_id
					WHERE access.id = ${input.renewalAuthorizationId}
						AND access.principal_id = ${input.applicantPrincipalId}
						AND access.provider_release_id = ${input.providerReleaseId}
						AND access.capability_profile_id = ${input.capabilityProfileId}
						AND access.validity_kind = 'FINITE' AND access.valid_until > now()
						AND access.state = 'ACTIVE'
						AND access.reapproval_deadline_at IS NULL
						AND account.owner_type = 'PERSONAL'
						AND account.owner_principal_id = access.principal_id
						AND account.provider_release_id = access.provider_release_id
						AND account.status = 'ACTIVE'
						AND profile.required_scopes @> credential.scope_json
						AND access.valid_until <= now() + ${policy.renewal_lead_seconds} * interval '1 second'
						AND NOT EXISTS (
							SELECT 1 FROM connection_access_authorizations newer
							WHERE newer.connection_id = access.connection_id AND newer.id <> access.id
								AND newer.created_at >= access.created_at
						)
					FOR SHARE OF access, account, credential
				`;
				if (
					!renewalTarget ||
					renewalTarget.external_account_fingerprint !==
						canonicalHash({
							externalAccount: renewalTarget.external_account,
							providerReleaseId: input.providerReleaseId,
						})
				)
					forbidden();
				const [pending] = await sql<{ id: string }[]>`
					SELECT id FROM connection_authorization_renewals
					WHERE access_authorization_id = ${renewalTarget.id}
						AND status = 'PENDING' FOR UPDATE
				`;
				if (pending)
					throw new ConnectionError(
						"IDEMPOTENCY_CONFLICT",
						"Renewal is already pending",
					);
				renewalValidUntil = renewalTarget.valid_until;
			}
			const [duration] = await sql<{ valid: boolean }[]>`
				SELECT EXISTS (
					SELECT 1 FROM connection_access_policy_durations
					WHERE policy_version_id = ${input.policyVersionId}
						AND duration_kind = ${input.duration.kind}
						AND duration_days IS NOT DISTINCT FROM ${
							input.duration.kind === "FINITE" ? input.duration.days : null
						}
				) AS valid
			`;
			if (!duration?.valid) invalid("Approval request duration is not allowed");

			const disclaimers = await sql<
				{ content_sha256: string; id: string; locale: string }[]
			>`
				SELECT disclaimer.id, disclaimer.content_sha256, disclaimer.locale
				FROM connection_access_policy_disclaimers link
				JOIN connection_disclaimer_versions disclaimer
					ON disclaimer.id = link.disclaimer_version_id
				WHERE link.policy_version_id = ${input.policyVersionId}
					AND disclaimer.status = 'PUBLISHED'
				ORDER BY link.ordinal
			`;
			if (
				!exactSet(
					disclaimers.map((item) => item.id),
					input.disclaimerConfirmations.map((item) => item.disclaimerVersionId),
				)
			) {
				invalid("Approval disclaimer confirmations are incomplete");
			}
			for (const confirmation of input.disclaimerConfirmations) {
				const disclaimer = disclaimers.find(
					(item) => item.id === confirmation.disclaimerVersionId,
				);
				if (
					!disclaimer ||
					disclaimer.content_sha256 !== confirmation.contentSha256 ||
					disclaimer.locale !== confirmation.locale
				) {
					invalid(
						"Approval disclaimer confirmation does not match publication",
					);
				}
			}
			const [presentation] = await sql<{ presented_at: string }[]>`
				SELECT presented_at FROM connection_disclaimer_presentations
				WHERE id = ${input.presentationId}
					AND principal_id = ${input.applicantPrincipalId}
					AND policy_version_id = ${input.policyVersionId}
					AND disclaimer_bundle_digest = ${canonicalHash(
						disclaimers.map((item) => ({
							id: item.id,
							sha256: item.content_sha256,
							locale: item.locale,
						})),
					)}
					AND expires_at > now() AND consumed_request_id IS NULL
				FOR UPDATE
			`;
			if (!presentation)
				invalid("Approval disclaimer presentation is unavailable");

			const stageRows = await sql<StageApproverRow[]>`
				SELECT stage.id AS policy_stage_id, stage.ordinal, stage.name,
					stage.quorum_type, stage.quorum_count, stage.timeout_seconds,
					approver.approver_principal_id AS principal_id,
					approver.display_snapshot
				FROM connection_approval_stages stage
				JOIN connection_approval_stage_approvers approver
					ON approver.stage_id = stage.id
				WHERE stage.policy_version_id = ${input.policyVersionId}
				ORDER BY stage.ordinal, approver.approver_principal_id
			`;
			const stages = [...new Set(stageRows.map((row) => row.ordinal))];
			if (stages.length < 1 || stages[0] !== 1) {
				invalid("Approval policy stages are unavailable");
			}
			let routingBlocked = false;
			for (const ordinal of stages) {
				const rows = stageRows.filter((row) => row.ordinal === ordinal);
				const eligible = rows.filter(
					(row) => row.principal_id !== input.applicantPrincipalId,
				);
				const first = rows[0];
				if (!first) invalid("Approval stage is unavailable");
				if (
					ordinal === 1 &&
					(eligible.length === 0 ||
						(first.quorum_type === "AT_LEAST_N" &&
							(first.quorum_count ?? 0) > eligible.length) ||
						(first.quorum_type === "ALL" && eligible.length !== rows.length))
				) {
					routingBlocked = true;
				}
			}

			await sql`
				INSERT INTO connection_access_requests (
					id, applicant_principal_id, provider_release_id,
					capability_profile_id, policy_version_id, purpose,
					duration_kind, duration_days, state, current_stage_ordinal,
					expires_at
				) VALUES (
					${input.id}, ${input.applicantPrincipalId}, ${input.providerReleaseId},
					${input.capabilityProfileId}, ${input.policyVersionId},
					${input.purpose.trim()}, ${input.duration.kind},
					${input.duration.kind === "FINITE" ? input.duration.days : null},
					${routingBlocked ? "ROUTING_BLOCKED" : "IN_REVIEW"}, 1,
					now() + ${policy.request_ttl_seconds} * interval '1 second'
				)
			`;
			if (input.renewalAuthorizationId && renewalValidUntil) {
				await sql`
					INSERT INTO connection_authorization_renewals (
						id, access_authorization_id, request_id, prior_valid_until, status
					) SELECT
						${`authorization-renewal-${randomUUID()}`},
						access.id, ${input.id}, access.valid_until, 'PENDING'
					FROM connection_access_authorizations access
					WHERE access.id = ${input.renewalAuthorizationId}
				`;
			}

			for (const ordinal of stages) {
				const rows = stageRows.filter((row) => row.ordinal === ordinal);
				const eligible = rows.filter(
					(row) => row.principal_id !== input.applicantPrincipalId,
				);
				const first = rows[0];
				if (!first) invalid("Approval stage is unavailable");
				const requestStageId = `approval-request-stage-${randomUUID()}`;
				const routingId = `approval-routing-${randomUUID()}`;
				await sql`
					INSERT INTO connection_request_stages (
						id, request_id, policy_version_id, policy_stage_id,
						ordinal, state, opened_at
					) VALUES (
						${requestStageId}, ${input.id}, ${input.policyVersionId},
						${first.policy_stage_id}, ${ordinal},
						${ordinal === 1 ? "PENDING" : "NOT_STARTED"},
						${ordinal === 1 ? sql`now()` : null}
					)
				`;
				await sql`
					INSERT INTO connection_request_routing_revisions (
						id, request_id, request_stage_id, revision,
						approver_principal_ids, reason, created_by_principal_id
					) VALUES (
						${routingId}, ${input.id}, ${requestStageId}, 1,
						${sql.json(eligible.map((row) => row.principal_id))},
						'Initial policy routing', ${input.applicantPrincipalId}
					)
				`;
				for (const approver of eligible) {
					await sql`
						INSERT INTO connection_request_stage_approvers (
							routing_revision_id, request_id, request_stage_id,
							approver_principal_id, display_snapshot
						) VALUES (
							${routingId}, ${input.id}, ${requestStageId},
							${approver.principal_id}, ${sql.json(approver.display_snapshot)}
						)
					`;
				}
			}

			for (const confirmation of input.disclaimerConfirmations) {
				await sql`
					INSERT INTO connection_request_disclaimer_confirmations (
						request_id, disclaimer_version_id, content_sha256, locale,
						displayed_at, confirmed_at
					) VALUES (
						${input.id}, ${confirmation.disclaimerVersionId},
						${confirmation.contentSha256}, ${confirmation.locale},
						${presentation.presented_at}, now()
					)
				`;
			}
			await sql`
				UPDATE connection_disclaimer_presentations
				SET consumed_request_id = ${input.id}, consumed_at = now()
				WHERE id = ${input.presentationId} AND consumed_request_id IS NULL
			`;
			await syncApprovalProjections(sql, input.id, "SUBMITTED", true);
			await auditAndEnqueue(sql, {
				actorPrincipalId: input.applicantPrincipalId,
				aggregateId: input.id,
				event: "connection.access-request.created",
			});
		});
		return { requestId: input.id };
	}

	async cancelRequest(input: { principalId: string; requestId: string }) {
		await this.sql.begin(async (sql) => {
			const [request] = await sql<{ state: string }[]>`
				SELECT state FROM connection_access_requests
				WHERE id = ${input.requestId}
					AND applicant_principal_id = ${input.principalId}
				FOR UPDATE
			`;
			if (!request) forbidden();
			if (request.state === "CANCELED") return;
			if (
				![
					"SUBMITTED",
					"IN_REVIEW",
					"ROUTING_BLOCKED",
					"APPROVED_PENDING_CONNECTION",
				].includes(request.state)
			) {
				invalid("Approval request is already terminal");
			}
			await sql`
				UPDATE connection_request_stages
				SET state = 'SKIPPED_BY_CANCEL', completed_at = now(),
					revision = revision + 1
				WHERE request_id = ${input.requestId}
					AND state IN ('PENDING', 'NOT_STARTED')
			`;
			await sql`
				UPDATE connection_access_requests
				SET state = 'CANCELED', current_stage_ordinal = NULL,
					revision = revision + 1, updated_at = now()
				WHERE id = ${input.requestId}
			`;
			await sql`
				UPDATE connection_authorization_renewals
				SET status = 'CANCELED', completed_at = now()
				WHERE request_id = ${input.requestId} AND status = 'PENDING'
			`;
			await syncApprovalProjections(sql, input.requestId, "CANCELED", false);
			await auditAndEnqueue(sql, {
				actorPrincipalId: input.principalId,
				aggregateId: input.requestId,
				event: "connection.access-request.canceled",
			});
		});
	}

	async decide(input: ApprovalDecisionInput) {
		return this.sql.begin(async (sql) => {
			const [replay] = await sql<
				{
					actor_principal_id: string;
					approver_principal_id: string;
					comment: string | null;
					decision: string;
					request_id: string;
				}[]
			>`
				SELECT request_id, approver_principal_id, actor_principal_id,
					decision, comment
				FROM connection_approval_decisions WHERE id = ${input.id}
			`;
			if (replay) {
				if (
					replay.request_id === input.requestId &&
					replay.approver_principal_id === input.approverPrincipalId &&
					replay.actor_principal_id === input.actorPrincipalId &&
					replay.decision === input.decision &&
					replay.comment === (input.comment?.trim() ?? null)
				) {
					return { requestId: input.requestId, replayed: true };
				}
				throw new ConnectionError(
					"IDEMPOTENCY_CONFLICT",
					"Approval decision conflicts",
				);
			}
			const [target] = await sql<DecisionTarget[]>`
				SELECT request.applicant_principal_id,
					request.current_stage_ordinal, request.revision::text AS request_revision,
					stage.id AS request_stage_id, stage.policy_stage_id,
					stage.revision::text AS stage_revision,
					stage.routing_revision::text AS routing_revision,
					policy_stage.quorum_type, policy_stage.quorum_count,
					policy.connect_ttl_seconds
				FROM connection_access_requests request
				JOIN connection_request_stages stage
					ON stage.request_id = request.id
					AND stage.ordinal = request.current_stage_ordinal
				JOIN connection_approval_stages policy_stage
					ON policy_stage.id = stage.policy_stage_id
				JOIN connection_access_policy_versions policy
					ON policy.id = request.policy_version_id
				WHERE request.id = ${input.requestId}
					AND request.state = 'IN_REVIEW'
					AND request.expires_at > now()
					AND stage.state = 'PENDING'
				FOR UPDATE OF request, stage
			`;
			if (
				!target ||
				target.request_revision !== input.expectedRequestRevision ||
				target.stage_revision !== input.expectedStageRevision ||
				target.routing_revision !== input.expectedRoutingRevision
			) {
				throw new ConnectionError(
					"IDEMPOTENCY_CONFLICT",
					"Approval state changed",
				);
			}
			if (
				target.applicant_principal_id === input.actorPrincipalId ||
				target.applicant_principal_id === input.approverPrincipalId
			) {
				forbidden();
			}
			const activeParticipants = await sql<{ id: string }[]>`
				SELECT id FROM connection_principals
				WHERE id IN (${input.actorPrincipalId}, ${input.approverPrincipalId})
					AND status = 'ACTIVE'
				FOR SHARE
			`;
			if (
				activeParticipants.length !==
				(input.actorPrincipalId === input.approverPrincipalId ? 1 : 2)
			) {
				forbidden();
			}
			const [eligibility] = await sql<{ eligible: boolean }[]>`
				SELECT EXISTS (
					SELECT 1
					FROM connection_request_routing_revisions routing
					JOIN connection_request_stage_approvers candidate
						ON candidate.routing_revision_id = routing.id
					WHERE routing.request_stage_id = ${target.request_stage_id}
						AND routing.revision = ${input.expectedRoutingRevision}
						AND candidate.approver_principal_id = ${input.approverPrincipalId}
				) AND (
					${input.actorPrincipalId} = ${input.approverPrincipalId}
					OR EXISTS (
						SELECT 1 FROM connection_approval_delegations delegation
						WHERE delegation.principal_id = ${input.approverPrincipalId}
							AND delegation.delegate_principal_id = ${input.actorPrincipalId}
							AND delegation.status = 'ACTIVE'
							AND delegation.starts_at <= now() AND delegation.ends_at > now()
					)
				) AS eligible
			`;
			if (!eligibility?.eligible) forbidden();

			const [existing] = await sql<{ id: string }[]>`
				SELECT id
				FROM connection_approval_decisions
				WHERE request_stage_id = ${target.request_stage_id}
					AND approver_principal_id = ${input.approverPrincipalId}
			`;
			if (existing) {
				throw new ConnectionError(
					"IDEMPOTENCY_CONFLICT",
					"Approval decision conflicts",
				);
			}
			if (input.decision === "REJECT" && !input.comment?.trim()) {
				invalid("Approval rejection reason is required");
			}
			const [delegation] =
				input.actorPrincipalId === input.approverPrincipalId
					? []
					: await sql<{ id: string }[]>`
						SELECT id FROM connection_approval_delegations
						WHERE principal_id = ${input.approverPrincipalId}
							AND delegate_principal_id = ${input.actorPrincipalId}
							AND status = 'ACTIVE'
							AND starts_at <= now() AND ends_at > now()
						ORDER BY starts_at DESC LIMIT 1 FOR SHARE
					`;
			if (input.actorPrincipalId !== input.approverPrincipalId && !delegation)
				forbidden();
			await sql`
				INSERT INTO connection_approval_decisions (
					id, request_id, request_stage_id, approver_principal_id,
					actor_principal_id, delegation_id, routing_revision,
					decision, comment
				) VALUES (
					${input.id}, ${input.requestId}, ${target.request_stage_id},
					${input.approverPrincipalId}, ${input.actorPrincipalId},
					${delegation?.id ?? null}, ${input.expectedRoutingRevision},
					${input.decision}, ${input.comment?.trim() ?? null}
				)
			`;

			if (input.decision === "REJECT") {
				await sql`
					UPDATE connection_authorization_renewals
					SET status = 'REJECTED', completed_at = now()
					WHERE request_id = ${input.requestId} AND status = 'PENDING'
				`;
				await sql`
					UPDATE connection_request_stages
					SET state = CASE WHEN id = ${target.request_stage_id}
						THEN 'REJECTED' ELSE 'SKIPPED_BY_CANCEL' END,
						completed_at = now(), revision = revision + 1
					WHERE request_id = ${input.requestId}
						AND (id = ${target.request_stage_id} OR state = 'NOT_STARTED')
				`;
				await sql`
					UPDATE connection_access_requests
					SET state = 'REJECTED', current_stage_ordinal = NULL,
						revision = revision + 1, updated_at = now()
					WHERE id = ${input.requestId}
				`;
			} else {
				const [counts] = await sql<{ approvals: number; candidates: number }[]>`
					SELECT
						(SELECT count(*)::int FROM connection_approval_decisions decision
						 WHERE decision.request_stage_id = ${target.request_stage_id}
							AND decision.routing_revision = ${input.expectedRoutingRevision}
							AND decision.decision = 'APPROVE') AS approvals,
						(SELECT count(*)::int FROM connection_request_routing_revisions routing
						 JOIN connection_request_stage_approvers candidate
							ON candidate.routing_revision_id = routing.id
						 WHERE routing.request_stage_id = ${target.request_stage_id}
							AND routing.revision = ${input.expectedRoutingRevision}) AS candidates
				`;
				if (
					counts &&
					quorumSatisfied(
						target.quorum_type,
						target.quorum_count,
						counts.approvals,
						counts.candidates,
					)
				) {
					const [next] = await sql<{ id: string; ordinal: number }[]>`
						SELECT id, ordinal FROM connection_request_stages
						WHERE request_id = ${input.requestId}
							AND ordinal > ${target.current_stage_ordinal}
						ORDER BY ordinal LIMIT 1
						FOR UPDATE
					`;
					await sql`
						UPDATE connection_request_stages
						SET state = 'APPROVED', completed_at = now(), revision = revision + 1
						WHERE id = ${target.request_stage_id}
					`;
					if (next) {
						const [routing] = await sql<
							{
								candidate_count: number;
								original_count: number;
								quorum_count: number | null;
								quorum_type: "ALL" | "ANY" | "AT_LEAST_N";
								routing_revision: number;
							}[]
						>`
							SELECT stage.routing_revision, policy_stage.quorum_type,
								policy_stage.quorum_count,
								(SELECT count(*)::int FROM connection_request_routing_revisions revision
							 JOIN connection_request_stage_approvers candidate
								ON candidate.routing_revision_id = revision.id
							 WHERE revision.request_stage_id = stage.id
								AND revision.revision = stage.routing_revision) AS candidate_count,
								(SELECT count(*)::int FROM connection_approval_stage_approvers approver
							 WHERE approver.stage_id = policy_stage.id) AS original_count
							FROM connection_request_stages stage
							JOIN connection_approval_stages policy_stage
								ON policy_stage.id = stage.policy_stage_id
							WHERE stage.id = ${next.id}
						`;
						const blocked =
							!routing ||
							routing.candidate_count === 0 ||
							(routing.quorum_type === "AT_LEAST_N" &&
								(routing.quorum_count ?? 0) > routing.candidate_count) ||
							(routing.quorum_type === "ALL" &&
								routing.routing_revision === 1 &&
								routing.candidate_count !== routing.original_count);
						await sql`
							UPDATE connection_request_stages
							SET state = 'PENDING', opened_at = now(), revision = revision + 1
							WHERE id = ${next.id} AND state = 'NOT_STARTED'
						`;
						await sql`
							UPDATE connection_access_requests
							SET current_stage_ordinal = ${next.ordinal},
								state = ${blocked ? "ROUTING_BLOCKED" : "IN_REVIEW"},
								revision = revision + 1,
								updated_at = now()
							WHERE id = ${input.requestId}
						`;
					} else {
						const renewed = await completeRenewalInTransaction(
							sql,
							input.requestId,
							input.actorPrincipalId,
							this.restoreRenewedGrants,
						);
						if (!renewed) {
							const permitId = `connect-permit-${randomUUID()}`;
							await sql`
							INSERT INTO connection_connect_permits (id, request_id, expires_at)
							VALUES (
								${permitId}, ${input.requestId},
								now() + ${target.connect_ttl_seconds} * interval '1 second'
							)
						`;
							await sql`
							UPDATE connection_access_requests
							SET state = 'APPROVED_PENDING_CONNECTION',
								current_stage_ordinal = NULL,
								connect_expires_at = now() +
									${target.connect_ttl_seconds} * interval '1 second',
								revision = revision + 1, updated_at = now()
							WHERE id = ${input.requestId}
						`;
						}
					}
				} else {
					await sql`
						UPDATE connection_request_stages
						SET revision = revision + 1 WHERE id = ${target.request_stage_id}
					`;
					await sql`
						UPDATE connection_access_requests
						SET revision = revision + 1, updated_at = now()
						WHERE id = ${input.requestId}
					`;
				}
			}
			await syncApprovalProjections(
				sql,
				input.requestId,
				input.decision,
				input.decision === "APPROVE" &&
					(
						await sql<{ advanced: boolean }[]>`
						SELECT current_stage_ordinal > ${target.current_stage_ordinal}
							AS advanced FROM connection_access_requests
						WHERE id = ${input.requestId}
					`
					)[0]?.advanced === true,
			);
			await auditAndEnqueue(sql, {
				actorPrincipalId: input.actorPrincipalId,
				aggregateId: input.id,
				event: `connection.access-request.${input.decision.toLowerCase()}`,
			});
			return { requestId: input.requestId, replayed: false };
		});
	}

	private async requireActivePrincipal(principalId: string) {
		const [principal] = await this.sql<{ id: string }[]>`
			SELECT id FROM connection_principals
			WHERE id = ${principalId} AND status = 'ACTIVE'
		`;
		if (!principal) forbidden();
	}

	private requestRowsForApplicant(principalId: string, requestId?: string) {
		const columns = this.sql`
			request.id, request.provider_release_id, release.provider AS provider_id,
			request.purpose, request.duration_kind, request.duration_days,
			request.state, request.current_stage_ordinal,
			request.revision::text, request.expires_at, request.connect_expires_at,
			EXISTS (SELECT 1 FROM connection_authorization_renewals renewal
				WHERE renewal.request_id = request.id) AS renewal,
			request.created_at,
			profile.name AS capability_profile_name
		`;
		return requestId
			? this.sql<RequestRow[]>`
				SELECT ${columns}
				FROM connection_access_requests request
				JOIN connection_provider_releases release
					ON release.id = request.provider_release_id
				JOIN connection_capability_profiles profile
					ON profile.id = request.capability_profile_id
				WHERE request.applicant_principal_id = ${principalId}
					AND request.id = ${requestId}
			`
			: this.sql<RequestRow[]>`
				SELECT ${columns}
				FROM connection_access_requests request
				JOIN connection_provider_releases release
					ON release.id = request.provider_release_id
				JOIN connection_capability_profiles profile
					ON profile.id = request.capability_profile_id
				WHERE request.applicant_principal_id = ${principalId}
				ORDER BY request.created_at DESC
			`;
	}

	private async projectRequest(
		row: RequestRow,
	): Promise<AccessRequestProjection> {
		const stages = await this.sql<
			{
				completed_at: Date | null;
				id: string;
				name: string;
				ordinal: number;
				opened_at: Date | null;
				revision: string;
				routing_revision: string;
				state: string;
			}[]
		>`
			SELECT stage.id, policy_stage.name, stage.ordinal, stage.state,
				stage.opened_at, stage.completed_at,
				stage.revision::text, stage.routing_revision::text
			FROM connection_request_stages stage
			JOIN connection_approval_stages policy_stage
				ON policy_stage.id = stage.policy_stage_id
			WHERE stage.request_id = ${row.id}
			ORDER BY stage.ordinal
		`;
		const stageDecisions = await Promise.all(
			stages.map(
				(stage) => this.sql<
					{
						actor_name: string;
						approver_name: string;
						comment: string | null;
						decided_at: Date;
						decision: "APPROVE" | "REJECT";
					}[]
				>`
			SELECT decision.decision, decision.comment, decision.decided_at,
				approver.display_name AS approver_name,
				actor.display_name AS actor_name
			FROM connection_approval_decisions decision
			JOIN connection_principals approver
				ON approver.id = decision.approver_principal_id
			JOIN connection_principals actor
				ON actor.id = decision.actor_principal_id
			WHERE decision.request_stage_id = ${stage.id}
			ORDER BY decision.decided_at, decision.id
		`,
			),
		);
		return {
			capabilityProfileName: row.capability_profile_name,
			connectExpiresAt: row.connect_expires_at?.toISOString() ?? null,
			createdAt: row.created_at.toISOString(),
			currentStageOrdinal: row.current_stage_ordinal,
			duration:
				row.duration_kind === "FINITE"
					? { days: row.duration_days ?? 0, kind: "FINITE" }
					: { kind: "PERMANENT" },
			expiresAt: row.expires_at.toISOString(),
			id: row.id,
			providerId: row.provider_id,
			providerReleaseId: row.provider_release_id,
			purpose: row.purpose,
			renewal: row.renewal,
			revision: row.revision,
			stages: stages.map((stage, index) => ({
				completedAt: stage.completed_at?.toISOString() ?? null,
				decisions: (stageDecisions[index] ?? []).map((decision) => ({
					actorName: decision.actor_name,
					approverName: decision.approver_name,
					comment: decision.comment,
					decidedAt: decision.decided_at.toISOString(),
					decision: decision.decision,
				})),
				name: stage.name,
				openedAt: stage.opened_at?.toISOString() ?? null,
				ordinal: stage.ordinal,
				revision: stage.revision,
				routingRevision: stage.routing_revision,
				state: stage.state,
			})),
			state: row.state,
		};
	}

	consumeConnectPermit(input: ConsumeConnectPermitInput) {
		return this.sql.begin((sql) =>
			consumeConnectPermitInTransaction(sql, input),
		);
	}
}

async function completeRenewalInTransaction(
	sql: postgres.TransactionSql,
	requestId: string,
	actorPrincipalId: string,
	restoreRenewedGrants?: (
		sql: postgres.TransactionSql,
		connectionId: string,
	) => Promise<void>,
) {
	const [renewal] = await sql<
		{
			access_authorization_id: string;
			duration_days: number;
			id: string;
			prior_valid_until: Date;
		}[]
	>`
		SELECT renewal.id, renewal.access_authorization_id,
			renewal.prior_valid_until, request.duration_days
		FROM connection_authorization_renewals renewal
		JOIN connection_access_requests request ON request.id = renewal.request_id
		WHERE renewal.request_id = ${requestId} AND renewal.status = 'PENDING'
			AND request.duration_kind = 'FINITE' AND request.state = 'IN_REVIEW'
		FOR UPDATE OF renewal
	`;
	if (!renewal) {
		const [anyRenewal] = await sql<{ id: string }[]>`
			SELECT id FROM connection_authorization_renewals WHERE request_id = ${requestId}
		`;
		if (anyRenewal) forbidden();
		return false;
	}
	if (!renewal.duration_days || renewal.duration_days < 1)
		invalid("Renewal duration is invalid");
	const [target] = await sql<
		{
			connection_id: string;
			external_account: string;
			provider_release_id: string;
			state: "ACTIVE" | "EXPIRED";
		}[]
	>`
		SELECT access.connection_id, access.provider_release_id,
			access.state, account.external_account
		FROM connection_access_authorizations access
		JOIN connection_accounts account ON account.id = access.connection_id
		JOIN connection_access_requests request ON request.id = ${requestId}
		JOIN connection_credential_versions credential
			ON credential.connection_id = account.id AND credential.status = 'ACTIVE'
		JOIN connection_capability_profiles profile
			ON profile.id = access.capability_profile_id
		WHERE access.id = ${renewal.access_authorization_id}
			AND access.principal_id = request.applicant_principal_id
			AND access.provider_release_id = request.provider_release_id
			AND access.capability_profile_id = request.capability_profile_id
			AND access.validity_kind = 'FINITE'
			AND access.valid_until = (
				SELECT prior_valid_until FROM connection_authorization_renewals
				WHERE id = ${renewal.id}
			)
			AND access.state IN ('ACTIVE', 'EXPIRED')
			AND access.reapproval_deadline_at IS NULL
			AND account.owner_type = 'PERSONAL'
			AND account.owner_principal_id = access.principal_id
			AND account.provider_release_id = access.provider_release_id
			AND account.status = 'ACTIVE'
			AND profile.required_scopes @> credential.scope_json
			AND NOT EXISTS (
				SELECT 1 FROM connection_access_authorizations newer
				WHERE newer.connection_id = access.connection_id AND newer.id <> access.id
					AND newer.created_at >= access.created_at
			)
		FOR UPDATE OF account, access
	`;
	if (!target) forbidden();
	const [fingerprint] = await sql<{ external_account_fingerprint: string }[]>`
		SELECT external_account_fingerprint FROM connection_access_authorizations
		WHERE id = ${renewal.access_authorization_id}
	`;
	if (
		fingerprint?.external_account_fingerprint !==
		canonicalHash({
			externalAccount: target.external_account,
			providerReleaseId: target.provider_release_id,
		})
	)
		forbidden();
	const updated = await sql`
		UPDATE connection_access_authorizations
		SET state = 'ACTIVE', valid_until = GREATEST(valid_until, now()) +
			${renewal.duration_days} * interval '1 day',
			revision = revision + 1, updated_at = now()
		WHERE id = ${renewal.access_authorization_id}
			AND valid_until = (
				SELECT prior_valid_until FROM connection_authorization_renewals
				WHERE id = ${renewal.id}
			)
			AND state IN ('ACTIVE', 'EXPIRED')
	`;
	if (updated.count !== 1) forbidden();
	if (target.state === "EXPIRED") {
		await sql`
			UPDATE connection_accounts
			SET revision = revision + 1, execution_fence = execution_fence + 1
			WHERE id = ${target.connection_id}
		`;
		if (!restoreRenewedGrants)
			throw new ConnectionError(
				"PROVIDER_UNAVAILABLE",
				"Renewal grant restoration is unavailable",
			);
		await restoreRenewedGrants(sql, target.connection_id);
	}
	await sql`
		UPDATE connection_authorization_renewals
		SET status = 'APPROVED', completed_at = now()
		WHERE id = ${renewal.id} AND status = 'PENDING'
	`;
	await sql`
		UPDATE connection_access_requests
		SET state = 'CONSUMED', current_stage_ordinal = NULL,
			revision = revision + 1, updated_at = now()
		WHERE id = ${requestId} AND state = 'IN_REVIEW'
	`;
	await auditAndEnqueue(sql, {
		actorPrincipalId,
		aggregateId: renewal.id,
		event: "connection.access-authorization.renewed",
	});
	return true;
}

export async function consumeConnectPermitInTransaction(
	sql: postgres.TransactionSql,
	input: ConsumeConnectPermitInput,
) {
	const [target] = await sql<
		{
			capability_profile_id: string;
			duration_days: number | null;
			duration_kind: "FINITE" | "PERMANENT";
			external_account: string;
			permit_id: string;
			provider_release_id: string;
			required_scopes: unknown;
		}[]
	>`
		SELECT permit.id AS permit_id, request.provider_release_id,
			request.capability_profile_id, request.duration_kind,
			request.duration_days, account.external_account, profile.required_scopes
		FROM connection_connect_permits permit
		JOIN connection_access_requests request ON request.id = permit.request_id
		JOIN connection_provider_releases release ON release.id = request.provider_release_id
		JOIN connection_capability_profiles profile
			ON profile.id = request.capability_profile_id
		JOIN connection_access_policy_versions policy
			ON policy.id = request.policy_version_id
		JOIN connection_accounts account ON account.id = ${input.connectionId}
		WHERE request.id = ${input.requestId}
			AND request.applicant_principal_id = ${input.principalId}
			AND request.state = 'APPROVED_PENDING_CONNECTION'
			AND release.status = 'PUBLISHED'
			AND profile.status IN ('PUBLISHED', 'SUPERSEDED')
			AND policy.status IN ('PUBLISHED', 'SUPERSEDED')
			AND request.connect_expires_at > now()
			AND permit.consumed_at IS NULL AND permit.expires_at > now()
			AND account.owner_type = 'PERSONAL'
			AND account.owner_principal_id = request.applicant_principal_id
			AND account.provider_release_id = request.provider_release_id
		FOR UPDATE OF permit, request, account
		FOR SHARE OF release, profile, policy
	`;
	if (!target) forbidden();
	const approvedScopes = target.required_scopes;
	if (
		!Array.isArray(approvedScopes) ||
		approvedScopes.some((scope) => typeof scope !== "string") ||
		input.grantedScopes.some((scope) => !approvedScopes.includes(scope))
	) {
		forbidden();
	}
	const externalAccountFingerprint = canonicalHash({
		externalAccount: target.external_account,
		providerReleaseId: target.provider_release_id,
	});
	await sql`
		INSERT INTO connection_access_authorizations (
			id, principal_id, connection_id, provider_release_id,
			capability_profile_id, source, source_request_id,
			external_account_fingerprint, state, validity_kind, valid_until
		) VALUES (
			${input.accessAuthorizationId}, ${input.principalId}, ${input.connectionId},
			${target.provider_release_id}, ${target.capability_profile_id},
			'APPROVED_REQUEST', ${input.requestId},
			${externalAccountFingerprint}, 'ACTIVE', ${target.duration_kind},
			${
				target.duration_kind === "FINITE"
					? sql`now() + ${target.duration_days} * interval '1 day'`
					: null
			}
		)
	`;
	const consumed = await sql`
		UPDATE connection_connect_permits
		SET consumed_at = now(), connection_id = ${input.connectionId}
		WHERE id = ${target.permit_id} AND consumed_at IS NULL
	`;
	if (consumed.count !== 1) {
		throw new ConnectionError(
			"IDEMPOTENCY_CONFLICT",
			"Connect permit was consumed",
		);
	}
	await sql`
		UPDATE connection_access_requests
		SET state = 'CONSUMED', revision = revision + 1, updated_at = now()
		WHERE id = ${input.requestId} AND state = 'APPROVED_PENDING_CONNECTION'
	`;
	await sql`
		UPDATE connection_access_reapproval_targets target
		SET status = 'COMPLETED', completed_at = now()
		FROM connection_access_authorizations prior
		WHERE prior.id = target.access_authorization_id
			AND prior.connection_id = ${input.connectionId}
			AND prior.id <> ${input.accessAuthorizationId}
			AND prior.state = 'REVOKED'
			AND target.status = 'PENDING'
	`;
	await sql`
		UPDATE connection_work_items item
		SET status = 'COMPLETED', completed_at = now(), updated_at = now()
		FROM connection_access_authorizations prior
		WHERE prior.id = item.business_id
			AND prior.connection_id = ${input.connectionId}
			AND prior.state = 'REVOKED'
			AND item.business_type = 'CONNECTION_ACCESS_AUTHORIZATION'
			AND item.action_type = 'REAPPROVE' AND item.status = 'OPEN'
	`;
	await syncApprovalProjections(sql, input.requestId, "CONSUMED", false);
	await auditAndEnqueue(sql, {
		actorPrincipalId: input.principalId,
		aggregateId: input.accessAuthorizationId,
		event: "connection.access-authorization.created",
	});
	return {
		accessAuthorizationId: input.accessAuthorizationId,
		connectionId: input.connectionId,
	};
}

export async function syncApprovalProjections(
	sql: postgres.TransactionSql,
	requestId: string,
	eventType: string,
	notifyApprovers: boolean,
) {
	const [request] = await sql<
		{
			applicant_principal_id: string;
			provider_id: string;
			revision: string;
			state: string;
		}[]
	>`
		SELECT request.applicant_principal_id, release.provider AS provider_id,
			request.revision::text, request.state
		FROM connection_access_requests request
		JOIN connection_provider_releases release
			ON release.id = request.provider_release_id
		WHERE request.id = ${requestId}
	`;
	if (!request) forbidden();
	await sql`
		UPDATE connection_work_items item
		SET status = CASE WHEN EXISTS (
			SELECT 1 FROM connection_approval_decisions decision
			WHERE decision.request_id = ${requestId}
				AND decision.approver_principal_id = item.recipient_principal_id
		) THEN 'COMPLETED' ELSE 'CANCELED' END,
			completed_at = now(), updated_at = now(),
			business_revision = ${request.revision}
		WHERE item.business_type = 'CONNECTION_ACCESS_REQUEST'
			AND item.business_id = ${requestId}
		AND item.status = 'OPEN'
	`;
	if (request.state === "ROUTING_BLOCKED") {
		const administrators = await sql<{ id: string }[]>`
			SELECT principal.id FROM connection_principals principal
			JOIN connection_principal_roles role_binding
				ON role_binding.principal_id = principal.id
			WHERE principal.status = 'ACTIVE'
				AND role_binding.role = 'CONNECTION_ADMIN'
				AND role_binding.status = 'ACTIVE'
		`;
		for (const administrator of administrators) {
			await sql`
				INSERT INTO connection_work_items (
					id, recipient_principal_id, business_type, business_id,
					business_revision, action_type, status
				) VALUES (
					${`approval-reroute-${randomUUID()}`}, ${administrator.id},
					'CONNECTION_ACCESS_REQUEST', ${requestId}, ${request.revision},
					'REROUTE', 'OPEN'
				)
				ON CONFLICT (recipient_principal_id, business_type, business_id, action_type)
				DO UPDATE SET status = 'OPEN', completed_at = NULL,
					updated_at = now(), business_revision = EXCLUDED.business_revision
			`;
			await insertApprovalNotification(sql, {
				eventType: "ROUTING_BLOCKED",
				principalId: administrator.id,
				providerId: request.provider_id,
				requestId,
				revision: request.revision,
				state: request.state,
			});
		}
	}
	if (request.state === "IN_REVIEW") {
		const recipients = await sql<
			{
				principal_id: string;
				due_at: string;
			}[]
		>`
			SELECT candidate.approver_principal_id AS principal_id,
				stage.opened_at + policy_stage.timeout_seconds * interval '1 second'
					AS due_at
			FROM connection_access_requests request
			JOIN connection_request_stages stage
				ON stage.request_id = request.id
				AND stage.ordinal = request.current_stage_ordinal
			JOIN connection_approval_stages policy_stage
				ON policy_stage.id = stage.policy_stage_id
			JOIN connection_request_routing_revisions routing
				ON routing.request_stage_id = stage.id
				AND routing.revision = stage.routing_revision
			JOIN connection_request_stage_approvers candidate
				ON candidate.routing_revision_id = routing.id
			JOIN connection_principals principal
				ON principal.id = candidate.approver_principal_id
				AND principal.status = 'ACTIVE'
			WHERE request.id = ${requestId}
				AND stage.state = 'PENDING'
				AND candidate.approver_principal_id <> request.applicant_principal_id
				AND NOT EXISTS (
					SELECT 1 FROM connection_approval_decisions decision
					WHERE decision.request_stage_id = stage.id
						AND decision.approver_principal_id = candidate.approver_principal_id
				)
		`;
		for (const recipient of recipients) {
			await sql`
				INSERT INTO connection_work_items (
					id, recipient_principal_id, business_type, business_id,
					business_revision, action_type, status, due_at
				) VALUES (
					${`approval-work-${randomUUID()}`}, ${recipient.principal_id},
					'CONNECTION_ACCESS_REQUEST', ${requestId}, ${request.revision},
					'REVIEW', 'OPEN', ${recipient.due_at}
				)
				ON CONFLICT (recipient_principal_id, business_type, business_id, action_type)
				DO UPDATE SET status = 'OPEN', due_at = EXCLUDED.due_at,
					completed_at = NULL, updated_at = now(),
					business_revision = EXCLUDED.business_revision
			`;
			if (notifyApprovers) {
				await insertApprovalNotification(sql, {
					eventType: "REVIEW_REQUIRED",
					principalId: recipient.principal_id,
					providerId: request.provider_id,
					requestId,
					revision: request.revision,
					state: request.state,
				});
			}
		}
	}
	await insertApprovalNotification(sql, {
		eventType,
		principalId: request.applicant_principal_id,
		providerId: request.provider_id,
		requestId,
		revision: request.revision,
		state: request.state,
	});
}

async function insertApprovalNotification(
	sql: postgres.TransactionSql,
	input: {
		eventType: string;
		principalId: string;
		providerId: string;
		requestId: string;
		revision: string;
		state: string;
	},
) {
	await sql`
		WITH created AS (
			INSERT INTO connection_notifications (
				id, recipient_principal_id, business_type, business_id,
				business_revision, event_type, summary
			) VALUES (
				${`approval-notification-${randomUUID()}`}, ${input.principalId},
				'CONNECTION_ACCESS_REQUEST', ${input.requestId}, ${input.revision},
				${input.eventType}, ${sql.json({
					providerId: input.providerId,
					state: input.state,
				})}
			)
			ON CONFLICT DO NOTHING
			RETURNING id, recipient_principal_id
		)
		INSERT INTO connection_notification_receipts (
			notification_id, recipient_principal_id
		)
		SELECT id, recipient_principal_id FROM created
	`;
}

async function auditAndEnqueue(
	sql: postgres.TransactionSql,
	input: {
		actorPrincipalId: string;
		aggregateId: string;
		event: string;
	},
) {
	await sql`
		INSERT INTO connection_audit_records (principal_id, event, detail)
		VALUES (
			${input.actorPrincipalId}, ${input.event},
			${sql.json({ aggregateId: input.aggregateId })}
		)
	`;
	await sql`
		INSERT INTO connection_outbox_events (id, topic, aggregate_id, payload)
		VALUES (
			${`${input.aggregateId}:${input.event}`}, ${input.event},
			${input.aggregateId}, ${sql.json({ aggregateId: input.aggregateId })}
		)
	`;
}
