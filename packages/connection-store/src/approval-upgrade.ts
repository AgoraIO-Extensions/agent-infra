import { randomUUID } from "node:crypto";
import { ConnectionError, canonicalHash } from "@agent-infra/connection-core";
import type postgres from "postgres";

// The caller holds the account/current-credential locks and verifies credential CAS.
export async function migrateCompatibleApproval(
	sql: postgres.TransactionSql,
	input: {
		connectionId: string;
		principalId: string;
		externalAccount: string;
		fromReleaseId: string;
		toReleaseId: string;
	},
) {
	const denied = () => {
		throw new ConnectionError(
			"FORBIDDEN",
			"Provider upgrade requires approval: authorization equivalence is not proven",
		);
	};
	const [access] = await sql<
		{
			id: string;
			capability_profile_id: string;
		}[]
	>`
		SELECT access.id, access.capability_profile_id
		FROM connection_effective_access_authorizations access
		WHERE access.connection_id = ${input.connectionId}
			AND access.principal_id = ${input.principalId}
			AND access.provider_release_id = ${input.fromReleaseId}
			AND access.external_account_fingerprint = ${canonicalHash({
				externalAccount: input.externalAccount,
				providerReleaseId: input.fromReleaseId,
			})}
			AND (access.state = 'ACTIVE' OR (
				access.state = 'REAPPROVAL_REQUIRED' AND access.reapproval_deadline_at > now()
			))
			AND (access.valid_until IS NULL OR access.valid_until > now())
		FOR UPDATE OF access
	`;
	if (!access) return denied();
	const [release] = await sql<{ id: string }[]>`
		SELECT target.id FROM connection_provider_releases source
		JOIN connection_provider_releases target ON target.id = ${input.toReleaseId}
		WHERE source.id = ${input.fromReleaseId}
			AND source.provider = target.provider
			AND source.status = 'PUBLISHED' AND target.status = 'PUBLISHED'
			AND source.auth_profile = target.auth_profile
			AND source.deployment_profile = target.deployment_profile
			AND source.executor_digest = target.executor_digest
			AND source.executor_digest ~ '^sha256:[a-f0-9]{64}$'
		FOR SHARE OF source, target
	`;
	if (!release) return denied();
	const [profile] = await sql<
		{
			effect_ceiling: string;
			required_scopes: postgres.JSONValue;
		}[]
	>`
		SELECT effect_ceiling, required_scopes FROM connection_capability_profiles
		WHERE id = ${access.capability_profile_id}
			AND provider_release_id = ${input.fromReleaseId}
			AND status IN ('PUBLISHED', 'SUPERSEDED')
		FOR SHARE
	`;
	if (!profile) return denied();
	const sourceActions = await sql<{ id: string }[]>`
		SELECT action.id FROM connection_capability_profile_actions member
		JOIN connection_action_versions action ON action.id = member.action_version_id
		WHERE member.capability_profile_id = ${access.capability_profile_id}
		FOR SHARE OF action
	`;
	const mapping = await sql<{ source_id: string; target_id: string }[]>`
		SELECT source.id AS source_id, target.id AS target_id
		FROM connection_capability_profile_actions member
		JOIN connection_action_versions source ON source.id = member.action_version_id
		JOIN connection_action_versions target ON target.provider_release_id = ${input.toReleaseId}
			AND target.name = source.name AND target.effect = source.effect
			AND target.input_schema = source.input_schema
			AND target.required_scopes = source.required_scopes
			AND target.description = source.description
		WHERE member.capability_profile_id = ${access.capability_profile_id}
			AND source.status = 'PUBLISHED' AND target.status = 'PUBLISHED'
		FOR SHARE OF source, target
	`;
	if (
		sourceActions.length === 0 ||
		mapping.length !== sourceActions.length ||
		new Set(mapping.map((item) => item.source_id)).size !==
			sourceActions.length ||
		new Set(mapping.map((item) => item.target_id)).size !== sourceActions.length
	)
		return denied();
	const profileId = `upgrade-profile-${randomUUID()}`;
	const actionVersionIds = mapping.map((item) => item.target_id).sort();
	await sql`
		INSERT INTO connection_capability_profiles (
			id, provider_release_id, name, effect_ceiling, required_scopes,
			authorization_digest, status
		) VALUES (
			${profileId}, ${input.toReleaseId}, ${profileId}, ${profile.effect_ceiling},
			${sql.json(profile.required_scopes)}, ${canonicalHash({
				actionVersionIds,
				effectCeiling: profile.effect_ceiling,
				providerReleaseId: input.toReleaseId,
				requiredScopes: profile.required_scopes,
			})}, 'DRAFT'
		)
	`;
	for (const actionId of actionVersionIds) {
		await sql`
			INSERT INTO connection_capability_profile_actions (
				capability_profile_id, provider_release_id, action_version_id
			) VALUES (${profileId}, ${input.toReleaseId}, ${actionId})
		`;
	}
	await sql`
		UPDATE connection_capability_profiles SET status = 'PUBLISHED', revision = revision + 1
		WHERE id = ${profileId}
	`;
	await sql`
		UPDATE connection_access_authorizations
		SET upgraded_provider_release_id = ${input.toReleaseId},
			upgraded_capability_profile_id = ${profileId},
			upgraded_external_account_fingerprint = ${canonicalHash({
				externalAccount: input.externalAccount,
				providerReleaseId: input.toReleaseId,
			})}, revision = revision + 1, updated_at = now()
		WHERE id = ${access.id}
	`;
	await sql`
		INSERT INTO connection_audit_records (principal_id, event, detail)
		VALUES (${input.principalId}, 'CONNECTION_APPROVAL_COMPATIBLE_UPGRADE', ${sql.json(
			{
				accessAuthorizationId: access.id,
				connectionId: input.connectionId,
				fromReleaseId: input.fromReleaseId,
				toReleaseId: input.toReleaseId,
				fromProfileId: access.capability_profile_id,
				toProfileId: profileId,
				proof: "IDENTICAL_EXECUTOR_AUTH_DEPLOYMENT_AND_APPROVED_ACTIONS",
				mapping,
			},
		)})
	`;
}
