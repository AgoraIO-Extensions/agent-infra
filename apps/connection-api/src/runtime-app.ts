import {
	ConnectionAccessApprovalService,
	ConnectionApplicationService,
	ConnectionOAuthService,
	ConnectionRecoveryService,
	type GitHubOAuthProvider,
	observeProviderFetch,
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
	bitbucketServerLegacyProviderReleaseIds,
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
	bitbucketServerConnectionCatalog,
	datalegoV5ConnectionCatalog,
	datalegoV6ConnectionCatalog,
} from "@agent-infra/openconnector-adapter/authorization-compatibility";
import {
	ConfluenceServerAdapter,
	confluenceServerConnectionCatalog,
} from "@agent-infra/openconnector-adapter/confluence-server";
import {
	DataLegoAdapter,
	datalegoConnectionCatalog,
} from "@agent-infra/openconnector-adapter/datalego";
import {
	DataLegoV4Adapter,
	datalegoV4ConnectionCatalog,
} from "@agent-infra/openconnector-adapter/datalego-v4";
import { DataLegoV5Adapter } from "@agent-infra/openconnector-adapter/datalego-v5";
import { DataLegoV6Adapter } from "@agent-infra/openconnector-adapter/datalego-v6";
import {
	JiraServerAdapter,
	JiraServerOAuthTokenProvider,
	jiraServerConnectionCatalog,
} from "@agent-infra/openconnector-adapter/jira-server";
import {
	ManhattanAdapter,
	ManhattanOAuthAdapter,
	manhattanConnectionCatalog,
	manhattanLegacyProviderReleaseIds,
} from "@agent-infra/openconnector-adapter/manhattan";
import { connectionProviderCatalogs } from "@agent-infra/openconnector-adapter/provider-catalogs";
import { createPinnedProviderFetch } from "@agent-infra/openconnector-adapter/provider-fetch";
import {
	RehoboamV11Adapter as RehoboamAdapter,
	rehoboamV11ConnectionCatalog as rehoboamConnectionCatalog,
	rehoboamV11LegacyProviderReleaseIds as rehoboamLegacyProviderReleaseIds,
} from "@agent-infra/openconnector-adapter/rehoboam-v11";
import {
	StaticSpacesAdapter,
	staticSpacesConnectionCatalog,
	staticSpacesOrigins,
} from "@agent-infra/openconnector-adapter/static-spaces";
import { createGuardedFetch } from "@agent-infra/openconnector-kernel";
import { createConnectionApp } from "./app";
import { fullConnectionRuntimeConfig } from "./runtime-config";

export async function createConnectionRuntimeApp(
	environment: Record<string, string | undefined> = process.env,
) {
	return (await createConnectionRuntime(environment)).app;
}

async function startupPhase<T>(
	phase: "provider_catalog" | "consumer_declaration",
	provider: string,
	operation: () => Promise<T>,
) {
	const startedAt = performance.now();
	let outcome = "failure";
	try {
		const result = await operation();
		outcome = "success";
		return result;
	} finally {
		console.info(
			JSON.stringify({
				service: "connection-api",
				event: "startup_phase",
				phase,
				provider,
				outcome,
				durationMs: Math.round(performance.now() - startedAt),
			}),
		);
	}
}

export async function publishStartupConsumerDeclarations(
	repository: Pick<PostgresConnectionRepository, "publishConsumerDeclaration">,
	consumers: readonly { id: string; name: string }[],
	catalogs: readonly {
		provider: string;
		providerReleaseId: string;
		actions: readonly { id: string }[];
	}[],
) {
	// The runtime supplies three Consumers. Keep duplicate IDs and each revision chain serial.
	const groups = new Map<string, { id: string; name: string }[]>();
	for (const consumer of consumers) {
		const group = groups.get(consumer.id) ?? [];
		group.push(consumer);
		groups.set(consumer.id, group);
	}
	const results = await Promise.allSettled(
		[...groups.values()].map(async (group) => {
			for (const consumer of group) {
				for (const catalog of catalogs) {
					await startupPhase("consumer_declaration", catalog.provider, () =>
						repository.publishConsumerDeclaration({
							consumer,
							providerReleaseId: catalog.providerReleaseId,
							actionVersionIds: catalog.actions.map((action) => action.id),
						}),
					);
				}
			}
		}),
	);
	const failure = results.find((result) => result.status === "rejected");
	if (failure?.status === "rejected") throw failure.reason;
}

export async function createConnectionRuntime(
	environment: Record<string, string | undefined> = process.env,
) {
	const config = fullConnectionRuntimeConfig(environment);
	if (config.githubEgressProxyUrl || config.githubReadFallbackProxyUrl) {
		throw new Error(
			"Provider forward proxies require a reviewed pinned CONNECT transport",
		);
	}
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
	const catalogs = connectionProviderCatalogs;
	const approvalRepository = new PostgresConnectionAccessRequestRepository(
		config.databaseUrl,
		(sql, connectionId) =>
			repository.restoreGrantsAfterRenewal(sql, connectionId),
		{
			providerReleases: new Map(
				catalogs.map((catalog) => [
					catalog.provider,
					catalog.providerReleaseId,
				]),
			),
			authorizationCompatibility: new Map(
				catalogs.map((catalog) => [
					catalog.providerReleaseId,
					"authorizationCompatibility" in catalog
						? catalog.authorizationCompatibility
						: [],
				]),
			),
		},
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

	// Reconciliation writes shared upgrade tasks across Providers; keep catalog transactions serial.
	for (const catalog of catalogs) {
		await startupPhase("provider_catalog", catalog.provider, () =>
			repository.publishProviderCatalog(catalog, {
				mode: "USER_ACTION_REQUIRED",
				reason: `${catalog.provider} Provider authorization contract changed`,
			}),
		);
	}
	await publishStartupConsumerDeclarations(
		repository,
		[
			config.directConsumer,
			{ id: portablePatConsumerId, name: "Portable Connection PAT" },
			rehoboamAiConsumer,
		],
		catalogs,
	);
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
	const transports: ReturnType<typeof createPinnedProviderFetch>[] = [];
	const providerFetch = (
		origins: readonly string[],
		privateOrigins: readonly string[] = [],
	) => {
		const transport = createPinnedProviderFetch({ origins, privateOrigins });
		transports.push(transport);
		return transport.fetch;
	};
	const originFor = (provider: string) => {
		const origin = catalogs.find((catalog) => catalog.provider === provider)
			?.deploymentProfile.apiOrigin;
		if (!origin) throw new Error("Published Provider origin is missing");
		return origin;
	};
	const githubFetch = observeProviderFetch(
		"github",
		providerFetch([
			originFor("github"),
			config.github.tokenUrl ?? githubOAuthTokenUrl,
		]),
	);
	const github = new OpenConnectorGitHubAdapter(githubFetch);
	const githubOAuth = createPreSubmitGithubOAuthAdapter(
		config.github,
		githubFetch,
		async () => githubFetch,
	);
	const bitbucketFetch = createGuardedFetch({
		fetch: observeProviderFetch(
			"bitbucket",
			providerFetch([originFor("bitbucket")]),
		),
		allowPrivateNetwork: false,
		maxRedirects: 0,
	});
	const bitbucket = new BitbucketServerAdapter(bitbucketFetch);
	const jiraFetch = createGuardedFetch({
		fetch: observeProviderFetch(
			"atlassian",
			providerFetch([
				originFor("jira"),
				originFor("confluence"),
				config.jiraToken.tokenUrl,
				config.jenkinsCiToken.tokenUrl,
			]),
		),
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
					observeProviderFetch(
						"jenkins",
						providerFetch(
							["http://10.80.1.129:8080"],
							["http://10.80.1.129:8080"],
						),
					),
				)
			: undefined;
	const jenkinsFetch = createGuardedFetch({
		allowPrivateNetwork: false,
		fetch:
			jenkinsRouteFetch ??
			observeProviderFetch(
				"jenkins",
				providerFetch([jenkinsReleaseProfile.apiOrigin]),
			),
		maxRedirects: 0,
	});
	const jenkins = new JenkinsAdapter(jenkinsReleaseProfile, jenkinsFetch);
	const jenkinsCi = new JenkinsAdapter(
		jenkinsCiProfile,
		createGuardedFetch({
			allowPrivateNetwork: false,
			maxRedirects: 0,
			fetch: observeProviderFetch(
				"jenkins-ci",
				providerFetch([jenkinsCiProfile.apiOrigin]),
			),
		}),
		new JiraServerOAuthTokenProvider(jiraFetch, config.jenkinsCiToken),
	);
	const rehoboam = new RehoboamAdapter(
		createGuardedFetch({
			allowPrivateNetwork: false,
			maxRedirects: 0,
			fetch: observeProviderFetch(
				"rehoboam",
				providerFetch([originFor("rehoboam")]),
			),
		}),
		config.rehoboamApiKey,
	);
	const manhattan = new ManhattanAdapter(
		createGuardedFetch({
			allowPrivateNetwork: false,
			maxRedirects: 0,
			fetch: observeProviderFetch(
				"manhattan",
				providerFetch([originFor("manhattan")]),
			),
		}),
		config.manhattanApiKey,
	);
	const manhattanOAuth = new ManhattanOAuthAdapter(
		manhattan,
		createGuardedFetch({
			allowPrivateNetwork: false,
			maxRedirects: 0,
			fetch: providerFetch(["https://oauth.agoralab.co"]),
		}),
		config.manhattanOAuth.clientId,
		config.manhattanOAuth.clientSecret,
	);
	const datalegoFetch = createGuardedFetch({
		allowPrivateNetwork: false,
		maxRedirects: 0,
		fetch: observeProviderFetch(
			"datalego",
			providerFetch([originFor("datalego"), "https://oauth.agoralab.co"]),
		),
	});
	const datalego = new DataLegoAdapter(datalegoFetch);
	const datalegoOAuthV4 = new DataLegoV4Adapter(
		datalegoFetch,
		config.datalegoOAuth,
	);
	const datalegoOAuthV5 = new DataLegoV5Adapter(
		datalegoFetch,
		config.datalegoOAuth,
	);
	const datalegoOAuth = new DataLegoV6Adapter(
		datalegoFetch,
		config.datalegoOAuth,
	);
	const staticSpaces = catalogs.some(
		(catalog) => catalog.provider === staticSpacesConnectionCatalog.provider,
	)
		? new StaticSpacesAdapter(
				observeProviderFetch(
					"static-spaces",
					providerFetch(Object.values(staticSpacesOrigins)),
				),
			)
		: undefined;
	const executors = new ProviderExecutorRouter({
		...(staticSpaces
			? { [staticSpacesConnectionCatalog.providerReleaseId]: staticSpaces }
			: {}),
		[bitbucketServerConnectionCatalog.providerReleaseId]: bitbucket,
		...Object.fromEntries(
			bitbucketServerLegacyProviderReleaseIds.map((id) => [id, bitbucket]),
		),
		[githubConnectionCatalog.providerReleaseId]: github,
		[jiraServerConnectionCatalog.providerReleaseId]: jira,
		[confluenceServerConnectionCatalog.providerReleaseId]: confluence,
		[datalegoConnectionCatalog.providerReleaseId]: datalego,
		[datalegoV4ConnectionCatalog.providerReleaseId]: datalegoOAuthV4,
		[datalegoV5ConnectionCatalog.providerReleaseId]: datalegoOAuthV5,
		[datalegoV6ConnectionCatalog.providerReleaseId]: datalegoOAuth,
		[jenkinsCiConnectionCatalog.providerReleaseId]: jenkinsCi,
		[jenkinsReleaseConnectionCatalog.providerReleaseId]: jenkins,
		[manhattanConnectionCatalog.providerReleaseId]: manhattan,
		...Object.fromEntries(
			manhattanLegacyProviderReleaseIds.map((id) => [id, manhattan]),
		),
		[rehoboamConnectionCatalog.providerReleaseId]: rehoboam,
		...Object.fromEntries(
			rehoboamLegacyProviderReleaseIds.map((id) => [id, rehoboam]),
		),
	});
	const service = new ConnectionApplicationService(
		repository,
		executors,
		githubOAuth,
		{
			bitbucket,
			confluence,
			[datalegoOAuth.providerId]: datalegoOAuth,
			[jenkins.providerId]: jenkins,
			[jenkinsCi.providerId]: jenkinsCi,
			[manhattan.providerId]: manhattan,
			[rehoboam.providerId]: rehoboam,
			...(staticSpaces ? { [staticSpaces.providerId]: staticSpaces } : {}),
			jira,
		},
		{
			manhattan: manhattanOAuth,
			[datalegoOAuth.providerId]: datalegoOAuth,
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
				catalogs,
				githubRedirectUri: config.github.redirectUri,
				providerRedirectUris: {
					manhattan: config.manhattanOAuth.redirectUri,
					[datalegoOAuth.providerId]: config.datalegoOAuth.redirectUri,
				},
				service,
			},
			resource: config.resourceUrl,
			service: oauth,
		},
		providerServiceHostAliases: {
			"10.80.1.129": jenkinsReleaseConnectionCatalog.provider,
			"114.94.148.35": jenkinsReleaseConnectionCatalog.provider,
			"github.com": githubConnectionCatalog.provider,
			"datalego.agoralab.co": datalegoConnectionCatalog.provider,
			"datalego.la3d.agoralab.co": datalegoConnectionCatalog.provider,
			"jenkins-ci.agoralab.co": "jenkins-ci",
			"rehoboam.gz3.agoralab.co": rehoboamConnectionCatalog.provider,
			"justinia.gz3.agoralab.co": rehoboamConnectionCatalog.provider,
			"manhattan-api.agoralab.co": manhattanConnectionCatalog.provider,
			"static-spaces.sh3.agoralab.co": staticSpacesConnectionCatalog.provider,
			"publish-static-spaces.sh3.agoralab.co":
				staticSpacesConnectionCatalog.provider,
		},
		service,
		supportedProviders: [
			githubConnectionCatalog.provider,
			bitbucketServerConnectionCatalog.provider,
			jiraServerConnectionCatalog.provider,
			confluenceServerConnectionCatalog.provider,
			datalegoV5ConnectionCatalog.provider,
			jenkinsCiConnectionCatalog.provider,
			jenkinsReleaseConnectionCatalog.provider,
			rehoboamConnectionCatalog.provider,
			manhattanConnectionCatalog.provider,
			...catalogs
				.filter(
					(catalog) =>
						catalog.provider === staticSpacesConnectionCatalog.provider,
				)
				.map((catalog) => catalog.provider),
		],
	});
	return {
		app,
		closeProviderTransports: async () => {
			await Promise.all(transports.map((transport) => transport.close()));
		},
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

const githubOAuthTokenUrl = "https://github.com/login/oauth/access_token";
const githubOAuthProfileUrl = "https://api.github.com/user";
const proxyPreflightTransportErrors = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_SOCKET",
]);

export function createPreSubmitGithubOAuthAdapter(
	options: ConstructorParameters<typeof OpenConnectorGitHubOAuthAdapter>[0],
	primary: typeof fetch,
	selectExchangeFetcher: () => Promise<typeof fetch>,
): GitHubOAuthProvider {
	const defaultAdapter = new OpenConnectorGitHubOAuthAdapter({
		...options,
		fetcher: primary,
	});
	return {
		getAuthorizationUrl: (input) => {
			const authorizationUrl = defaultAdapter.getAuthorizationUrl(input);
			if (!input.requestedScopes) return authorizationUrl;
			const url = new URL(authorizationUrl);
			url.searchParams.set(
				"scope",
				[...input.requestedScopes].sort().join(" "),
			);
			return url.toString();
		},
		exchangeCode: async (input, onStage) => {
			const selected = await selectExchangeFetcher();
			const observedFetch: typeof fetch = (request, init) => {
				const url = request instanceof Request ? request.url : String(request);
				const method = (
					init?.method ?? (request instanceof Request ? request.method : "GET")
				).toUpperCase();
				if (url === githubOAuthTokenUrl && method === "POST")
					onStage?.("token_exchange");
				if (url === githubOAuthProfileUrl && method === "GET")
					onStage?.("profile_lookup");
				return selected(request, init);
			};
			return new OpenConnectorGitHubOAuthAdapter({
				...options,
				fetcher: observedFetch,
			}).exchangeCode(input);
		},
		refresh: (token) => defaultAdapter.refresh(token),
	};
}

export function createGithubOAuthFetcherSelector(
	primary: typeof fetch,
	direct: typeof fetch,
	onDirect: () => void = () => undefined,
) {
	return async (tokenUrl: string): Promise<typeof fetch> => {
		if (tokenUrl !== githubOAuthTokenUrl) return primary;
		let response: Response;
		try {
			response = await primary(tokenUrl, {
				method: "HEAD",
				redirect: "manual",
				signal: AbortSignal.timeout(5_000),
			});
		} catch (error) {
			const code = (error as { cause?: { code?: unknown } })?.cause?.code;
			if (
				!(error instanceof Error && error.name === "TimeoutError") &&
				!(typeof code === "string" && proxyPreflightTransportErrors.has(code))
			)
				throw error;
			onDirect();
			return direct;
		}
		void response.body?.cancel().catch(() => undefined);
		return primary;
	};
}

export function createGithubOAuthDirectFetch(
	transport: typeof fetch = createGuardedFetch({ maxRedirects: 0 }),
): typeof fetch {
	return async (input, init) => {
		const request = input instanceof Request ? input : undefined;
		const url = request?.url ?? String(input);
		const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
		if (
			!(
				(url === githubOAuthTokenUrl && method === "POST") ||
				(url === githubOAuthProfileUrl && method === "GET")
			)
		)
			throw new Error("GitHub OAuth direct target is not allowed");
		const response = await transport(input, { ...init, redirect: "manual" });
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel();
			throw new Error("GitHub OAuth direct redirect is not allowed");
		}
		return response;
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
