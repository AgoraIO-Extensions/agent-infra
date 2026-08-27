import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
	ConnectionApplicationService,
	ProviderExecutorRouter,
} from "@agent-infra/connection-core";
import {
	BitbucketServerAdapter,
	bitbucketServerConnectionCatalog,
} from "@agent-infra/openconnector-adapter";
import { createGuardedFetch } from "@agent-infra/openconnector-kernel";
import postgres from "postgres";

import { migrateConnectionDatabase } from "../src/migrations.ts";
import { PostgresConnectionRepository } from "../src/repository.ts";
import { assertIsolatedTestDatabaseUrl } from "../src/test-database.ts";

const databaseUrl = process.env.CONNECTION_TEST_DATABASE_URL;
const accessToken = process.env.BITBUCKET_SERVER_PAT;
assertIsolatedTestDatabaseUrl(databaseUrl, process.env.DATABASE_URL);
if (!databaseUrl) throw new Error("CONNECTION_TEST_DATABASE_URL is required");
if (!accessToken) throw new Error("BITBUCKET_SERVER_PAT is required");

await migrateConnectionDatabase(
	databaseUrl,
	resolve(import.meta.dirname, "../../../migrations/connection"),
);
const credentialKey = randomBytes(32);
const repository = new PostgresConnectionRepository(databaseUrl, credentialKey);
const sql = postgres(databaseUrl, { max: 1 });
const suffix = randomUUID();
const principalId = `principal-bitbucket-e2e-${suffix}`;
const consumer = {
	id: `consumer-bitbucket-e2e-${suffix}`,
	name: "Bitbucket real E2E",
};
const instanceId = `instance-bitbucket-e2e-${suffix}`;
const bitbucket = new BitbucketServerAdapter(
	createGuardedFetch({ allowPrivateNetwork: false, maxRedirects: 0 }),
);
const service = new ConnectionApplicationService(
	repository,
	new ProviderExecutorRouter({
		[bitbucketServerConnectionCatalog.providerReleaseId]: bitbucket,
	}),
	undefined,
	{ bitbucket },
);

try {
	await sql`
		INSERT INTO connection_principals (id, display_name, status)
		VALUES (${principalId}, 'Bitbucket E2E Principal', 'ACTIVE')
	`;
	await repository.publishProviderCatalog(bitbucketServerConnectionCatalog);
	await repository.publishConsumerDeclaration({
		actionVersionIds: bitbucketServerConnectionCatalog.actions.map(
			(action) => action.id,
		),
		consumer,
		providerReleaseId: bitbucketServerConnectionCatalog.providerReleaseId,
	});
	await sql`
		INSERT INTO connection_consumer_instances (
			id, consumer_id, kind, auth_subject, status, principal_id
		)
		VALUES (
			${instanceId}, ${consumer.id}, 'DEVICE', ${`subject-${suffix}`},
			'ACTIVE', ${principalId}
		)
	`;
	const connection = await service.connectProviderCredential(
		principalId,
		"bitbucket",
		accessToken,
	);
	const preview = await service.createCurrentConsumerAuthorizationPreview({
		connectionId: connection.connectionId,
		consumerId: consumer.id,
		principalId,
	});
	const grant = await service.confirmCurrentConsumerAuthorization({
		confirmationToken: preview.confirmationToken,
		idempotencyKey: randomUUID(),
		previewId: preview.previewId,
		principalId,
	});
	const identity = { consumerId: consumer.id, instanceId, principalId };
	const apps = await service.listDirectAppsForIdentity(identity);
	assert.deepEqual(apps, [{ actionCount: 25, service: "bitbucket" }]);

	const projects = resultValues(
		await service.executeDirectActionForIdentity(
			identity,
			"bitbucket.list_projects",
			{ limit: 10 },
		),
	);
	assert.ok(projects.length > 0);
	let project: string | undefined;
	let repositorySlug: string | undefined;
	for (const entry of projects) {
		const candidateProject = stringField(entry, "key");
		if (!candidateProject) continue;
		const repositories = resultValues(
			await service.executeDirectActionForIdentity(
				identity,
				"bitbucket.list_repositories",
				{ limit: 10, project: candidateProject },
			),
		);
		const candidateRepository = repositories
			.map((item) => stringField(item, "slug"))
			.find(Boolean);
		if (candidateRepository) {
			project = candidateProject;
			repositorySlug = candidateRepository;
			break;
		}
	}
	assert.ok(project && repositorySlug);
	const repositoryInput = { project, repository: repositorySlug };
	await service.executeDirectActionForIdentity(
		identity,
		"bitbucket.get_repository",
		repositoryInput,
	);
	assertPage(
		await service.executeDirectActionForIdentity(
			identity,
			"bitbucket.list_branches",
			{ ...repositoryInput, limit: 1 },
		),
	);
	assertPage(
		await service.executeDirectActionForIdentity(
			identity,
			"bitbucket.list_pull_requests",
			{ ...repositoryInput, limit: 1, state: "ALL" },
		),
	);

	const [credential] = await sql<{ ciphertext: string; provider_id: string }[]>`
		SELECT credential.ciphertext, account.provider_id
		FROM connection_credential_versions credential
		JOIN connection_accounts account ON account.id = credential.connection_id
		WHERE account.id = ${connection.connectionId}
			AND credential.status = 'ACTIVE'
	`;
	assert.equal(credential?.provider_id, "bitbucket");
	assert.equal(credential?.ciphertext.includes(accessToken), false);
	const otherPrincipalId = `principal-bitbucket-other-${suffix}`;
	const otherInstanceId = `instance-bitbucket-other-${suffix}`;
	await sql`
		INSERT INTO connection_principals (id, display_name, status)
		VALUES (${otherPrincipalId}, 'Other Bitbucket E2E Principal', 'ACTIVE')
	`;
	await sql`
		INSERT INTO connection_consumer_instances (
			id, consumer_id, kind, auth_subject, status, principal_id
		)
		VALUES (
			${otherInstanceId}, ${consumer.id}, 'DEVICE', ${`other-subject-${suffix}`},
			'ACTIVE', ${otherPrincipalId}
		)
	`;
	await assert.rejects(
		service.executeDirectActionForIdentity(
			{
				consumerId: consumer.id,
				instanceId: otherInstanceId,
				principalId: otherPrincipalId,
			},
			"bitbucket.list_projects",
			{ limit: 1 },
		),
	);
	await assert.rejects(
		service.executeDirectActionForIdentity(
			identity,
			"github.get_repository",
			{},
		),
	);

	await service.revokeGrant(principalId, grant.grantId);
	await assert.rejects(
		service.executeDirectActionForIdentity(
			identity,
			"bitbucket.list_projects",
			{ limit: 1 },
		),
	);
	console.log(
		JSON.stringify({
			catalogActions: 25,
			crossPrincipalDenied: true,
			crossProviderDenied: true,
			encryptedCredentialVerified: true,
			grantRevocationVerified: true,
			identityVerified: true,
			provider: "bitbucket",
			readActionsVerified: [
				"list_projects",
				"list_repositories",
				"get_repository",
				"list_branches",
				"list_pull_requests",
			],
			secretReturned: false,
		}),
	);
} finally {
	await sql.end();
	await repository.close();
	credentialKey.fill(0);
}

function resultValues(call: { result?: Record<string, unknown> }) {
	const values = call.result?.values;
	return Array.isArray(values)
		? values.filter(
				(value): value is Record<string, unknown> =>
					typeof value === "object" && value !== null && !Array.isArray(value),
			)
		: [];
}

function assertPage(call: { result?: Record<string, unknown> }) {
	assert.ok(Array.isArray(call.result?.values));
	assert.equal(typeof call.result?.isLastPage, "boolean");
	assert.equal(typeof call.result?.limit, "number");
	assert.equal(typeof call.result?.start, "number");
	if (call.result?.isLastPage === false) {
		assert.equal(typeof call.result.nextPageStart, "number");
	}
}

function stringField(input: Record<string, unknown>, field: string) {
	const value = input[field];
	return typeof value === "string" && value ? value : undefined;
}
