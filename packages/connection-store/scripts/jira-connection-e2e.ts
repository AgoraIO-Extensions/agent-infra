import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
	ConnectionApplicationService,
	ProviderExecutorRouter,
} from "@agent-infra/connection-core";
import {
	JiraServerAdapter,
	JiraServerOAuthTokenProvider,
	jiraServerConnectionCatalog,
} from "@agent-infra/openconnector-adapter/jira-server";
import { createGuardedFetch } from "@agent-infra/openconnector-kernel";
import postgres from "postgres";

import { migrateConnectionDatabase } from "../src/migrations.ts";
import { PostgresConnectionRepository } from "../src/repository.ts";
import { assertIsolatedTestDatabaseUrl } from "../src/test-database.ts";

const databaseUrl = process.env.CONNECTION_TEST_DATABASE_URL;
const username = process.env.JIRA_USERNAME;
const password = process.env.JIRA_PASSWORD;
const tokenUrl = process.env.JIRA_TOKEN_SERVER_URL;
const tokenClientId = process.env.JIRA_TOKEN_CLIENT_ID;
const tokenClientSecret = process.env.JIRA_TOKEN_CLIENT_SECRET;
const tokenUsername = process.env.JIRA_TOKEN_USERNAME;
const tokenPassword = process.env.JIRA_TOKEN_PASSWORD;
assertIsolatedTestDatabaseUrl(databaseUrl, process.env.DATABASE_URL);
if (!databaseUrl) throw new Error("CONNECTION_TEST_DATABASE_URL is required");
if (!username) throw new Error("JIRA_USERNAME is required");
if (!password) throw new Error("JIRA_PASSWORD is required");
if (!tokenUrl) throw new Error("JIRA_TOKEN_SERVER_URL is required");
if (!tokenClientId) throw new Error("JIRA_TOKEN_CLIENT_ID is required");
if (!tokenClientSecret) throw new Error("JIRA_TOKEN_CLIENT_SECRET is required");
if (!tokenUsername) throw new Error("JIRA_TOKEN_USERNAME is required");
if (!tokenPassword) throw new Error("JIRA_TOKEN_PASSWORD is required");

await migrateConnectionDatabase(
	databaseUrl,
	resolve(import.meta.dirname, "../../../migrations/connection"),
);
const credentialKey = randomBytes(32);
const repository = new PostgresConnectionRepository(databaseUrl, credentialKey);
const sql = postgres(databaseUrl, { max: 1 });
const suffix = randomUUID();
const principalId = `principal-jira-e2e-${suffix}`;
const consumer = { id: `consumer-jira-e2e-${suffix}`, name: "Jira real E2E" };
const instanceId = `instance-jira-e2e-${suffix}`;
const jiraFetch = createGuardedFetch({
	allowPrivateNetwork: false,
	maxRedirects: 0,
});
const jira = new JiraServerAdapter(
	jiraFetch,
	new JiraServerOAuthTokenProvider(jiraFetch, {
		clientId: tokenClientId,
		clientSecret: tokenClientSecret,
		password: tokenPassword,
		tokenUrl,
		username: tokenUsername,
	}),
);
const service = new ConnectionApplicationService(
	repository,
	new ProviderExecutorRouter({
		[jiraServerConnectionCatalog.providerReleaseId]: jira,
	}),
	undefined,
	{ jira },
);
const encodedCredential = JSON.stringify({ password, username });

try {
	await sql`
		INSERT INTO connection_principals (id, display_name, status)
		VALUES (${principalId}, 'Jira E2E Principal', 'ACTIVE')
	`;
	await repository.publishProviderCatalog(jiraServerConnectionCatalog);
	await repository.publishConsumerDeclaration({
		actionVersionIds: jiraServerConnectionCatalog.actions.map(
			(action) => action.id,
		),
		consumer,
		providerReleaseId: jiraServerConnectionCatalog.providerReleaseId,
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
		"jira",
		encodedCredential,
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
	assert.deepEqual(apps, [{ actionCount: 20, service: "jira" }]);

	const currentUser = resultObject(
		await service.executeDirectActionForIdentity(
			identity,
			"jira.get_current_user",
			{},
		),
	);
	assert.equal(currentUser.active, true);
	assert.equal(currentUser.name, username);

	const projects = resultValues(
		await service.executeDirectActionForIdentity(
			identity,
			"jira.list_projects",
			{ limit: 10 },
		),
	);
	assert.ok(projects.length > 0);
	const issueSearch = resultObject(
		await service.executeDirectActionForIdentity(
			identity,
			"jira.search_issues",
			{ jql: "project = ASS ORDER BY created DESC", limit: 1 },
		),
	);
	assert.ok(Array.isArray(issueSearch.issues));
	const [credential] = await sql<
		{
			ciphertext: string;
			provider_id: string;
		}[]
	>`
		SELECT credential.ciphertext, account.provider_id
		FROM connection_credential_versions credential
		JOIN connection_accounts account ON account.id = credential.connection_id
		WHERE account.id = ${connection.connectionId}
			AND credential.status = 'ACTIVE'
	`;
	assert.equal(credential?.provider_id, "jira");
	assert.equal(credential?.ciphertext.includes(encodedCredential), false);
	await assert.rejects(
		service.executeDirectActionForIdentity(
			identity,
			"bitbucket.list_projects",
			{ limit: 1 },
		),
	);

	await service.revokeGrant(principalId, grant.grantId);
	await assert.rejects(
		service.executeDirectActionForIdentity(identity, "jira.list_projects", {
			limit: 1,
		}),
	);
	console.log(
		JSON.stringify({
			catalogActions: 20,
			crossProviderDenied: true,
			encryptedCredentialVerified: true,
			grantRevocationVerified: true,
			identityVerified: true,
			provider: "jira",
			readActionsVerified: [
				"get_current_user",
				"list_projects",
				"search_issues",
			],
			secretReturned: false,
		}),
	);
} finally {
	await sql.end();
	await repository.close();
	credentialKey.fill(0);
}

function resultObject(call: { result?: Record<string, unknown> }) {
	return call.result ?? {};
}

function resultValues(call: { result?: Record<string, unknown> }) {
	const values = call.result?.projects;
	return Array.isArray(values)
		? values.filter(
				(value): value is Record<string, unknown> =>
					typeof value === "object" && value !== null && !Array.isArray(value),
			)
		: [];
}
