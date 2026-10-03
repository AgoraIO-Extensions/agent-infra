import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
	type PendingConnectRuntime,
	PostgresConnectionAccessRequestRepository,
} from "./access-request-repository";
import { seedApprovedConnectPermit } from "./approved-connect-fixture";
import { migrateConnectionDatabase } from "./migrations";
import {
	PostgresConnectionRepository,
	type PublishedProviderCatalog,
} from "./repository";
import { assertIsolatedTestDatabaseUrl } from "./test-database";

const databaseUrl = process.env.CONNECTION_TEST_DATABASE_URL;
assertIsolatedTestDatabaseUrl(databaseUrl, process.env.DATABASE_URL);
if (process.env.CI && !databaseUrl)
	throw new Error("Pending connect test database required");
const integration = databaseUrl ? it : it.skip;

async function fixture() {
	if (!databaseUrl) throw new Error("Test database required");
	await migrateConnectionDatabase(
		databaseUrl,
		resolve(import.meta.dirname, "../../../migrations/connection"),
	);
	const sql = postgres(databaseUrl);
	const repository = new PostgresConnectionRepository(
		databaseUrl,
		Buffer.alloc(32, 23),
	);
	const suffix = randomUUID();
	const principalId = `pending-owner-${suffix}`;
	const strangerId = `pending-stranger-${suffix}`;
	const provider = `pending-${suffix}`;
	const source: PublishedProviderCatalog = {
		provider,
		providerReleaseId: `${provider}-connection-v1`,
		sourceCommit: "test-source",
		executorDigest: `sha256:${"a".repeat(64)}`,
		authProfile: { credential: "personal-pat" },
		deploymentProfile: { apiOrigin: "https://provider.example" },
		actions: [
			{
				id: `${provider}.read@v1`,
				name: `${provider}.read`,
				effect: "READ",
				description: "Read approved item",
				inputSchema: {
					required: [],
					type: "object",
					properties: {},
					additionalProperties: false,
				},
				requiredScopes: ["read"],
			},
		],
	};
	const sourceRead = source.actions[0];
	if (!sourceRead) throw new Error("Missing source fixture");
	const target: PublishedProviderCatalog = {
		...source,
		providerReleaseId: `${provider}-connection-v2`,
		executorDigest: `sha256:${"b".repeat(64)}`,
		actions: [
			{ ...sourceRead, id: `${provider}.read@v2` },
			{
				id: `${provider}.extra@v2`,
				name: `${provider}.extra`,
				effect: "WRITE",
				description: "Unapproved extra",
				inputSchema: { type: "object", properties: {}, required: [] },
				requiredScopes: ["extra"],
			},
		],
	};
	const proof = {
		provider,
		fromReleaseId: source.providerReleaseId,
		toReleaseId: target.providerReleaseId,
		fromExecutorDigest: source.executorDigest,
		toExecutorDigest: target.executorDigest,
		rationale: "Compatible executor repair",
		reviewReference: "https://review.example/repair",
	};
	const runtime: PendingConnectRuntime = {
		providerReleases: new Map([[provider, source.providerReleaseId]]),
		authorizationCompatibility: new Map(),
	};
	const requests = new PostgresConnectionAccessRequestRepository(
		databaseUrl,
		undefined,
		runtime,
	);
	await repository.publishProviderCatalog(source);
	await sql`INSERT INTO connection_principals (id, display_name) VALUES (${principalId}, 'Pending owner'), (${strangerId}, 'Pending stranger')`;
	const requestId = await seedApprovedConnectPermit(sql, {
		principalId,
		providerReleaseId: source.providerReleaseId,
		scopes: ["read"],
		actionVersionIds: source.actions.map((action) => action.id),
	});
	async function publish(catalog: PublishedProviderCatalog) {
		await repository.publishProviderCatalog(catalog);
		(runtime.providerReleases as Map<string, string>).set(
			provider,
			catalog.providerReleaseId,
		);
		(
			runtime.authorizationCompatibility as Map<
				string,
				NonNullable<PublishedProviderCatalog["authorizationCompatibility"]>
			>
		).set(catalog.providerReleaseId, catalog.authorizationCompatibility ?? []);
	}
	const candidate = (providerReleaseId = target.providerReleaseId) => ({
		accessRequestId: requestId,
		accessToken: "test-pat",
		displayName: "Proven account",
		externalAccount: "account-1",
		grantedScopes: ["read"],
		principalId,
		providerId: provider,
		providerReleaseId,
	});
	return {
		sql,
		repository,
		requests,
		source,
		target,
		proof,
		runtime,
		principalId,
		strangerId,
		requestId,
		candidate,
		publish,
		close: async () => {
			await requests.close();
			await repository.close();
			await sql.end();
		},
	};
}

describe("pending approved requests across Provider releases", () => {
	integration(
		"ordinary policy supersession preserves same-release approval and expiry",
		async () => {
			const f = await fixture();
			try {
				const before = await f.requests.getRequest(f.principalId, f.requestId);
				await f.sql`UPDATE connection_access_policy_versions SET status='SUPERSEDED', revision=revision+1 WHERE id=(SELECT policy_version_id FROM connection_access_requests WHERE id=${f.requestId})`;
				expect(
					await f.requests.prepareConnect(f.principalId, f.requestId),
				).toMatchObject({ providerReleaseId: f.source.providerReleaseId });
				expect(
					await f.requests.getRequest(f.principalId, f.requestId),
				).toMatchObject({
					state: "APPROVED_PENDING_CONNECTION",
					connectExpiresAt: before.connectExpiresAt,
					providerReleaseId: f.source.providerReleaseId,
					connectReadiness: { status: "READY" },
				});
			} finally {
				await f.close();
			}
		},
	);
	integration(
		"unproven new release blocks prepare and direct credential storage without invalidating history",
		async () => {
			const f = await fixture();
			try {
				await f.publish(f.target);
				const projected = await f.requests.getRequest(
					f.principalId,
					f.requestId,
				);
				expect(projected).toMatchObject({
					state: "APPROVED_PENDING_CONNECTION",
					providerReleaseId: f.source.providerReleaseId,
					connectReadiness: {
						status: "REAPPLY_REQUIRED",
						targetProviderReleaseId: f.target.providerReleaseId,
					},
				});
				await expect(
					f.requests.prepareConnect(f.principalId, f.requestId),
				).rejects.toMatchObject({ code: "INVALID_REQUEST" });
				await expect(
					f.repository.validatePersonalConnectRequest({
						principalId: f.principalId,
						providerId: f.target.provider,
						requestId: f.requestId,
					}),
				).rejects.toMatchObject({ code: "INVALID_REQUEST" });
				await expect(
					f.requests.getRequest(f.strangerId, f.requestId),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				const [old] =
					await f.sql`SELECT capability_profile_id, policy_version_id FROM connection_access_requests WHERE id=${f.requestId}`;
				if (!old) throw new Error("Missing source approval fixture");
				await expect(
					f.requests.createRequest({
						id: `new-old-${randomUUID()}`,
						applicantPrincipalId: f.principalId,
						providerReleaseId: f.source.providerReleaseId,
						capabilityProfileId: old.capability_profile_id,
						policyVersionId: old.policy_version_id,
						presentationId: "stale-presentation",
						purpose: "New connection",
						duration: { kind: "PERMANENT" },
						disclaimerConfirmations: [],
					}),
				).rejects.toMatchObject({
					code: "INVALID_REQUEST",
					message: "Approval policy does not match the requested capability",
				});
				await expect(
					f.repository.storeProviderCredential(f.candidate()),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				const [account] =
					await f.sql`SELECT count(*)::int AS count FROM connection_accounts WHERE owner_principal_id=${f.principalId}`;
				expect(account?.count).toBe(0);
				expect(
					(await f.requests.getRequest(f.principalId, f.requestId)).state,
				).toBe("APPROVED_PENDING_CONNECTION");
			} finally {
				await f.close();
			}
		},
	);
	integration(
		"proven repair binds current release, preserving original approval and excluding extra actions",
		async () => {
			const f = await fixture();
			try {
				await f.publish({ ...f.target, authorizationCompatibility: [f.proof] });
				expect(
					await f.requests.prepareConnect(f.principalId, f.requestId),
				).toMatchObject({ providerReleaseId: f.target.providerReleaseId });
				expect(
					(await f.requests.getRequest(f.principalId, f.requestId))
						.connectReadiness?.status,
				).toBe("READY");
				const connected = await f.repository.storeProviderCredential(
					f.candidate(),
				);
				const [access] =
					await f.sql`SELECT provider_release_id, approved_provider_release_id, capability_profile_id, validity_kind, valid_until, source_request_id FROM connection_effective_access_authorizations WHERE connection_id=${connected.connectionId}`;
				expect(access).toMatchObject({
					provider_release_id: f.target.providerReleaseId,
					approved_provider_release_id: f.source.providerReleaseId,
					source_request_id: f.requestId,
					validity_kind: "PERMANENT",
					valid_until: null,
				});
				const members =
					await f.sql`SELECT action_version_id FROM connection_capability_profile_actions WHERE capability_profile_id=${access?.capability_profile_id}`;
				expect(members.map((row) => row.action_version_id)).toEqual([
					f.target.actions[0]?.id,
				]);
				expect(
					await f.requests.getRequest(f.principalId, f.requestId),
				).toMatchObject({
					state: "CONSUMED",
					providerReleaseId: f.source.providerReleaseId,
				});
				const audit =
					await f.sql`SELECT detail FROM connection_audit_records WHERE principal_id=${f.principalId} AND event='CONNECTION_APPROVAL_COMPATIBLE_UPGRADE'`;
				expect(audit).toHaveLength(1);
			} finally {
				await f.close();
			}
		},
	);
	integration.each(["auth", "effect", "scope", "schema", "deployment"])(
		"exact proof cannot allow a changed %s contract",
		async (change) => {
			const f = await fixture();
			try {
				const current = f.target.actions[0];
				if (!current) throw new Error("Missing target fixture");
				const read = { ...current };
				const target = {
					...f.target,
					authorizationCompatibility: [f.proof],
					actions: [read],
				};
				if (change === "auth") target.authProfile = { credential: "oauth" };
				if (change === "deployment")
					target.deploymentProfile = { apiOrigin: "https://different.example" };
				if (change === "effect") read.effect = "WRITE";
				if (change === "scope") read.requiredScopes = ["extra"];
				if (change === "schema")
					read.inputSchema = {
						required: [],
						type: "object",
						properties: { target: { type: "string" } },
					};
				await f.publish(target);
				await expect(
					f.requests.prepareConnect(f.principalId, f.requestId),
				).rejects.toMatchObject({ code: "INVALID_REQUEST" });
				await expect(
					f.repository.storeProviderCredential(f.candidate()),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
			} finally {
				await f.close();
			}
		},
	);
	integration(
		"later runtime release, revoked policy and expired Permit are rechecked",
		async () => {
			const f = await fixture();
			try {
				await f.publish({ ...f.target, authorizationCompatibility: [f.proof] });
				await f.requests.prepareConnect(f.principalId, f.requestId);
				const third = {
					...f.target,
					providerReleaseId: `${f.target.provider}-connection-v3`,
					executorDigest: `sha256:${"c".repeat(64)}`,
					actions: f.target.actions.map((action) => ({
						...action,
						id: action.id.replace("@v2", "@v3"),
					})),
				};
				await f.publish(third);
				await expect(
					f.repository.validatePersonalConnectRequest({
						principalId: f.principalId,
						providerId: f.target.provider,
						requestId: f.requestId,
					}),
				).rejects.toMatchObject({ code: "INVALID_REQUEST" });
				await expect(
					f.repository.storeProviderCredential(f.candidate()),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await f.sql`UPDATE connection_access_policy_versions SET status='REVOKED', revision=revision+1 WHERE id=(SELECT policy_version_id FROM connection_access_requests WHERE id=${f.requestId})`;
				await expect(
					f.requests.prepareConnect(f.principalId, f.requestId),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await f.sql`UPDATE connection_connect_permits SET expires_at=now()-interval '1 second' WHERE request_id=${f.requestId}`;
				await expect(
					f.requests.prepareConnect(f.principalId, f.requestId),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
			} finally {
				await f.close();
			}
		},
	);
});
