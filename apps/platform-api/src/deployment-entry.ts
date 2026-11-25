import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
	createDirectoryClient,
	requireCurrentSnapshot,
	resolveActiveMemberByEmail,
} from "@agent-infra/enterprise-directory";
import { createWecomEmployeeIdentity } from "@agent-infra/identity";
import { readOperationsConfigurationV2 } from "@agent-infra/observability/operations";
import {
	captureConnectionConsumerRegistrationPolicyV1,
	parseEvaluationAnalysisPolicyV1,
} from "@agent-infra/platform-core";
import {
	type ConnectionManualInstallationDeploymentV1,
	decideConnectionManualInstallationDeploymentV1,
	PostgresOidcIdentityStore,
	PostgresPlatformUserDisablesV1,
	readConnectionManualInstallationEnvironmentV1,
} from "@agent-infra/platform-store";
import {
	readConnectionConsumerEnvironmentConfigurationV1,
	readConnectionSystemAccessEnvironmentConfigurationV1,
} from "./connection-consumer-environment.js";
import {
	createProtectedConnectionInstallationForwarder,
	isProtectedConnectionCallbackAuthFileReadyV1,
} from "./connection-installation-callback-forwarder.js";
import {
	createProductionNativeMetadataReaderFromWorkerV1,
	inspectProductionRelayKeyPolicyV1,
	mergeProductionPlatformApiDeploymentPortsV1,
	resolveDeploymentSkillAgentVersionV1,
} from "./deployment.js";
import {
	createDirectoryOrganizationAuthorityResolverV1,
	createDirectoryOrganizationIdsResolverV1,
} from "./directory-authority.js";
import { createProductionPlatformFileDeploymentFromEnvironmentV1 } from "./file-deployment.js";
import {
	type AutomaticTemplatePublicationInputV1,
	createAutomaticTemplatePublicationAppV1,
	createPostgresOidcBrowserDeployment,
	createProductionPlatformApiAssemblyInputV1,
	createProductionSingleAgentTemplateReleaseAppV1,
	type ProductionTemplateUpgradeInputV2,
} from "./index.js";
import { createOidcEmployeeDirectory } from "./oidc-employee-directory.js";
import { loadPlatformApiSessionReserveDeploymentV1 } from "./session-reserve-deployment.js";
import { createTrustedProxyVerifier } from "./trusted-proxy.js";

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
	oidc,
	verifiedWecomMember,
	directorySnapshot,
	publicOrigin,
	connectionWebPath,
	connectionConsumerProfile,
	connectionConsumerProfileApproval,
	connectionSystemAccess,
	connectionSystemAccessApproval,
	connectionInstallationConfiguration,
	connectionManualInstallationClientName,
	connectionConsistencyExceptionApproval,
	connectionInstallationsByAgent,
	connectionInstallationsByAgentAndPrincipal,
	connectionInstallationCallback,
	connectionRegistrationOwnerRead,
	applicationCredentialDelivery,
	applicationCredentialMaterialDelivery,
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
	automaticTemplatePublication,
} = await import(configurationModule);

const connectionConsumerRegistration =
	apiInput?.connectionConsumerRegistration === undefined
		? undefined
		: captureConnectionConsumerRegistrationPolicyV1(
				apiInput.connectionConsumerRegistration,
			);

const sessionReserveDeployment =
	await loadPlatformApiSessionReserveDeploymentV1(
		apiInput?.sessionSandboxReserves,
		process.env.PLATFORM_API_SESSION_RESERVES_FILE,
	);

/** Private deployment readback; never registered as an HTTP route. */
export function readPlatformSessionReserveDeploymentV1() {
	return structuredClone(sessionReserveDeployment);
}

// Spec §13.5.7: per-Agent Consumers come only from associations. Static per-Agent
// deployment bindings are no longer accepted; their presence closes installation.
const staticPerAgentConnectionBindings =
	connectionInstallationsByAgent !== undefined ||
	connectionInstallationsByAgentAndPrincipal !== undefined;
const moduleSystemAccess =
	connectionSystemAccess !== undefined ||
	connectionSystemAccessApproval !== undefined;
const environmentSystemAccess =
	moduleSystemAccess ||
	connectionConsumerProfile !== undefined ||
	connectionConsumerProfileApproval !== undefined
		? undefined
		: readConnectionSystemAccessEnvironmentConfigurationV1(process.env);
const environmentConnectionConsumer =
	moduleSystemAccess ||
	environmentSystemAccess !== undefined ||
	connectionConsumerProfile !== undefined ||
	connectionConsumerProfileApproval !== undefined
		? undefined
		: readConnectionConsumerEnvironmentConfigurationV1(process.env);
if (apiInput?.evaluation?.loadAnalysisPolicy)
	parseEvaluationAnalysisPolicyV1(
		await apiInput.evaluation.loadAnalysisPolicy(),
	);

const resolvedConnectionConsumerProfile =
	connectionConsumerProfile ?? environmentConnectionConsumer?.profile;
const resolvedConnectionConsumerProfileApproval =
	connectionConsumerProfileApproval ?? environmentConnectionConsumer?.approval;
const resolvedConnectionWebPath =
	connectionWebPath ??
	environmentSystemAccess?.webPath ??
	environmentConnectionConsumer?.webPath;
const resolvedConnectionSystemAccess = moduleSystemAccess
	? { system: connectionSystemAccess, approval: connectionSystemAccessApproval }
	: environmentSystemAccess
		? {
				system: environmentSystemAccess.system,
				approval: environmentSystemAccess.approval,
			}
		: undefined;

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
	return {
		baseUrl,
		serviceToken,
		instanceUid: process.env.PLATFORM_API_NATIVE_METADATA_INSTANCE_UID,
	};
}

// Helm/local deployment inputs may provide the fixed Worker ingress without
// editing the deployment module. A module export remains authoritative.
const nativeMetadataWorker =
	configuredNativeMetadataWorker ??
	(nativeMetadata === undefined
		? await nativeMetadataWorkerFromEnvironment()
		: undefined);
const databaseUrl = process.env.PLATFORM_DATABASE_URL;
const operations = await readOperationsConfigurationV2().catch(() => {
	console.warn(
		JSON.stringify({
			service: "platform-api",
			code: "OPERATIONS_CONFIGURATION_UNAVAILABLE",
		}),
	);
	return undefined;
});
if (!databaseUrl) throw new Error("PLATFORM_DATABASE_URL is required");
const deploymentAgentVersion = resolveDeploymentSkillAgentVersionV1(
	apiInput?.agentVersion,
	process.env.AGENT_INFRA_AGENT_VERSION,
);
const configuredDatabaseUrl = databaseUrl;
if (!oidc || !directorySnapshot)
	throw new Error("OIDC and directory snapshot configuration are required");
if (typeof directorySearch !== "function")
	throw new Error("Directory search authority is required");
const organizationAuthority =
	createDirectoryOrganizationAuthorityResolverV1(directorySnapshot);
const organizationIds =
	createDirectoryOrganizationIdsResolverV1(directorySnapshot);
const tokenFile = process.env.PLATFORM_API_PROXY_TOKEN_FILE;
if (!tokenFile?.startsWith("/")) {
	throw new Error("PLATFORM_API_PROXY_TOKEN_FILE must be an absolute path");
}
const trustedProxyToken = await readFile(tokenFile, "utf8");
const oidcStore = new PostgresOidcIdentityStore(databaseUrl);
const directory = createOidcEmployeeDirectory(
	oidc,
	oidcStore,
	createDirectoryClient(directorySnapshot),
);
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
const browser = createPostgresOidcBrowserDeployment({
	oidc: {
		...oidc,
		store: oidcStore,
		verifiedAccount: directory.verifiedAccount,
	},
	databaseUrl,
	directory,
	isPlatformDisabled: userGovernance.isPlatformDisabled.bind(userGovernance),
	organizationIds,
	organizationAuthority,
	publicOrigin,
	trustedProxyToken,
});
// #4199 C2 (Spec §13.5.1): the M1 exception route opens only for the approved
// one-time system access plus an exception approval record that passes its
// schema, is bound to that access and has not expired, with the Principals
// confirmed outside the exception resolved from the Platform DB. The module's
// `apiInput.connectionInstallation.manualInstallation` is never a source.
const manualInstallationEnvironment =
	readConnectionManualInstallationEnvironmentV1(process.env);
const manualExceptionApproval =
	connectionConsistencyExceptionApproval ??
	manualInstallationEnvironment.exceptionApproval;
const manualInstallationRequested =
	manualExceptionApproval !== undefined ||
	connectionManualInstallationClientName !== undefined ||
	apiInput?.connectionInstallation?.manualInstallation !== undefined;
const connectionCallbackAuthFile =
	process.env.PLATFORM_API_CONNECTION_CALLBACK_AUTH_FILE;
// The configuration module is imported at runtime, so its callback forwarder
// counts only with a callable `forward`; the same value decides readiness and
// is the one handed to the assembly. A malformed export is never used.
const moduleCallbackForwarder =
	typeof (connectionInstallationCallback as { forward?: unknown } | undefined)
		?.forward === "function"
		? connectionInstallationCallback
		: undefined;
// §13.5.6: a manual installation is confirmed only through its callback, so the
// route needs a protected delivery to the original Host: the deployment
// module's forwarder, or a callback-only credential file that passes the
// forwarder's protected-file checks now. Otherwise the route stays dormant.
const manualCallbackDelivery =
	manualExceptionApproval !== undefined &&
	(moduleCallbackForwarder !== undefined ||
		(await isProtectedConnectionCallbackAuthFileReadyV1(
			connectionCallbackAuthFile,
		)))
		? "ready"
		: "unavailable";
// The Worker entry takes the same decision from the same inputs (#4199 C2).
const manualInstallation: ConnectionManualInstallationDeploymentV1 =
	await decideConnectionManualInstallationDeploymentV1({
		exceptionApproval: manualExceptionApproval,
		clientName:
			connectionManualInstallationClientName ??
			manualInstallationEnvironment.clientName,
		standardInstallationConfigured:
			staticPerAgentConnectionBindings ||
			connectionInstallationConfiguration !== undefined,
		...(resolvedConnectionSystemAccess
			? { systemAccess: resolvedConnectionSystemAccess }
			: {}),
		callbackDelivery: manualCallbackDelivery,
		databaseUrl,
	});
if (manualInstallation.status === "enabled")
	console.info(
		JSON.stringify({
			service: "platform-api",
			code: "CONNECTION_MANUAL_INSTALLATION_ENABLED",
			receipt: manualInstallation.receipt,
		}),
	);
else if (manualInstallationRequested)
	console.warn(
		JSON.stringify({
			service: "platform-api",
			code: "CONNECTION_MANUAL_INSTALLATION_DORMANT",
			reason: manualInstallation.reason,
		}),
	);
// The callback route forwards every claimed callback, manual ones included, to the
// original Host with the callback-only credential (Spec §13.5.6); without it the
// route stays closed.
const callbackForwarder =
	moduleCallbackForwarder ??
	(((connectionInstallationConfiguration &&
		!staticPerAgentConnectionBindings) ||
		manualInstallation.status === "enabled") &&
	connectionCallbackAuthFile
		? {
				forward: createProtectedConnectionInstallationForwarder({
					authFile: connectionCallbackAuthFile,
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

function assembleManualStandardTemplateReleaseApp() {
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

const employeeWecomAuthority =
	verifiedWecomMember !== undefined
		? createWecomEmployeeIdentity(
				{
					snapshot: createDirectoryClient(directorySnapshot),
					organizationIdForDepartment:
						directorySnapshot.organizationIdForDepartment,
					administratorUserIds: oidc.administratorUserIds,
					verifiedWecomMember,
				},
				oidcStore,
				(id) => userGovernance.isPlatformDisabled(id),
			)
		: undefined;
export const browserAuth = browser.browserAuth;
function assembleStandardTemplateReleaseApp() {
	const manual = assembleManualStandardTemplateReleaseApp();
	if (automaticTemplatePublication === undefined) return manual;
	if (
		!automaticTemplatePublication ||
		typeof automaticTemplatePublication.loadBinding !== "function" ||
		typeof automaticTemplatePublication.resolveAdministrator !== "function" ||
		!(
			typeof automaticTemplatePublication.serviceAuthentication?.currentKey ===
				"function" ||
			(typeof automaticTemplatePublication.resolveService === "function" &&
				typeof automaticTemplatePublication.isServiceCurrent === "function")
		)
	)
		throw new Error("PLATFORM_TEMPLATE_PUBLICATION_CONFIGURATION_INVALID");
	const automatic = createAutomaticTemplatePublicationAppV1({
		...apiInput,
		databaseUrl: configuredDatabaseUrl,
		identity: browser.identity,
		automaticPublication:
			automaticTemplatePublication as AutomaticTemplatePublicationInputV1,
	});
	if (!manual) return automatic;
	manual.app.route("/", automatic.app);
	return {
		app: manual.app,
		close: async () => {
			await Promise.all([manual.close(), automatic.close()]);
		},
	};
}
export const standardTemplateReleaseApp = assembleStandardTemplateReleaseApp();

if (
	connectionRegistrationOwnerRead !== undefined &&
	(!connectionConsumerRegistration ||
		!directorySnapshot ||
		!connectionRegistrationOwnerRead ||
		!/^[a-f0-9]{64}$/.test(
			connectionRegistrationOwnerRead.credentialHash ?? "",
		) ||
		!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(
			connectionRegistrationOwnerRead.directorySource ?? "",
		))
)
	throw new Error("CONNECTION_REGISTRATION_OWNER_CONFIGURATION_INVALID");
const registrationDirectory = connectionRegistrationOwnerRead
	? createDirectoryClient(directorySnapshot)
	: undefined;
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
		employeeWecomAuthority,
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
		...(operations ? { operations } : {}),
		...(deploymentAgentVersion !== undefined
			? { agentVersion: deploymentAgentVersion }
			: {}),
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
		...(resolvedConnectionSystemAccess
			? {
					connectionSystemAccess: resolvedConnectionSystemAccess.system,
					connectionSystemAccessApproval:
						resolvedConnectionSystemAccess.approval,
				}
			: {}),
		connectionWebPath: resolvedConnectionWebPath,
		connectionConsumerRegistration,
		connectionRegistrationOwnerRead:
			connectionRegistrationOwnerRead && registrationDirectory
				? {
						credentialHash: connectionRegistrationOwnerRead.credentialHash,
						directorySource: connectionRegistrationOwnerRead.directorySource,
						readIdentity: async (ownerId, signal) => {
							signal.throwIfAborted();
							const account = await directory.currentByUserId(ownerId);
							if (
								!account ||
								account.userId !== ownerId ||
								account.accountStatus !== "active"
							)
								return undefined;
							signal.throwIfAborted();
							const snapshot = requireCurrentSnapshot(
								await createDirectoryClient({
									...directorySnapshot,
									fetch: (target, init) =>
										(directorySnapshot.fetch ?? fetch)(target, {
											...init,
											signal: AbortSignal.any([
												signal,
												...(init?.signal ? [init.signal] : []),
											]),
										}),
								}).loadCurrent(),
							);
							if (
								snapshot.source !==
								connectionRegistrationOwnerRead.directorySource
							)
								return undefined;
							const member = resolveActiveMemberByEmail(
								snapshot,
								account.email,
							);
							signal.throwIfAborted();
							signal.throwIfAborted();
							const current = await directory.currentByUserId(ownerId);
							signal.throwIfAborted();
							if (
								!member ||
								!current ||
								current.userId !== ownerId ||
								current.accountStatus !== "active" ||
								current.authorizationRevision !==
									account.authorizationRevision ||
								current.email !== account.email
							)
								return undefined;
							return {
								userId: ownerId,
								accountStatus: "active",
								wechatUserId: member.userId,
								email: member.email,
								expiresAt: snapshot.validUntil,
								revision: createHash("sha256")
									.update(
										JSON.stringify([
											account.authorizationRevision,
											snapshot.source,
											member.userId,
											member.email,
											member.active,
										]),
									)
									.digest("hex"),
							};
						},
					}
				: undefined,
		...(connectionInstallationConfiguration && !staticPerAgentConnectionBindings
			? {
					connectionInstallation: {
						configuration: connectionInstallationConfiguration,
						publicOrigin,
					},
				}
			: {}),
		...(manualInstallation.status === "enabled"
			? {
					connectionManualInstallation: {
						publicOrigin,
						policy: structuredClone(manualInstallation.policy),
					},
				}
			: {}),
		...(callbackForwarder
			? {
					connectionInstallationCallback: {
						forward: callbackForwarder.forward,
						isTrustedProxyRequest:
							createTrustedProxyVerifier(trustedProxyToken),
					},
				}
			: {}),
		...(applicationCredentialMaterialDelivery
			? { applicationCredentialMaterialDelivery }
			: {}),
		...(applicationCredentialDelivery ? { applicationCredentialDelivery } : {}),
		databaseUrl: configuredDatabaseUrl,
		identity: browser.identity,
	});
}
