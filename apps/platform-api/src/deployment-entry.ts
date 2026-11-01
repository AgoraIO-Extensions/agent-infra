import { readFile } from "node:fs/promises";
import { createLdapIdentityDirectory } from "@agent-infra/identity";
import { parseEvaluationAnalysisPolicyV1 } from "@agent-infra/platform-core";
import { PostgresPlatformUserDisablesV1 } from "@agent-infra/platform-store";
import { readConnectionConsumerEnvironmentConfigurationV1 } from "./connection-consumer-environment.js";
import { createProtectedConnectionInstallationForwarder } from "./connection-installation-callback-forwarder.js";
import {
	createProductionNativeMetadataReaderFromWorkerV1,
	inspectProductionRelayKeyPolicyV1,
	mergeProductionPlatformApiDeploymentPortsV1,
} from "./deployment.js";
import {
	createDirectoryOrganizationAuthorityResolverV1,
	createDirectoryOrganizationIdsResolverV1,
} from "./directory-authority.js";
import { createProductionPlatformFileDeploymentFromEnvironmentV1 } from "./file-deployment.js";
import {
	createPostgresLdapBrowserDeployment,
	createProductionPlatformApiAssemblyInputV1,
	createProductionSingleAgentTemplateReleaseAppV1,
	type ProductionTemplateUpgradeInputV2,
} from "./index.js";
import { loadPlatformApiSessionReserveDeploymentV1 } from "./session-reserve-deployment.js";

interface DeploymentStandardTemplateReleaseInputV1 {
	readonly target: Parameters<
		typeof createProductionSingleAgentTemplateReleaseAppV1
	>[0]["target"];
	readonly loadReleaseBinding: Parameters<
		typeof createProductionSingleAgentTemplateReleaseAppV1
	>[0]["loadReleaseBinding"];
	readonly templateUpgrade?: ProductionTemplateUpgradeInputV2;
}

// The mounted module supplies current directory, policy, Registry and catalog facts.
// Credentials remain in API-only files; the proxy token is a separate Compose Secret.
const configurationModule = process.env.PLATFORM_API_CONFIGURATION_MODULE;
if (!configurationModule || new URL(configurationModule).protocol !== "file:") {
	throw new Error("PLATFORM_API_CONFIGURATION_MODULE must be a file URL");
}
const {
	ldap,
	organizationIds: configuredOrganizationIds,
	directorySnapshot,
	publicOrigin,
	connectionWebPath,
	connectionConsumerProfile,
	connectionConsumerProfileApproval,
	connectionInstallationConfiguration,
	connectionInstallationsByAgent,
	connectionInstallationCallback,
	applicationCredentialDelivery,
	apiInput,
	customAgentGateway,
	modelSelection,
	modelDirectory,
	savedKeyCandidates,
	nativeMetadata,
	nativeMetadataWorker: configuredNativeMetadataWorker,
	nativeMetadataResolveRequest,
	nativeMetadataRequestRegistry,
	nativeMetadataCurrent,
	nativeCapabilityInvocation,
	nativeCapabilityMetadata,
	browserCommands,
	providerImport,
	directorySearch,
	standardTemplateReleaseInput,
} = await import(configurationModule);

const sessionReserveDeployment =
	await loadPlatformApiSessionReserveDeploymentV1(
		apiInput?.sessionSandboxReserves,
		process.env.PLATFORM_API_SESSION_RESERVES_FILE,
	);

/** Private deployment readback; never registered as an HTTP route. */
export function readPlatformSessionReserveDeploymentV1() {
	return structuredClone(sessionReserveDeployment);
}

const environmentConnectionConsumer =
	connectionConsumerProfile === undefined &&
	connectionConsumerProfileApproval === undefined
		? readConnectionConsumerEnvironmentConfigurationV1(process.env)
		: undefined;
if (apiInput?.evaluation?.loadAnalysisPolicy)
	parseEvaluationAnalysisPolicyV1(
		await apiInput.evaluation.loadAnalysisPolicy(),
	);

const resolvedConnectionConsumerProfile =
	connectionConsumerProfile ?? environmentConnectionConsumer?.profile;
const resolvedConnectionConsumerProfileApproval =
	connectionConsumerProfileApproval ?? environmentConnectionConsumer?.approval;
const resolvedConnectionWebPath =
	connectionWebPath ?? environmentConnectionConsumer?.webPath;

async function nativeMetadataWorkerFromEnvironment() {
	const baseUrl = process.env.PLATFORM_API_NATIVE_METADATA_WORKER_ORIGIN;
	const tokenFile =
		process.env.PLATFORM_API_NATIVE_METADATA_WORKER_SERVICE_TOKEN_FILE;
	if (baseUrl === undefined || baseUrl === "") return undefined;
	let origin: URL;
	try {
		origin = new URL(baseUrl ?? "");
	} catch {
		throw new Error(
			"PLATFORM_API_NATIVE_METADATA_WORKER_CONFIGURATION_INVALID",
		);
	}
	const localOrigin =
		process.env.PLATFORM_API_NATIVE_METADATA_WORKER_LOCAL === "true";
	const localPort = Number(origin.port);
	const releaseScopedService =
		/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?-platform-worker-native-metadata$/.test(
			origin.hostname,
		);
	if (
		origin.protocol !== "http:" ||
		(origin.hostname !== "platform-worker-native-metadata" &&
			!releaseScopedService) ||
		(localOrigin
			? !Number.isSafeInteger(localPort) || localPort < 1 || localPort > 65_535
			: origin.port !== "") ||
		origin.pathname !== "/" ||
		origin.username ||
		origin.password ||
		origin.search ||
		origin.hash ||
		!tokenFile?.startsWith("/")
	)
		throw new Error(
			"PLATFORM_API_NATIVE_METADATA_WORKER_CONFIGURATION_INVALID",
		);
	let serviceToken: string;
	try {
		serviceToken = (await readFile(tokenFile, "utf8")).trim();
	} catch {
		throw new Error(
			"PLATFORM_API_NATIVE_METADATA_WORKER_CONFIGURATION_INVALID",
		);
	}
	if (!serviceToken)
		throw new Error(
			"PLATFORM_API_NATIVE_METADATA_WORKER_CONFIGURATION_INVALID",
		);
	return { baseUrl, serviceToken };
}

// Helm/local deployment inputs may provide the fixed Worker ingress without
// editing the deployment module. A module export remains authoritative.
const nativeMetadataWorker =
	configuredNativeMetadataWorker ??
	(nativeMetadata === undefined
		? await nativeMetadataWorkerFromEnvironment()
		: undefined);
const databaseUrl = process.env.PLATFORM_DATABASE_URL;
if (!databaseUrl) throw new Error("PLATFORM_DATABASE_URL is required");
const configuredDatabaseUrl = databaseUrl;
if (typeof ldap?.verifyCurrentStatus !== "function") {
	throw new Error("LDAP current account authority is required");
}
if (typeof directorySearch !== "function") {
	throw new Error("Directory search authority is required");
}
let organizationIds = configuredOrganizationIds;
let organizationAuthority:
	| ReturnType<typeof createDirectoryOrganizationAuthorityResolverV1>
	| undefined;
if (directorySnapshot !== undefined) {
	organizationAuthority =
		createDirectoryOrganizationAuthorityResolverV1(directorySnapshot);
	organizationIds = createDirectoryOrganizationIdsResolverV1(directorySnapshot);
}
if (typeof organizationIds !== "function") {
	throw new Error("Directory organization authority is required");
}
const tokenFile = process.env.PLATFORM_API_PROXY_TOKEN_FILE;
if (!tokenFile?.startsWith("/")) {
	throw new Error("PLATFORM_API_PROXY_TOKEN_FILE must be an absolute path");
}
const trustedProxyToken = await readFile(tokenFile, "utf8");
const directory = createLdapIdentityDirectory(ldap);
const userGovernance = new PostgresPlatformUserDisablesV1(
	databaseUrl,
	async (userId) => {
		const account = await directory.currentByUserId(userId);
		return account
			? {
					userId: account.userId,
					accountStatus: account.accountStatus,
					isSystemAdmin: account.roles.includes("system_admin"),
				}
			: null;
	},
);
const browser = createPostgresLdapBrowserDeployment({
	databaseUrl,
	directory,
	isPlatformDisabled: userGovernance.isPlatformDisabled.bind(userGovernance),
	organizationIds,
	...(organizationAuthority ? { organizationAuthority } : {}),
	publicOrigin,
	trustedProxyToken,
});
const callbackForwarder =
	connectionInstallationCallback ??
	((connectionInstallationConfiguration || connectionInstallationsByAgent) &&
	process.env.PLATFORM_API_CONNECTION_CALLBACK_AUTH_FILE
		? {
				forward: createProtectedConnectionInstallationForwarder({
					authFile: process.env.PLATFORM_API_CONNECTION_CALLBACK_AUTH_FILE,
				}),
			}
		: undefined);

if (
	nativeMetadata !== undefined &&
	(nativeMetadataWorker !== undefined ||
		nativeMetadataResolveRequest !== undefined)
)
	throw new Error("PLATFORM_NATIVE_METADATA_DUPLICATE");
if (
	nativeMetadataResolveRequest !== undefined &&
	(nativeMetadataWorker === undefined ||
		nativeMetadataRequestRegistry === undefined ||
		nativeMetadataCurrent === undefined)
)
	throw new Error("PLATFORM_NATIVE_METADATA_CONFIGURATION_INVALID");

/**
 * File exchange re-resolves the signed actor against current directory and
 * Platform disable facts through the same current identity mapping as browser
 * sessions; it never reuses a browser session or a stale request identity.
 * Dependency failures propagate and deny the exchange.
 */
const fileDeployment =
	await createProductionPlatformFileDeploymentFromEnvironmentV1({
		resolveActor: (actorId) => browser.resolveCurrentIdentity(actorId),
	});

function assembleStandardTemplateReleaseApp() {
	if (standardTemplateReleaseInput === undefined) return undefined;
	if (
		typeof standardTemplateReleaseInput !== "object" ||
		standardTemplateReleaseInput === null ||
		!("target" in standardTemplateReleaseInput) ||
		!("loadReleaseBinding" in standardTemplateReleaseInput) ||
		typeof standardTemplateReleaseInput.loadReleaseBinding !== "function"
	)
		return undefined;
	const input =
		standardTemplateReleaseInput as DeploymentStandardTemplateReleaseInputV1;
	return createProductionSingleAgentTemplateReleaseAppV1({
		...apiInput,
		databaseUrl: configuredDatabaseUrl,
		identity: browser.identity,
		loadAuthorityContext: apiInput.loadAuthorityContext,
		target: input.target,
		loadReleaseBinding: input.loadReleaseBinding,
		...(input.templateUpgrade
			? { templateUpgrade: input.templateUpgrade }
			: {}),
	});
}

export const browserAuth = browser.browserAuth;
export const standardTemplateReleaseApp = assembleStandardTemplateReleaseApp();
export function createPlatformApiAssemblyInput() {
	const relayKeyPolicy = inspectProductionRelayKeyPolicyV1(apiInput);
	if (relayKeyPolicy.missing.length > 0)
		console.warn(
			JSON.stringify({
				service: "platform-api",
				status: "degraded",
				code: "PLATFORM_RELAY_KEY_POLICY_MISSING",
				fields: relayKeyPolicy.missing,
			}),
		);
	const assembledNativeMetadata =
		nativeMetadata ??
		(nativeMetadataWorker && nativeMetadataResolveRequest
			? {
					reader: createProductionNativeMetadataReaderFromWorkerV1({
						requestRegistry: nativeMetadataRequestRegistry,
						resolveRequest: nativeMetadataResolveRequest,
						worker: nativeMetadataWorker,
					}),
				}
			: undefined);
	const configuredApiInput = mergeProductionPlatformApiDeploymentPortsV1({
		apiInput,
		...(customAgentGateway !== undefined ? { customAgentGateway } : {}),
		...(modelSelection !== undefined ? { modelSelection } : {}),
		...(modelDirectory !== undefined ? { modelDirectory } : {}),
		...(savedKeyCandidates !== undefined ? { savedKeyCandidates } : {}),
		...(assembledNativeMetadata !== undefined
			? { nativeMetadata: assembledNativeMetadata }
			: {}),
		...(nativeMetadataWorker !== undefined &&
		nativeMetadataResolveRequest === undefined
			? { nativeMetadataWorker }
			: {}),
		...(nativeMetadataCurrent !== undefined ? { nativeMetadataCurrent } : {}),
		...(nativeCapabilityInvocation !== undefined
			? { nativeCapabilityInvocation }
			: {}),
		...(nativeCapabilityMetadata !== undefined
			? { nativeCapabilityMetadata }
			: {}),
		...(browserCommands !== undefined ? { browserCommands } : {}),
		...(providerImport !== undefined ? { providerImport } : {}),
		...(fileDeployment !== undefined ? { files: fileDeployment } : {}),
	});
	return createProductionPlatformApiAssemblyInputV1({
		...configuredApiInput,
		...(sessionReserveDeployment.configuration
			? {
					sessionSandboxReserves: structuredClone(
						sessionReserveDeployment.configuration,
					),
				}
			: {}),

		userGovernance,
		directory: { identity: browser.identity, search: directorySearch },
		connectionConsumerProfile: resolvedConnectionConsumerProfile,
		connectionConsumerProfileApproval:
			resolvedConnectionConsumerProfileApproval,
		connectionWebPath: resolvedConnectionWebPath,
		...(connectionInstallationConfiguration || connectionInstallationsByAgent
			? {
					connectionInstallation: {
						configuration: connectionInstallationConfiguration,
						bindingsByAgent: connectionInstallationsByAgent,
						publicOrigin,
					},
				}
			: {}),
		...(callbackForwarder
			? { connectionInstallationCallback: callbackForwarder }
			: {}),
		...(applicationCredentialDelivery ? { applicationCredentialDelivery } : {}),
		databaseUrl: configuredDatabaseUrl,
		identity: browser.identity,
	});
}
