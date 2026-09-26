import {
	ConnectionAccessApprovalService,
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
	PostgresConnectionAccessRequestRepository,
	PostgresConnectionApprovalRepository,
	PostgresConnectionNotificationDispatcher,
	PostgresConnectionOAuthRepository,
	PostgresConnectionPatBindingRepository,
	PostgresConnectionRepository,
} from "@agent-infra/connection-store";
import {
	BitbucketServerAdapter,
	bitbucketServerConnectionCatalog,
	githubConnectionCatalog,
	JenkinsAdapter,
	jenkinsCiConnectionCatalog,
	jenkinsCiProfile,
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
import {
	RehoboamAdapter,
	rehoboamConnectionCatalog,
} from "@agent-infra/openconnector-adapter/rehoboam";
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
	const approvalRepository = new PostgresConnectionAccessRequestRepository(
		config.databaseUrl,
	);
	const notificationDispatcher = new PostgresConnectionNotificationDispatcher(
		config.databaseUrl,
	);
	const approvalService = new ConnectionAccessApprovalService(
		approvalRepository,
	);
	const approvalCatalog = new PostgresConnectionApprovalRepository(
		config.databaseUrl,
	);
	for (const catalog of [
		githubConnectionCatalog,
		bitbucketServerConnectionCatalog,
		jiraServerConnectionCatalog,
		confluenceServerConnectionCatalog,
		jenkinsCiConnectionCatalog,
		jenkinsReleaseConnectionCatalog,
		rehoboamConnectionCatalog,
	]) {
		await repository.publishProviderCatalog(catalog, {
			mode: "USER_ACTION_REQUIRED",
			reason: `${catalog.provider} Provider authorization contract changed`,
		});
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
			jenkinsCiConnectionCatalog,
			jenkinsReleaseConnectionCatalog,
			rehoboamConnectionCatalog,
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
		identityRealm: config.identityRealm,
		identityKey: config.identityKey,
		patConsumers: [rehoboamAiConsumer],
		patBinding: { repository: patBindingRepository },
		repository: oauthRepository,
		resource: config.resourceUrl,
	});
	const proxyFetch = (proxyUrl: string) => {
		const dispatcher = new ProxyAgent(proxyUrl);
		return ((input: RequestInfo | URL, init?: RequestInit) =>
			undiciFetch(
				input as never,
				{ ...init, dispatcher } as never,
			)) as unknown as typeof fetch;
	};
	const githubPrimaryFetch = config.githubEgressProxyUrl
		? proxyFetch(config.githubEgressProxyUrl)
		: undefined;
	const githubFetch =
		githubPrimaryFetch && config.githubReadFallbackProxyUrl
			? createReadFallbackFetch(
					githubPrimaryFetch,
					proxyFetch(config.githubReadFallbackProxyUrl),
				)
			: githubPrimaryFetch;
	const github = new OpenConnectorGitHubAdapter(githubFetch);
	const bitbucketFetch = createGuardedFetch({
		allowPrivateNetwork: false,
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
	const jenkinsRouteFetch =
		config.jenkinsReleaseRoute === "internal"
			? createFixedOriginFetch(
					jenkinsReleaseProfile.apiOrigin,
					"http://10.80.1.129:8080",
				)
			: undefined;
	const jenkinsFetch = createGuardedFetch({
		allowPrivateNetwork: false,
		...(jenkinsRouteFetch ? { fetch: jenkinsRouteFetch } : {}),
		maxRedirects: 0,
	});
	const jenkins = new JenkinsAdapter(jenkinsReleaseProfile, jenkinsFetch);
	const jenkinsCi = new JenkinsAdapter(
		jenkinsCiProfile,
		createGuardedFetch({ allowPrivateNetwork: false, maxRedirects: 0 }),
		new JiraServerOAuthTokenProvider(jiraFetch, config.jenkinsCiToken),
	);
	const rehoboam = new RehoboamAdapter(
		createGuardedFetch({ allowPrivateNetwork: false, maxRedirects: 0 }),
		config.rehoboamApiKey,
	);
	const executors = new ProviderExecutorRouter({
		[bitbucketServerConnectionCatalog.providerReleaseId]: bitbucket,
		[githubConnectionCatalog.providerReleaseId]: github,
		[jiraServerConnectionCatalog.providerReleaseId]: jira,
		[confluenceServerConnectionCatalog.providerReleaseId]: confluence,
		[jenkinsCiConnectionCatalog.providerReleaseId]: jenkinsCi,
		[jenkinsReleaseConnectionCatalog.providerReleaseId]: jenkins,
		[rehoboamConnectionCatalog.providerReleaseId]: rehoboam,
	});
	const service = new ConnectionApplicationService(
		repository,
		executors,
		new OpenConnectorGitHubOAuthAdapter({
			...config.github,
			fetcher: githubFetch,
		}),
		{
			bitbucket,
			confluence,
			[jenkins.providerId]: jenkins,
			[jenkinsCi.providerId]: jenkinsCi,
			[rehoboam.providerId]: rehoboam,
			jira,
		},
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
				approvalCatalog,
				approvalService,
				notificationDispatcher,
				approvalDirectoryEnabled: config.approvalDirectoryEnabled,
				catalogs: [
					githubConnectionCatalog,
					bitbucketServerConnectionCatalog,
					jiraServerConnectionCatalog,
					confluenceServerConnectionCatalog,
					jenkinsCiConnectionCatalog,
					jenkinsReleaseConnectionCatalog,
					rehoboamConnectionCatalog,
				],
				githubRedirectUri: config.github.redirectUri,
				service,
			},
			resource: config.resourceUrl,
			service: oauth,
		},
		providerServiceHostAliases: {
			"10.80.1.129": jenkinsReleaseConnectionCatalog.provider,
			"114.94.148.35": jenkinsReleaseConnectionCatalog.provider,
			"github.com": githubConnectionCatalog.provider,
			"jenkins-ci.agoralab.co": "jenkins-ci",
			"rehoboam.gz3.agoralab.co": rehoboamConnectionCatalog.provider,
			"justinia.gz3.agoralab.co": rehoboamConnectionCatalog.provider,
		},
		service,
		supportedProviders: [
			githubConnectionCatalog.provider,
			bitbucketServerConnectionCatalog.provider,
			jiraServerConnectionCatalog.provider,
			confluenceServerConnectionCatalog.provider,
			jenkinsCiConnectionCatalog.provider,
			jenkinsReleaseConnectionCatalog.provider,
			rehoboamConnectionCatalog.provider,
		],
	});
	return {
		app,
		approvalMaintenance: approvalRepository,
		notificationDispatcher,
		recovery: new ConnectionRecoveryService(repository, executors),
	};
}

export function createReadFallbackFetch(
	primary: typeof fetch,
	fallback: typeof fetch,
): typeof fetch {
	return async (input, init) => {
		try {
			return await primary(input, init);
		} catch (error) {
			const method = (
				init?.method ?? (input instanceof Request ? input.method : "GET")
			).toUpperCase();
			if (method !== "GET" && method !== "HEAD") throw error;
			return fallback(input, init);
		}
	};
}

export function createFixedOriginFetch(
	fromOrigin: string,
	toOrigin: string,
	baseFetch: typeof fetch = fetch,
): typeof fetch {
	const expectedOrigin = new URL(fromOrigin).origin;
	const targetOrigin = new URL(toOrigin);
	return async (input, init) => {
		const request = new Request(input, init);
		const sourceUrl = new URL(request.url);
		if (sourceUrl.origin !== expectedOrigin) {
			throw new Error("Provider request origin does not match the fixed route");
		}
		const targetUrl = new URL(
			`${sourceUrl.pathname}${sourceUrl.search}`,
			targetOrigin,
		);
		return baseFetch(new Request(targetUrl, request));
	};
}
