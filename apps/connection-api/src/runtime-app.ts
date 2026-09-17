import {
	ConnectionApplicationService,
	ConnectionOAuthService,
	ConnectionRecoveryService,
	ProviderExecutorRouter,
	portablePatConsumerId,
	rehoboamAiConsumer,
} from "@agent-infra/connection-core";
import { LdapDirectoryAuthenticator } from "@agent-infra/connection-identity";
import {
	PostgresBrowserCommandIdempotency,
	PostgresConnectionOAuthRepository,
	PostgresConnectionPatBindingRepository,
	PostgresConnectionRepository,
} from "@agent-infra/connection-store";
import {
	BitbucketServerAdapter,
	bitbucketServerConnectionCatalog,
	githubConnectionCatalog,
	JenkinsAdapter,
	jenkinsReleaseConnectionCatalog,
	jenkinsReleaseProfile,
	OpenConnectorGitHubAdapter,
	OpenConnectorGitHubOAuthAdapter,
} from "@agent-infra/openconnector-adapter";
import {
	ConfluenceServerAdapter,
	confluenceServerConnectionCatalog,
} from "@agent-infra/openconnector-adapter/confluence-server";
import {
	JiraServerAdapter,
	JiraServerOAuthTokenProvider,
	jiraServerConnectionCatalog,
} from "@agent-infra/openconnector-adapter/jira-server";
import { createGuardedFetch } from "@agent-infra/openconnector-kernel";
import { ProxyAgent, fetch as undiciFetch } from "undici";

import { createConnectionApp } from "./app";
import { fullConnectionRuntimeConfig } from "./runtime-config";

export async function createConnectionRuntimeApp(
	environment: Record<string, string | undefined> = process.env,
) {
	return (await createConnectionRuntime(environment)).app;
}

export async function createConnectionRuntime(
	environment: Record<string, string | undefined> = process.env,
) {
	const config = fullConnectionRuntimeConfig(environment);
	const oauthRepository = new PostgresConnectionOAuthRepository(
		config.databaseUrl,
	);
	const patBindingRepository = new PostgresConnectionPatBindingRepository(
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
		confluenceServerConnectionCatalog,
		jenkinsReleaseConnectionCatalog,
	]) {
		await repository.publishProviderCatalog(catalog);
	}
	for (const consumer of [
		config.directConsumer,
		{ id: portablePatConsumerId, name: "Portable Connection PAT" },
		rehoboamAiConsumer,
	]) {
		for (const catalog of [
			githubConnectionCatalog,
			bitbucketServerConnectionCatalog,
			jiraServerConnectionCatalog,
			confluenceServerConnectionCatalog,
			jenkinsReleaseConnectionCatalog,
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
		patConsumers: [rehoboamAiConsumer],
		patBinding: { repository: patBindingRepository },
		repository: oauthRepository,
		resource: config.resourceUrl,
	});
	const github = new OpenConnectorGitHubAdapter();
	const proxyDispatcher = config.bitbucketProxyUrl
		? new ProxyAgent(config.bitbucketProxyUrl)
		: undefined;
	const bitbucketFetch = createGuardedFetch({
		allowPrivateNetwork: false,
		...(proxyDispatcher === undefined
			? {}
			: {
					fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
						undiciFetch(
							input as never,
							{
								...init,
								dispatcher: proxyDispatcher,
							} as never,
						)) as unknown as typeof fetch,
				}),
		maxRedirects: 0,
	});
	const bitbucket = new BitbucketServerAdapter(bitbucketFetch);
	const jiraFetch = createGuardedFetch({
		allowPrivateNetwork: false,
		maxRedirects: 0,
	});
	const atlassianTokenProvider = new JiraServerOAuthTokenProvider(
		jiraFetch,
		config.jiraToken,
	);
	const jira = new JiraServerAdapter(jiraFetch, atlassianTokenProvider);
	const confluence = new ConfluenceServerAdapter(
		jiraFetch,
		atlassianTokenProvider,
	);
	const jenkins = new JenkinsAdapter(jenkinsReleaseProfile, jiraFetch);
	const executors = new ProviderExecutorRouter({
		[bitbucketServerConnectionCatalog.providerReleaseId]: bitbucket,
		[githubConnectionCatalog.providerReleaseId]: github,
		[jiraServerConnectionCatalog.providerReleaseId]: jira,
		[confluenceServerConnectionCatalog.providerReleaseId]: confluence,
		[jenkinsReleaseConnectionCatalog.providerReleaseId]: jenkins,
	});
	const service = new ConnectionApplicationService(
		repository,
		executors,
		new OpenConnectorGitHubOAuthAdapter(config.github),
		{ bitbucket, confluence, [jenkins.providerId]: jenkins, jira },
	);
	const app = createConnectionApp({
		accessTokens: oauth,
		connectionWebUrl: config.publicBaseUrl,
		directMcpEnabled: true,
		githubProviderEnabled: false,
		oauthServer: {
			browserCommands,
			dynamicClientRegistration: {
				clientName: config.directConsumer.name,
			},
			issuer: config.publicBaseUrl,
			management: {
				catalogs: [
					githubConnectionCatalog,
					bitbucketServerConnectionCatalog,
					jiraServerConnectionCatalog,
					confluenceServerConnectionCatalog,
					jenkinsReleaseConnectionCatalog,
				],
				githubRedirectUri: config.github.redirectUri,
				service,
			},
			resource: config.resourceUrl,
			service: oauth,
		},
		service,
		supportedProviders: [
			githubConnectionCatalog.provider,
			bitbucketServerConnectionCatalog.provider,
			jiraServerConnectionCatalog.provider,
			confluenceServerConnectionCatalog.provider,
			jenkinsReleaseConnectionCatalog.provider,
		],
	});
	return {
		app,
		recovery: new ConnectionRecoveryService(repository, executors),
	};
}
