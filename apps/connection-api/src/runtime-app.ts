import {
	ConnectionApplicationService,
	ConnectionOAuthService,
	portablePatConsumerId,
} from "@agent-infra/connection-core";
import { LdapDirectoryAuthenticator } from "@agent-infra/connection-identity";
import {
	PostgresBrowserCommandIdempotency,
	PostgresConnectionOAuthRepository,
	PostgresConnectionRepository,
} from "@agent-infra/connection-store";
import {
	githubConnectionCatalog,
	OpenConnectorGitHubAdapter,
	OpenConnectorGitHubOAuthAdapter,
} from "@agent-infra/openconnector-adapter";

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
	await repository.publishGithubCatalog(githubConnectionCatalog);
	for (const consumer of [
		config.directConsumer,
		{ id: portablePatConsumerId, name: "Portable Connection PAT" },
	]) {
		await repository.publishConsumerDeclaration({
			actionVersionIds: githubConnectionCatalog.actions.map(
				(action) => action.id,
			),
			consumer,
			providerReleaseId: githubConnectionCatalog.providerReleaseId,
		});
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
	const service = new ConnectionApplicationService(
		repository,
		new OpenConnectorGitHubAdapter(),
		new OpenConnectorGitHubOAuthAdapter(config.github),
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
