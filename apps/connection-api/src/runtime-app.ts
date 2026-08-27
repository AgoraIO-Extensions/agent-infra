import {
	ConnectionApplicationService,
	ConnectionOAuthService,
	ProviderExecutorRouter,
	portablePatConsumerId,
} from "@agent-infra/connection-core";
import { LdapDirectoryAuthenticator } from "@agent-infra/connection-identity";
import {
	PostgresBrowserCommandIdempotency,
	PostgresConnectionOAuthRepository,
	PostgresConnectionRepository,
} from "@agent-infra/connection-store";
import {
	BitbucketServerAdapter,
	bitbucketServerConnectionCatalog,
	githubConnectionCatalog,
	OpenConnectorGitHubAdapter,
	OpenConnectorGitHubOAuthAdapter,
} from "@agent-infra/openconnector-adapter";
import {
	JiraServerAdapter,
	JiraServerOAuthTokenProvider,
	jiraServerConnectionCatalog,
} from "@agent-infra/openconnector-adapter/jira-server";
import { createGuardedFetch } from "@agent-infra/openconnector-kernel";

import { createConnectionApp } from "./app";
import { fullConnectionRuntimeConfig } from "./runtime-config";

export async function createConnectionRuntimeApp(
	environment: Record<string, string | undefined> = process.env,
) {
	const config = fullConnectionRuntimeConfig(environment);
	const oauthRepository = new PostgresConnectionOAuthRepository(
		config.databaseUrl,
	);
	const repository = new PostgresConnectionRepository(
		config.databaseUrl,
		config.credentialKey,
	);
	const browserCommands = new PostgresBrowserCommandIdempotency(
		config.databaseUrl,
		config.credentialKey,
	);
	for (const catalog of [
		githubConnectionCatalog,
		bitbucketServerConnectionCatalog,
		jiraServerConnectionCatalog,
	]) {
		await repository.publishProviderCatalog(catalog);
	}
	for (const consumer of [
		config.directConsumer,
		{ id: portablePatConsumerId, name: "Portable Connection PAT" },
	]) {
		for (const catalog of [
			githubConnectionCatalog,
			bitbucketServerConnectionCatalog,
			jiraServerConnectionCatalog,
		]) {
			await repository.publishConsumerDeclaration({
				actionVersionIds: catalog.actions.map((action) => action.id),
				consumer,
				providerReleaseId: catalog.providerReleaseId,
			});
		}
	}
	const directory = new LdapDirectoryAuthenticator(config.ldap);
	const oauth = new ConnectionOAuthService({
		consumer: config.directConsumer,
		directory,
		identityEnvironment: config.publicBaseUrl,
		identityKey: config.identityKey,
		repository: oauthRepository,
		resource: config.resourceUrl,
	});
	const github = new OpenConnectorGitHubAdapter();
	const bitbucket = new BitbucketServerAdapter(
		createGuardedFetch({ allowPrivateNetwork: false, maxRedirects: 0 }),
	);
	const jiraFetch = createGuardedFetch({
		allowPrivateNetwork: false,
		maxRedirects: 0,
	});
	const jira = new JiraServerAdapter(
		jiraFetch,
		new JiraServerOAuthTokenProvider(jiraFetch, config.jiraToken),
	);
	const service = new ConnectionApplicationService(
		repository,
		new ProviderExecutorRouter({
			[bitbucketServerConnectionCatalog.providerReleaseId]: bitbucket,
			[githubConnectionCatalog.providerReleaseId]: github,
			[jiraServerConnectionCatalog.providerReleaseId]: jira,
		}),
		new OpenConnectorGitHubOAuthAdapter(config.github),
		{ bitbucket, jira },
	);
	return createConnectionApp({
		accessTokens: oauth,
		directMcpEnabled: true,
		githubProviderEnabled: false,
		oauthServer: {
			browserCommands,
			dynamicClientRegistration: {
				clientName: config.directConsumer.name,
			},
			issuer: config.publicBaseUrl,
			management: {
				githubRedirectUri: config.github.redirectUri,
				service,
			},
			resource: config.resourceUrl,
			service: oauth,
		},
		service,
	});
}
