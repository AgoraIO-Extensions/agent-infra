import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";

// Integration-only seed for tests whose subject is downstream Connection behavior.
export async function seedApprovedConnectPermit(
	sql: Sql,
	input: {
		principalId: string;
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
			true, 86400, 86400, 0, 'PUBLISHED', ${input.principalId}, now()
		)
	`;
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
