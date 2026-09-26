import { createHash, randomUUID } from "node:crypto";
import { ConnectionError, canonicalHash } from "@agent-infra/connection-core";
import postgres, { type Sql } from "postgres";
import {
	PostgresConnectionAccessRequestRepository,
	syncApprovalProjections,
} from "./access-request-repository";

export type CapabilityProfileDraft = {
	actionVersionIds: readonly string[];
	id: string;
	name: string;
	providerReleaseId: string;
};

export type DisclaimerDraft = {
	content: string;
	id: string;
	kind: "GLOBAL" | "POLICY" | "PROVIDER";
	locale: string;
	materialChange: boolean;
	ownerMetadata: Readonly<Record<string, postgres.JSONValue>>;
	providerId?: string;
};

export type ApprovalPolicyDraft = {
	allowPermanent: boolean;
	capabilityProfileId: string;
	connectTtlSeconds: number;
	createdByPrincipalId: string;
	defaultDurationDays?: number;
	disclaimerVersionIds: readonly string[];
	durations: readonly (
		| { days: number; id: string; kind: "FINITE" }
		| { id: string; kind: "PERMANENT" }
	)[];
	id: string;
	priority: number;
	providerReleaseId: string;
	renewalLeadSeconds: number;
	requestTtlSeconds: number;
	stages: readonly {
		approvers: readonly {
			displaySnapshot: Readonly<Record<string, postgres.JSONValue>>;
			principalId: string;
		}[];
		id: string;
		name: string;
		quorumCount?: number;
		quorumType: "ALL" | "ANY" | "AT_LEAST_N";
		timeoutSeconds: number;
	}[];
};

type PolicyRow = {
	allow_permanent: boolean;
	capability_profile_id: string;
	default_duration_days: number | null;
	provider_release_id: string;
	status: string;
};

function invalid(message: string): never {
	throw new ConnectionError("INVALID_REQUEST", message);
}

function unique(values: readonly string[], message: string) {
	if (values.length === 0 || new Set(values).size !== values.length) {
		invalid(message);
	}
}

export function validateApprovalPolicyDraft(input: ApprovalPolicyDraft) {
	if (input.stages.length < 1 || input.stages.length > 10) {
		invalid("Approval policy must contain between 1 and 10 stages");
	}
	if (input.disclaimerVersionIds.length > 0)
		unique(
			input.disclaimerVersionIds,
			"Approval policy disclaimers are invalid",
		);
	unique(
		input.durations.map((duration) => duration.id),
		"Approval policy durations are invalid",
	);
	const allApprovers: string[] = [];
	for (const stage of input.stages) {
		if (stage.approvers.length > 50) {
			invalid("Approval stage cannot contain more than 50 approvers");
		}
		if (stage.approvers.length > 0)
			unique(
				stage.approvers.map((approver) => approver.principalId),
				"Approval stage approvers are invalid",
			);
		if (
			stage.quorumType === "AT_LEAST_N" &&
			(!stage.quorumCount ||
				(stage.approvers.length > 0 &&
					stage.quorumCount > stage.approvers.length))
		) {
			invalid("Approval stage quorum cannot be satisfied");
		}
		if (stage.quorumType !== "AT_LEAST_N" && stage.quorumCount !== undefined) {
			invalid("Approval stage quorum count is not allowed");
		}
		allApprovers.push(
			...stage.approvers.map((approver) => approver.principalId),
		);
	}
	if (allApprovers.length > 0)
		unique(allApprovers, "An approver cannot appear in multiple stages");
	const finiteDays = input.durations.flatMap((duration) =>
		duration.kind === "FINITE" ? [duration.days] : [],
	);
	if (
		input.defaultDurationDays !== undefined &&
		!finiteDays.includes(input.defaultDurationDays)
	) {
		invalid("Default duration must be one of the allowed finite durations");
	}
	if (
		input.allowPermanent !==
		input.durations.some((duration) => duration.kind === "PERMANENT")
	) {
		invalid("Permanent duration does not match policy configuration");
	}
}

export class PostgresConnectionApprovalRepository {
	private readonly sql: Sql;

	constructor(databaseUrl: string) {
		this.sql = postgres(databaseUrl, { max: 10 });
	}

	close() {
		return this.sql.end();
	}

	async activatePreLaunchBaseline(actorPrincipalId: string) {
		return this.sql.begin(async (sql) => {
			const [actor] = await sql<{ id: string }[]>`
				SELECT principal.id FROM connection_principals principal
				JOIN connection_principal_roles role_binding
					ON role_binding.principal_id = principal.id
				WHERE principal.id = ${actorPrincipalId}
					AND principal.status = 'ACTIVE'
					AND role_binding.role = 'CONNECTION_ADMIN'
					AND role_binding.status = 'ACTIVE'
				FOR SHARE OF principal, role_binding
			`;
			if (!actor)
				invalid("Cutover actor is not an active Connection administrator");
			const [enforcement] = await sql<{ state: string }[]>`
				SELECT state FROM connection_access_enforcement
				WHERE id = 'personal' FOR UPDATE
			`;
			if (enforcement?.state === "ENFORCED") {
				const [baseline] = await sql<{ count: number }[]>`
					SELECT count(*)::int AS count FROM connection_access_authorizations
					WHERE source = 'PRE_LAUNCH_BASELINE'
				`;
				return { baselinedConnections: baseline?.count ?? 0 };
			}
			if (enforcement?.state !== "PRE_LAUNCH")
				invalid("Personal approval enforcement is unavailable");
			const accounts = await sql<
				{
					external_account: string;
					id: string;
					legacy_connection_id: string | null;
					owner_principal_id: string;
					provider_release_id: string;
					release_status: string;
					scope_json: unknown;
				}[]
			>`
				SELECT account.id, account.owner_principal_id, account.provider_release_id,
					inventory.connection_id AS legacy_connection_id,
					account.external_account, credential.scope_json,
					release.status AS release_status
				FROM connection_accounts account
				LEFT JOIN connection_pre_launch_accounts inventory
					ON inventory.connection_id = account.id
				JOIN connection_provider_releases release
					ON release.id = account.provider_release_id
				LEFT JOIN connection_credential_versions credential
					ON credential.connection_id = account.id AND credential.status = 'ACTIVE'
				WHERE account.owner_type = 'PERSONAL' AND account.status = 'ACTIVE'
				ORDER BY account.id FOR UPDATE OF account
			`;
			let baselinedConnections = 0;
			for (const account of accounts) {
				const [existing] = await sql<
					{
						external_account_fingerprint: string;
						provider_release_id: string;
						principal_id: string;
					}[]
				>`
					SELECT principal_id, provider_release_id, external_account_fingerprint,
						state
					FROM connection_access_authorizations
					WHERE connection_id = ${account.id}
						AND (valid_until IS NULL OR valid_until > now())
						AND (state = 'ACTIVE' OR (state = 'REAPPROVAL_REQUIRED'
							AND reapproval_deadline_at > now()))
				`;
				if (existing) {
					if (
						existing.principal_id !== account.owner_principal_id ||
						existing.provider_release_id !== account.provider_release_id ||
						existing.external_account_fingerprint !==
							canonicalHash({
								externalAccount: account.external_account,
								providerReleaseId: account.provider_release_id,
							})
					) {
						invalid("Personal Connection has no valid existing authorization");
					}
					continue;
				}
				if (!account.legacy_connection_id)
					invalid(
						"Unapproved personal Connection was created after the pre-launch inventory",
					);
				if (
					!account.owner_principal_id ||
					account.release_status !== "PUBLISHED" ||
					!Array.isArray(account.scope_json) ||
					account.scope_json.some((scope) => typeof scope !== "string") ||
					new Set(account.scope_json).size !== account.scope_json.length
				)
					invalid("Personal Connection has no provable credential scopes");
				const scopes = [...account.scope_json].sort();
				const [priorAuthorization] = await sql<{ id: string }[]>`
					SELECT id FROM connection_access_authorizations WHERE connection_id = ${account.id}
				`;
				if (priorAuthorization)
					invalid("Personal Connection has a revoked authorization");
				const actions = await sql<
					{
						effect: "READ" | "WRITE";
						id: string;
						provider_release_id: string;
						required_scopes: unknown;
						status: string;
					}[]
				>`
					SELECT DISTINCT action.id, action.provider_release_id,
						action.effect, action.required_scopes, action.status
					FROM connection_authorization_roots root
					JOIN connection_grants grant_version
						ON grant_version.id = root.current_grant_id
						AND grant_version.status = 'ACTIVE'
					JOIN connection_grant_actions member
						ON member.grant_id = grant_version.id
					JOIN connection_action_versions action
						ON action.id = member.action_version_id
					WHERE grant_version.connection_id = ${account.id}
						AND root.principal_id = ${account.owner_principal_id}
						AND root.status = 'ACTIVE'
					ORDER BY action.id
				`;
				if (
					actions.some(
						(action) =>
							action.provider_release_id !== account.provider_release_id ||
							action.status !== "PUBLISHED" ||
							!Array.isArray(action.required_scopes) ||
							action.required_scopes.some(
								(scope) => typeof scope !== "string" || !scopes.includes(scope),
							),
					)
				)
					invalid("Active Grant does not match the existing credential");
				const profileId = `baseline-profile-${randomUUID()}`;
				await sql`
					INSERT INTO connection_capability_profiles (
						id, provider_release_id, name, effect_ceiling, required_scopes,
						authorization_digest, status
					) VALUES (
						${profileId}, ${account.provider_release_id},
						${`Pre-launch baseline ${account.id}`},
						${actions.some((action) => action.effect === "WRITE") ? "WRITE" : "READ"},
						${sql.json(scopes)},
						${canonicalHash({ actionVersionIds: actions.map((action) => action.id), scopes })},
						'DRAFT'
					)
				`;
				for (const action of actions) {
					await sql`
						INSERT INTO connection_capability_profile_actions (
							capability_profile_id, provider_release_id, action_version_id
						) VALUES (${profileId}, ${account.provider_release_id}, ${action.id})
					`;
				}
				await sql`
					UPDATE connection_capability_profiles
					SET status = 'PUBLISHED', revision = revision + 1
					WHERE id = ${profileId} AND status = 'DRAFT'
				`;
				const accessAuthorizationId = `access-baseline-${randomUUID()}`;
				await sql`
					INSERT INTO connection_access_authorizations (
						id, principal_id, connection_id, provider_release_id,
						capability_profile_id, source, external_account_fingerprint,
						state, validity_kind
					) VALUES (
						${accessAuthorizationId}, ${account.owner_principal_id},
						${account.id}, ${account.provider_release_id}, ${profileId},
						'PRE_LAUNCH_BASELINE', ${canonicalHash({
							externalAccount: account.external_account,
							providerReleaseId: account.provider_release_id,
						})}, 'ACTIVE', 'PERMANENT'
					)
				`;
				await this.auditAndEnqueue(sql, {
					actorPrincipalId,
					aggregateId: accessAuthorizationId,
					event: "connection.access-baseline.created",
				});
				baselinedConnections += 1;
			}
			await sql`
				UPDATE connection_access_enforcement
				SET state = 'ENFORCED', cutoff_at = now(), revision = revision + 1,
					updated_at = now()
				WHERE id = 'personal' AND state = 'PRE_LAUNCH'
			`;
			await this.auditAndEnqueue(sql, {
				actorPrincipalId,
				aggregateId: "personal",
				event: "connection.access-enforcement.activated",
			});
			return { baselinedConnections };
		});
	}

	async listCatalog() {
		const [profiles, policies, disclaimers] = await Promise.all([
			this.sql<
				{
					effect_ceiling: "READ" | "WRITE";
					id: string;
					name: string;
					provider_release_id: string;
					status: string;
				}[]
			>`
				SELECT id, provider_release_id, name, effect_ceiling, status
				FROM connection_capability_profiles ORDER BY name, created_at DESC
			`,
			this.sql<
				{
					capability_profile_id: string;
					id: string;
					provider_release_id: string;
					revision: string;
					material_change: boolean;
					status: string;
				}[]
			>`
				SELECT id, provider_release_id, capability_profile_id,
					status, revision::text, material_change
				FROM connection_access_policy_versions ORDER BY created_at DESC
			`,
			this.sql<
				{
					content: string;
					id: string;
					kind: string;
					locale: string;
					material_change: boolean;
					provider_id: string | null;
					status: string;
				}[]
			>`
				SELECT id, kind, locale, content, material_change, provider_id, status
				FROM connection_disclaimer_versions ORDER BY created_at DESC
			`,
		]);
		return {
			profiles: profiles.map((profile) => ({
				effectCeiling: profile.effect_ceiling,
				id: profile.id,
				name: profile.name,
				providerReleaseId: profile.provider_release_id,
				status: profile.status,
			})),
			policies: policies.map((policy) => ({
				capabilityProfileId: policy.capability_profile_id,
				id: policy.id,
				materialChange: policy.material_change,
				providerReleaseId: policy.provider_release_id,
				revision: policy.revision,
				status: policy.status,
			})),
			disclaimers: disclaimers.map((disclaimer) => ({
				content: disclaimer.content,
				id: disclaimer.id,
				kind: disclaimer.kind,
				locale: disclaimer.locale,
				materialChange: disclaimer.material_change,
				providerId: disclaimer.provider_id,
				status: disclaimer.status,
			})),
		};
	}

	async getPolicyDraft(policyVersionId: string) {
		const [row] = await this.sql<
			{ draft: ApprovalPolicyDraft & { revision: string } }[]
		>`
			SELECT jsonb_build_object(
				'id', policy.id, 'revision', policy.revision::text,
				'providerReleaseId', policy.provider_release_id,
				'capabilityProfileId', policy.capability_profile_id,
				'priority', policy.priority, 'allowPermanent', policy.allow_permanent,
				'createdByPrincipalId', policy.created_by_principal_id,
				'connectTtlSeconds', policy.connect_ttl_seconds,
				'requestTtlSeconds', policy.request_ttl_seconds,
				'renewalLeadSeconds', policy.renewal_lead_seconds,
				'defaultDurationDays', policy.default_duration_days,
				'disclaimerVersionIds', COALESCE((SELECT jsonb_agg(disclaimer_version_id ORDER BY ordinal)
					FROM connection_access_policy_disclaimers WHERE policy_version_id = policy.id), '[]'::jsonb),
				'durations', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
					'id', id, 'kind', duration_kind, 'days', duration_days)) ORDER BY id)
					FROM connection_access_policy_durations WHERE policy_version_id = policy.id), '[]'::jsonb),
				'stages', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
					'id', stage.id, 'name', stage.name, 'quorumType', stage.quorum_type,
					'quorumCount', stage.quorum_count, 'timeoutSeconds', stage.timeout_seconds,
					'approvers', COALESCE((SELECT jsonb_agg(jsonb_build_object(
						'principalId', approver_principal_id, 'displaySnapshot', display_snapshot) ORDER BY approver_principal_id)
						FROM connection_approval_stage_approvers WHERE stage_id = stage.id), '[]'::jsonb))) ORDER BY ordinal)
					FROM connection_approval_stages stage WHERE stage.policy_version_id = policy.id), '[]'::jsonb)
			) AS draft FROM connection_access_policy_versions policy
			WHERE policy.id = ${policyVersionId} AND policy.status = 'DRAFT'
		`;
		if (!row)
			throw new ConnectionError(
				"RESOURCE_NOT_FOUND",
				"Policy draft is unavailable",
			);
		const { defaultDurationDays, ...draft } = row.draft;
		return {
			...draft,
			...(defaultDurationDays == null ? {} : { defaultDurationDays }),
		};
	}

	async getPolicyStages(policyVersionId: string) {
		const stages = await this.sql<
			{
				id: string;
				name: string;
				ordinal: number;
				quorum_count: number | null;
				quorum_type: "ANY" | "ALL" | "AT_LEAST_N";
				timeout_seconds: number;
			}[]
		>`
			SELECT id, ordinal, name, quorum_type, quorum_count, timeout_seconds
			FROM connection_approval_stages
			WHERE policy_version_id = ${policyVersionId} ORDER BY ordinal
		`;
		return Promise.all(
			stages.map(async (stage) => {
				const approvers = await this.sql<{ display_snapshot: unknown }[]>`
				SELECT display_snapshot FROM connection_approval_stage_approvers
				WHERE stage_id = ${stage.id} ORDER BY approver_principal_id
			`;
				return {
					id: stage.id,
					name: stage.name,
					ordinal: stage.ordinal,
					quorumCount: stage.quorum_count,
					quorumType: stage.quorum_type,
					timeoutSeconds: stage.timeout_seconds,
					approvers: approvers.map((item) => item.display_snapshot),
				};
			}),
		);
	}

	async listPolicyApproverPrincipalIds(policyVersionId: string) {
		const rows = await this.sql<{ approver_principal_id: string }[]>`
			SELECT DISTINCT approver.approver_principal_id
			FROM connection_approval_stages stage
			JOIN connection_approval_stage_approvers approver
				ON approver.stage_id = stage.id
			WHERE stage.policy_version_id = ${policyVersionId}
			ORDER BY approver.approver_principal_id
		`;
		if (rows.length === 0) invalid("Approval policy has no approvers");
		return rows.map((row) => row.approver_principal_id);
	}

	async createCapabilityProfileDraft(input: CapabilityProfileDraft) {
		unique(input.actionVersionIds, "Capability profile actions are invalid");
		await this.sql.begin(async (sql) => {
			await sql`
				INSERT INTO connection_capability_profiles (
					id, provider_release_id, name, effect_ceiling, required_scopes,
					authorization_digest, status
				) VALUES (
					${input.id}, ${input.providerReleaseId}, ${input.name},
					'READ', '[]'::jsonb, ${`draft:${input.id}`}, 'DRAFT'
				)
			`;
			for (const actionVersionId of input.actionVersionIds) {
				await sql`
					INSERT INTO connection_capability_profile_actions (
						capability_profile_id, provider_release_id, action_version_id
					) VALUES (${input.id}, ${input.providerReleaseId}, ${actionVersionId})
				`;
			}
		});
		return { capabilityProfileId: input.id };
	}

	async publishCapabilityProfile(input: {
		actorPrincipalId: string;
		capabilityProfileId: string;
	}) {
		await this.sql.begin(async (sql) => {
			const [row] = await sql<
				{
					id: string;
					name: string;
					provider_release_id: string;
				}[]
			>`
				SELECT profile.id, profile.name, profile.provider_release_id
				FROM connection_capability_profiles profile
				WHERE profile.id = ${input.capabilityProfileId}
					AND profile.status = 'DRAFT'
					AND EXISTS (
						SELECT 1 FROM connection_capability_profile_actions action
						WHERE action.capability_profile_id = profile.id
					)
				FOR UPDATE
			`;
			if (!row) invalid("Capability profile is not publishable");
			const actions = await sql<
				{
					effect: "READ" | "WRITE";
					id: string;
					required_scopes: unknown;
					status: string;
				}[]
			>`
				SELECT action.id, action.effect, action.required_scopes, action.status
				FROM connection_capability_profile_actions member
				JOIN connection_action_versions action
					ON action.id = member.action_version_id
				WHERE member.capability_profile_id = ${row.id}
					AND action.provider_release_id = ${row.provider_release_id}
				FOR SHARE OF action
			`;
			const scopes = [
				...new Set(
					actions.flatMap((action) =>
						Array.isArray(action.required_scopes)
							? action.required_scopes.filter(
									(scope): scope is string => typeof scope === "string",
								)
							: [],
					),
				),
			].sort();
			if (
				actions.length === 0 ||
				actions.some((action) => action.status !== "PUBLISHED") ||
				actions.some(
					(action) =>
						!Array.isArray(action.required_scopes) ||
						action.required_scopes.some(
							(scope: unknown) => typeof scope !== "string",
						),
				)
			) {
				invalid(
					"Capability profile does not match published Actions and scopes",
				);
			}
			const effectCeiling = actions.some((action) => action.effect === "WRITE")
				? "WRITE"
				: "READ";
			const authorizationDigest = canonicalHash({
				actionVersionIds: actions.map((action) => action.id).sort(),
				effectCeiling,
				providerReleaseId: row.provider_release_id,
				requiredScopes: scopes,
			});
			await sql`
				UPDATE connection_capability_profiles
				SET status = 'SUPERSEDED', revision = revision + 1
				WHERE provider_release_id = ${row.provider_release_id}
					AND name = ${row.name} AND status = 'PUBLISHED'
			`;
			await sql`
				UPDATE connection_capability_profiles
				SET status = 'PUBLISHED', revision = revision + 1,
					effect_ceiling = ${effectCeiling}, required_scopes = ${sql.json(scopes)},
					authorization_digest = ${authorizationDigest}
				WHERE id = ${input.capabilityProfileId} AND status = 'DRAFT'
			`;
			await this.auditAndEnqueue(sql, {
				actorPrincipalId: input.actorPrincipalId,
				aggregateId: input.capabilityProfileId,
				event: "connection.capability-profile.published",
			});
		});
	}

	async createDisclaimerDraft(input: DisclaimerDraft) {
		await this.sql`
			INSERT INTO connection_disclaimer_versions (
				id, kind, provider_id, locale, content, content_sha256,
				owner_metadata, material_change, status
			) VALUES (
				${input.id}, ${input.kind}, ${input.providerId ?? null}, ${input.locale},
				${input.content}, ${createHash("sha256").update(input.content, "utf8").digest("hex")},
				${this.sql.json({ ...input.ownerMetadata })},
				${input.materialChange}, 'DRAFT'
			)
		`;
		return { disclaimerVersionId: input.id };
	}

	async publishDisclaimer(input: {
		actorPrincipalId: string;
		disclaimerVersionId: string;
	}) {
		await this.sql.begin(async (sql) => {
			const rows = await sql`
				UPDATE connection_disclaimer_versions
				SET status = 'PUBLISHED', published_at = now(), revision = revision + 1
				WHERE id = ${input.disclaimerVersionId} AND status = 'DRAFT'
			`;
			if (rows.count !== 1) invalid("Disclaimer version is not publishable");
			await this.auditAndEnqueue(sql, {
				actorPrincipalId: input.actorPrincipalId,
				aggregateId: input.disclaimerVersionId,
				event: "connection.disclaimer.published",
			});
		});
	}

	createPolicyDraft(input: ApprovalPolicyDraft) {
		return this.savePolicyDraft(input);
	}

	updatePolicyDraft(input: ApprovalPolicyDraft & { expectedRevision: string }) {
		if (!/^[1-9][0-9]*$/.test(input.expectedRevision))
			invalid("Draft revision is invalid");
		return this.savePolicyDraft(input, input.expectedRevision);
	}

	private async savePolicyDraft(
		input: ApprovalPolicyDraft,
		expectedRevision?: string,
	) {
		validateApprovalPolicyDraft(input);
		await this.sql.begin(async (sql) => {
			if (expectedRevision) {
				const [actor] = await sql<{ id: string }[]>`
					SELECT principal.id FROM connection_principals principal
					JOIN connection_principal_roles role_binding ON role_binding.principal_id = principal.id
					WHERE principal.id = ${input.createdByPrincipalId} AND principal.status = 'ACTIVE'
						AND role_binding.role = 'CONNECTION_ADMIN' AND role_binding.status = 'ACTIVE'
					FOR SHARE OF principal, role_binding
				`;
				if (!actor)
					invalid("Draft actor is not an active Connection administrator");
				const updated = await sql`
					UPDATE connection_access_policy_versions SET
						provider_release_id = ${input.providerReleaseId}, capability_profile_id = ${input.capabilityProfileId},
						priority = ${input.priority}, default_duration_days = ${input.defaultDurationDays ?? null},
						allow_permanent = ${input.allowPermanent}, request_ttl_seconds = ${input.requestTtlSeconds},
						connect_ttl_seconds = ${input.connectTtlSeconds}, renewal_lead_seconds = ${input.renewalLeadSeconds},
						revision = revision + 1
					WHERE id = ${input.id} AND status = 'DRAFT' AND revision::text = ${expectedRevision}
				`;
				if (updated.count !== 1)
					invalid("Draft is unavailable or its revision changed");
				await sql`DELETE FROM connection_approval_stage_approvers WHERE policy_version_id = ${input.id}`;
				await sql`DELETE FROM connection_approval_stages WHERE policy_version_id = ${input.id}`;
				await sql`DELETE FROM connection_access_policy_disclaimers WHERE policy_version_id = ${input.id}`;
				await sql`DELETE FROM connection_access_policy_durations WHERE policy_version_id = ${input.id}`;
			} else {
				await sql`
				INSERT INTO connection_access_policy_versions (
					id, provider_release_id, capability_profile_id, priority,
					default_duration_days, allow_permanent, request_ttl_seconds,
					connect_ttl_seconds, renewal_lead_seconds, status,
					created_by_principal_id
				) VALUES (
					${input.id}, ${input.providerReleaseId}, ${input.capabilityProfileId},
					${input.priority}, ${input.defaultDurationDays ?? null},
					${input.allowPermanent}, ${input.requestTtlSeconds},
					${input.connectTtlSeconds}, ${input.renewalLeadSeconds}, 'DRAFT',
					${input.createdByPrincipalId}
				)
			`;
			}
			for (const duration of input.durations) {
				await sql`
					INSERT INTO connection_access_policy_durations (
						id, policy_version_id, duration_kind, duration_days
					) VALUES (
						${duration.id}, ${input.id}, ${duration.kind},
						${duration.kind === "FINITE" ? duration.days : null}
					)
				`;
			}
			for (const [
				index,
				disclaimerVersionId,
			] of input.disclaimerVersionIds.entries()) {
				await sql`
					INSERT INTO connection_access_policy_disclaimers (
						policy_version_id, disclaimer_version_id, ordinal
					) VALUES (${input.id}, ${disclaimerVersionId}, ${index + 1})
				`;
			}
			for (const [index, stage] of input.stages.entries()) {
				await sql`
					INSERT INTO connection_approval_stages (
						id, policy_version_id, ordinal, name, quorum_type,
						quorum_count, timeout_seconds
					) VALUES (
						${stage.id}, ${input.id}, ${index + 1}, ${stage.name},
						${stage.quorumType}, ${stage.quorumCount ?? null},
						${stage.timeoutSeconds}
					)
				`;
				for (const approver of stage.approvers) {
					await sql`
						INSERT INTO connection_approval_stage_approvers (
							policy_version_id, stage_id, approver_principal_id, display_snapshot
						) VALUES (
							${input.id}, ${stage.id}, ${approver.principalId},
							${sql.json({ ...approver.displaySnapshot })}
						)
					`;
				}
			}
			if (expectedRevision)
				await this.auditAndEnqueue(sql, {
					actorPrincipalId: input.createdByPrincipalId,
					aggregateId: input.id,
					event: "connection.access-policy.draft-updated",
				});
		});
		return { policyVersionId: input.id };
	}

	async publishPolicy(input: {
		actorPrincipalId: string;
		materialChange?: boolean;
		policyVersionId: string;
		reapprovalDeadlineAt?: string;
		reason?: string;
	}) {
		if (input.materialChange) {
			if (
				!input.reapprovalDeadlineAt ||
				!input.reason?.trim() ||
				input.reason.length > 1_000
			)
				invalid(
					"Material policy replacement requires a reapproval deadline and reason",
				);
		} else if (input.reapprovalDeadlineAt || input.reason) {
			invalid("Non-material policy replacement cannot schedule reapproval");
		}
		await this.sql.begin(async (sql) => {
			const [policy] = await sql<PolicyRow[]>`
				SELECT status, provider_release_id, capability_profile_id,
					allow_permanent, default_duration_days
				FROM connection_access_policy_versions
				WHERE id = ${input.policyVersionId}
				FOR UPDATE
			`;
			if (policy?.status !== "DRAFT") {
				invalid("Approval policy is not publishable");
			}
			const [previous] = await sql<{ id: string }[]>`
				SELECT id FROM connection_access_policy_versions
				WHERE provider_release_id = ${policy.provider_release_id}
					AND capability_profile_id = ${policy.capability_profile_id}
					AND status = 'PUBLISHED'
				FOR UPDATE
			`;
			const [validation] = await sql<
				{
					duration_count: number;
					global_disclaimer_count: number;
					invalid_disclaimer_count: number;
					invalid_stage_count: number;
					profile_published: boolean;
					stage_count: number;
				}[]
			>`
				SELECT
					(SELECT count(*)::int FROM connection_access_policy_durations
					 WHERE policy_version_id = ${input.policyVersionId}) AS duration_count,
					(SELECT count(*)::int FROM connection_access_policy_disclaimers link
					 JOIN connection_disclaimer_versions disclaimer
						ON disclaimer.id = link.disclaimer_version_id
					 WHERE link.policy_version_id = ${input.policyVersionId}
						AND disclaimer.kind = 'GLOBAL' AND disclaimer.status = 'PUBLISHED')
						AS global_disclaimer_count,
					(SELECT count(*)::int FROM connection_access_policy_disclaimers link
					 JOIN connection_disclaimer_versions disclaimer
						ON disclaimer.id = link.disclaimer_version_id
					 WHERE link.policy_version_id = ${input.policyVersionId}
						AND disclaimer.status <> 'PUBLISHED') AS invalid_disclaimer_count,
					(SELECT count(*)::int FROM connection_approval_stages stage
					 WHERE stage.policy_version_id = ${input.policyVersionId}
						AND (
							(SELECT count(*) FROM connection_approval_stage_approvers approver
							 WHERE approver.stage_id = stage.id) NOT BETWEEN 1 AND 50
							OR (stage.quorum_type = 'AT_LEAST_N' AND stage.quorum_count >
								(SELECT count(*) FROM connection_approval_stage_approvers approver
								 WHERE approver.stage_id = stage.id))
						)) AS invalid_stage_count,
					EXISTS (
						SELECT 1 FROM connection_capability_profiles profile
						WHERE profile.id = ${policy.capability_profile_id}
							AND profile.provider_release_id = ${policy.provider_release_id}
							AND profile.status = 'PUBLISHED'
					) AS profile_published,
					(SELECT count(*)::int FROM connection_approval_stages
					 WHERE policy_version_id = ${input.policyVersionId}) AS stage_count
			`;
			if (
				!validation?.profile_published ||
				validation.stage_count < 1 ||
				validation.stage_count > 10 ||
				validation.invalid_stage_count > 0 ||
				validation.duration_count < 1 ||
				validation.global_disclaimer_count < 1 ||
				validation.invalid_disclaimer_count > 0
			) {
				invalid("Approval policy dependencies are not publishable");
			}
			const [newMaterialDisclaimer] = await sql<{ present: boolean }[]>`
				SELECT EXISTS (
					SELECT 1 FROM connection_access_policy_disclaimers bundle
					JOIN connection_disclaimer_versions disclaimer
						ON disclaimer.id = bundle.disclaimer_version_id
					WHERE bundle.policy_version_id = ${input.policyVersionId}
						AND disclaimer.material_change = true
						AND NOT EXISTS (
							SELECT 1 FROM connection_access_policy_disclaimers previous
							JOIN connection_access_policy_versions policy
								ON policy.id = previous.policy_version_id
							WHERE previous.disclaimer_version_id = disclaimer.id
								AND policy.provider_release_id = ${policy.provider_release_id}
								AND policy.capability_profile_id = ${policy.capability_profile_id}
								AND policy.status = 'PUBLISHED'
						)
				) AS present
			`;
			if (newMaterialDisclaimer?.present && !input.materialChange)
				invalid("Material disclaimer requires reapproval");
			if (previous && !input.materialChange) {
				const semantics = await sql<{ id: string; content: unknown }[]>`
					SELECT policy.id, jsonb_build_object(
						'priority', policy.priority,
						'permanent', policy.allow_permanent,
						'defaultDays', policy.default_duration_days,
						'renewalLead', policy.renewal_lead_seconds,
						'durations', (
							SELECT jsonb_agg(jsonb_build_array(duration_kind, duration_days)
								ORDER BY duration_kind, duration_days)
							FROM connection_access_policy_durations
							WHERE policy_version_id = policy.id
						),
						'stages', (
							SELECT jsonb_agg(jsonb_build_object(
								'ordinal', stage.ordinal,
								'quorum', stage.quorum_type,
								'count', stage.quorum_count,
								'approvers', (
									SELECT jsonb_agg(approver.approver_principal_id
										ORDER BY approver.approver_principal_id)
									FROM connection_approval_stage_approvers approver
									WHERE approver.stage_id = stage.id
								)
							) ORDER BY stage.ordinal)
							FROM connection_approval_stages stage
							WHERE stage.policy_version_id = policy.id
						)
					) AS content
					FROM connection_access_policy_versions policy
					WHERE policy.id IN (${previous.id}, ${input.policyVersionId})
				`;
				if (
					semantics.length !== 2 ||
					canonicalHash(semantics[0]?.content) !==
						canonicalHash(semantics[1]?.content)
				)
					invalid("Policy authorization semantics require reapproval");
			}
			await sql`
				UPDATE connection_access_policy_versions
				SET status = 'SUPERSEDED', revision = revision + 1
				WHERE provider_release_id = ${policy.provider_release_id}
					AND capability_profile_id = ${policy.capability_profile_id}
					AND status = 'PUBLISHED'
			`;
			await sql`
				UPDATE connection_access_policy_versions
				SET status = 'PUBLISHED', material_change = ${input.materialChange === true},
					published_at = now(), revision = revision + 1
				WHERE id = ${input.policyVersionId} AND status = 'DRAFT'
			`;
			if (input.materialChange && input.reapprovalDeadlineAt && input.reason) {
				await PostgresConnectionAccessRequestRepository.createReapprovalCampaignInTransaction(
					sql,
					{
						actorPrincipalId: input.actorPrincipalId,
						capabilityProfileId: policy.capability_profile_id,
						deadlineAt: input.reapprovalDeadlineAt,
						id: `${input.policyVersionId}:reapproval`,
						providerReleaseId: policy.provider_release_id,
						reason: input.reason,
						triggerKind: "POLICY",
						triggerVersionId: input.policyVersionId,
					},
				);
			}
			await this.auditAndEnqueue(sql, {
				actorPrincipalId: input.actorPrincipalId,
				aggregateId: input.policyVersionId,
				event: "connection.access-policy.published",
			});
		});
	}

	async revokePolicy(input: {
		actorPrincipalId: string;
		expectedRevision: string;
		policyVersionId: string;
		reason: string;
	}) {
		const reason = input.reason.trim();
		if (!reason || reason.length > 1_000)
			invalid("Policy revocation reason is invalid");
		return this.sql.begin(async (sql) => {
			const [admin] = await sql<{ id: string }[]>`
				SELECT principal.id FROM connection_principals principal
				JOIN connection_principal_roles role_binding ON role_binding.principal_id = principal.id
				WHERE principal.id = ${input.actorPrincipalId} AND principal.status = 'ACTIVE'
					AND role_binding.role = 'CONNECTION_ADMIN' AND role_binding.status = 'ACTIVE'
				FOR SHARE OF principal, role_binding
			`;
			if (!admin)
				throw new ConnectionError("FORBIDDEN", "Administrator required");
			const [policy] = await sql<
				{
					capability_profile_id: string;
					provider_release_id: string;
					revision: string;
					status: string;
				}[]
			>`
				SELECT provider_release_id, capability_profile_id, status, revision::text
				FROM connection_access_policy_versions WHERE id = ${input.policyVersionId}
				FOR UPDATE
			`;
			if (
				policy?.status !== "PUBLISHED" ||
				policy.revision !== input.expectedRevision
			)
				throw new ConnectionError(
					"IDEMPOTENCY_CONFLICT",
					"Approval policy changed",
				);
			const revoked = await sql<{ id: string }[]>`
				UPDATE connection_access_policy_versions
				SET status = 'REVOKED', revision = revision + 1
				WHERE provider_release_id = ${policy.provider_release_id}
					AND capability_profile_id = ${policy.capability_profile_id}
					AND status IN ('PUBLISHED', 'SUPERSEDED')
				RETURNING id
			`;
			for (const version of revoked) {
				await this.auditAndEnqueue(sql, {
					actorPrincipalId: input.actorPrincipalId,
					aggregateId: version.id,
					event: "connection.access-policy.revoked",
					reason,
				});
			}
			const requests = await sql<{ id: string }[]>`
				SELECT id FROM connection_access_requests
				WHERE provider_release_id = ${policy.provider_release_id}
					AND capability_profile_id = ${policy.capability_profile_id}
					AND state IN ('SUBMITTED', 'IN_REVIEW', 'ROUTING_BLOCKED',
						'APPROVED_PENDING_CONNECTION')
				ORDER BY id FOR UPDATE
			`;
			for (const request of requests) {
				await sql`
					UPDATE connection_request_stages
					SET state = 'SKIPPED_BY_CANCEL', completed_at = now(), revision = revision + 1
					WHERE request_id = ${request.id} AND state IN ('PENDING', 'NOT_STARTED')
				`;
				await sql`
					UPDATE connection_authorization_renewals
					SET status = 'CANCELED', completed_at = now()
					WHERE request_id = ${request.id} AND status = 'PENDING'
				`;
				await sql`
					UPDATE connection_connect_permits SET expires_at = now()
					WHERE request_id = ${request.id} AND consumed_at IS NULL
				`;
				await sql`
					UPDATE connection_access_requests
					SET state = 'CANCELED', current_stage_ordinal = NULL,
						revision = revision + 1, updated_at = now()
					WHERE id = ${request.id}
				`;
				await syncApprovalProjections(sql, request.id, "POLICY_REVOKED", false);
				await this.auditAndEnqueue(sql, {
					actorPrincipalId: input.actorPrincipalId,
					aggregateId: request.id,
					event: "connection.access-request.policy-revoked",
					reason,
				});
			}
			const authorizations = await sql<
				{
					account_id: string;
					id: string;
					owner_principal_id: string;
					provider_id: string;
				}[]
			>`
				SELECT access.id, account.id AS account_id,
					account.owner_principal_id, account.provider_id
				FROM connection_accounts account
				JOIN connection_access_authorizations access
					ON access.connection_id = account.id
				WHERE account.owner_type = 'PERSONAL'
					AND access.provider_release_id = ${policy.provider_release_id}
					AND access.capability_profile_id = ${policy.capability_profile_id}
					AND access.state IN ('ACTIVE', 'REAPPROVAL_REQUIRED', 'DISCONNECTED')
				ORDER BY account.id FOR UPDATE OF account, access
			`;
			for (const authorization of authorizations) {
				const [updated] = await sql<{ revision: string }[]>`
					UPDATE connection_access_authorizations
					SET state = 'SUSPENDED', reapproval_deadline_at = NULL,
						revision = revision + 1, updated_at = now()
					WHERE id = ${authorization.id}
					RETURNING revision::text
				`;
				await sql`
					UPDATE connection_accounts
					SET revision = revision + 1, execution_fence = execution_fence + 1
					WHERE id = ${authorization.account_id}
				`;
				await sql`
					UPDATE connection_grants SET status = 'PAUSED_CONNECTION'
					WHERE connection_id = ${authorization.account_id} AND status = 'ACTIVE'
				`;
				await sql`
					UPDATE connection_work_items
					SET status = 'CANCELED', completed_at = now(), updated_at = now()
					WHERE business_type = 'CONNECTION_ACCESS_AUTHORIZATION'
						AND business_id = ${authorization.id} AND status = 'OPEN'
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
							${authorization.owner_principal_id}, 'CONNECTION_ACCESS_AUTHORIZATION',
							${authorization.id}, ${updated?.revision ?? "1"}, 'POLICY_REVOKED',
							${sql.json({ providerId: authorization.provider_id, state: "SUSPENDED" })}
						)
						RETURNING id, recipient_principal_id
					)
					INSERT INTO connection_notification_receipts (notification_id, recipient_principal_id)
					SELECT id, recipient_principal_id FROM created
				`;
				await this.auditAndEnqueue(sql, {
					actorPrincipalId: input.actorPrincipalId,
					aggregateId: authorization.id,
					event: "connection.access-authorization.policy-suspended",
					reason,
				});
			}
			return {
				policyVersionId: input.policyVersionId,
				canceledRequests: requests.length,
				suspendedConnections: authorizations.length,
			};
		});
	}

	private async auditAndEnqueue(
		sql: postgres.TransactionSql,
		input: {
			actorPrincipalId: string;
			aggregateId: string;
			event: string;
			reason?: string;
		},
	) {
		await sql`
			INSERT INTO connection_audit_records (principal_id, event, detail)
			VALUES (
				${input.actorPrincipalId}, ${input.event},
				${sql.json({ aggregateId: input.aggregateId, ...(input.reason ? { reason: input.reason } : {}) })}
			)
		`;
		await sql`
			INSERT INTO connection_outbox_events (
				id, topic, aggregate_id, payload
			) VALUES (
				${`${input.aggregateId}:${input.event}`}, ${input.event},
				${input.aggregateId}, ${sql.json({ aggregateId: input.aggregateId })}
			)
		`;
	}
}
