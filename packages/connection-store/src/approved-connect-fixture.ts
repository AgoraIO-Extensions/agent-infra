import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";

// Integration-only seed for tests whose subject is downstream Connection behavior.
export async function seedApprovedConnectPermit(
	sql: Sql,
	input: {
		principalId: string;
		actionVersionIds?: readonly string[];
		renewalApproverId?: string;
		providerReleaseId: string;
		scopes: readonly string[];
	},
) {
	const suffix = randomUUID();
	const profileId = `fixture-profile-${suffix}`;
	const policyId = `fixture-policy-${suffix}`;
	const requestId = `fixture-request-${suffix}`;
	await sql`
		INSERT INTO connection_capability_profiles (
			id, provider_release_id, name, effect_ceiling,
			required_scopes, authorization_digest, status
		) VALUES (
			${profileId}, ${input.providerReleaseId}, ${profileId}, 'WRITE',
			${sql.json([...input.scopes])}, ${suffix}, 'DRAFT'
		)
	`;
	await sql`
		INSERT INTO connection_capability_profile_actions (
			capability_profile_id, provider_release_id, action_version_id
		)
		SELECT ${profileId}, action.provider_release_id, action.id
		FROM connection_action_versions action
		WHERE action.provider_release_id = ${input.providerReleaseId}
			AND action.status = 'PUBLISHED'
			AND action.required_scopes <@ ${sql.json([...input.scopes])}::jsonb
			AND (${input.actionVersionIds ? sql.json([...input.actionVersionIds]) : null}::jsonb IS NULL
				OR ${sql.json([...(input.actionVersionIds ?? [])])}::jsonb @> jsonb_build_array(action.id))
	`;
	await sql`
		UPDATE connection_capability_profiles
		SET status = 'PUBLISHED', revision = revision + 1
		WHERE id = ${profileId}
	`;
	await sql`
		INSERT INTO connection_access_policy_versions (
			id, provider_release_id, capability_profile_id, priority,
			allow_permanent, request_ttl_seconds, connect_ttl_seconds,
			renewal_lead_seconds, status, created_by_principal_id, published_at
		) VALUES (
			${policyId}, ${input.providerReleaseId}, ${profileId}, 100,
			true, 86400, 86400, ${input.renewalApproverId ? 2592000 : 0},
			${input.renewalApproverId ? "DRAFT" : "PUBLISHED"}, ${input.principalId},
			CASE WHEN ${Boolean(input.renewalApproverId)} THEN NULL ELSE now() END
		)
	`;
	if (input.renewalApproverId) {
		const stageId = `fixture-stage-${suffix}`;
		await sql`INSERT INTO connection_access_policy_durations (id, policy_version_id, duration_kind, duration_days)
			VALUES (${`fixture-duration-${suffix}`}, ${policyId}, 'FINITE', 90)`;
		await sql`INSERT INTO connection_approval_stages (id, policy_version_id, ordinal, name, quorum_type, timeout_seconds)
			VALUES (${stageId}, ${policyId}, 1, 'Renewal review', 'ANY', 86400)`;
		await sql`INSERT INTO connection_approval_stage_approvers (policy_version_id, stage_id, approver_principal_id, display_snapshot)
			VALUES (${policyId}, ${stageId}, ${input.renewalApproverId}, '{}'::jsonb)`;
		await sql`UPDATE connection_access_policy_versions SET status = 'PUBLISHED', published_at = now(), revision = revision + 1 WHERE id = ${policyId}`;
	}
	await sql`
		INSERT INTO connection_access_requests (
			id, applicant_principal_id, provider_release_id,
			capability_profile_id, policy_version_id, purpose, duration_kind,
			state, expires_at, connect_expires_at
		) VALUES (
			${requestId}, ${input.principalId}, ${input.providerReleaseId},
			${profileId}, ${policyId}, 'Downstream integration fixture', 'PERMANENT',
			'APPROVED_PENDING_CONNECTION', now() + interval '1 day',
			now() + interval '1 day'
		)
	`;
	await sql`
		INSERT INTO connection_connect_permits (id, request_id, expires_at)
		VALUES (${`fixture-permit-${suffix}`}, ${requestId}, now() + interval '1 day')
	`;
	return requestId;
}
