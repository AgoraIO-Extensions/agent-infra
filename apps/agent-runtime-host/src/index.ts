import { createPublicKey, type KeyObject } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	CodexSessionExecutorAdmissionV1,
	ExecutorIdentityV1,
	RuntimeBrowserCapabilityAssemblyV1,
	RuntimeHostOptions,
} from "@agent-infra/agent-runtime";
import {
	admittedCorePod,
	assertRegisteredProvider,
	ClaudeRuntimeDriver,
	CodexRuntimeDriver,
	createAppliedRuntimeSkillDirectoryV1,
	createExecutionGrantVerifier,
	createRuntimeControlObserverV1,
	createRuntimeExecutionGrantValidatorV4,
	createRuntimeExecutionGrantValidatorV5,
	createRuntimeExecutionGrantValidatorV6,
	createRuntimeExecutionGrantVerifierV2,
	createRuntimeExecutionKeyRecoveryValidatorV4,
	createRuntimeExecutionKeyRecoveryValidatorV5,
	createWorkloadReadinessVerifierV1,
	discoverRuntimeBrowserCapabilityV1,
	executorControlRequestV1,
	executorRunnerControlOriginV1,
	FakeRuntimeDriver,
	FileRuntimeStore,
	openCodexSessionExecutorAdmissionV1,
	openOpenCodeRuntime,
	openPiRuntime,
	pinCodexSessionExecutorEpochV1,
	providerEvidenceEnv,
	providerImageEnv,
	type RuntimeExternalActionAuthorization,
	RuntimeHost,
	RuntimeHostError,
	resolveProviderRegistration,
	selectProviderDeploymentBinding,
	supportsProtectedOpenCodeMcpTransport,
	supportsProtectedPiMcpTransport,
	verifyCodexPilotInstallation,
} from "@agent-infra/agent-runtime";
import type {
	ExecutionGrantV1,
	RuntimeBusinessRequestV4,
	RuntimeExecutionGrantV2,
	RuntimeNativeCapabilityRequestV5,
	RuntimeRestoreExecutionKeyRequestV4,
	RuntimeRestoreExecutionKeyRequestV5,
	VerifiedExecutionGrantV1,
	VerifiedRuntimeExecutionGrantV2,
} from "@agent-infra/contracts/runtime";
import { startObservability } from "@agent-infra/observability";
import { getRequestListener, serve } from "@hono/node-server";
import { createRuntimeHostApp, runtimeHostService } from "./app.js";
import { probeRuntimeBrowserCapabilityV1 } from "./browser-capability-probe.js";
import { createSessionBrowserExecutionContextV1 } from "./browser-session-provider.js";
import {
	readCodexInstalledSkillDeployment,
	readCodexIsolationMode,
	readCodexPilotConfiguration,
	readCodexSessionExecutorBindingV1,
	readRuntimeFileExchangeOptions,
	readRuntimeModelConfigurationV3,
	readRuntimeModelConfigurationV4,
	readSessionScopeAttestationV1,
	readWorkloadReadinessBindingV1,
	runtimeConfigurationInvalid,
} from "./configuration.js";
import {
	createIndependentConnectionClientInput,
	readConnectionClientProfile,
} from "./connection-client-input.js";
import {
	type RuntimeConnectionConsumerProfile,
	readRuntimeConnectionConsumerProfile,
} from "./connection-consumer-profile.js";
import {
	type ConnectionInstallReceiverAssemblyV1,
	dynamicConnectionClientForReaderV1,
	prepareConnectionInstallReceiverV1,
	startConnectionInstallReceiverServerV1,
} from "./connection-install-receiver.js";
import {
	establishCredentialHolderSessionScopeV1,
	protectCredentialHolderProcessV1,
} from "./credential-holder-protection.js";
import { openExecutorDrainHostV1 } from "./executor-drain-host.js";
import { consumeExecutorIdentityV1 } from "./executor-identity-startup.js";
import {
	type RuntimeLegacyMigrationFilesystem,
	readRuntimeLegacyMigrationV1,
} from "./legacy-migration.js";
import {
	previewRuntimeLegacyMigration,
	readRuntimeLegacyJournal,
} from "./legacy-migration-journal.js";
import {
	createRuntimeNativeMetadataCurrentAssemblyV1,
	createRuntimeNativeMetadataReadV1,
	type RuntimeNativeMetadataReadAssemblyV1,
} from "./native-metadata-assembly.js";
import { createRuntimeNativeMetadataCurrentClientV1 } from "./native-metadata-current-client.js";
import { createRuntimeNativeMetadataProofVerifierV1 } from "./native-metadata-proof.js";
import {
	createRuntimeOriginalAdmissionCheckV1,
	type RuntimeOriginalAdmissionCheckV1,
} from "./original-admission-check.js";
import { assertRuntimeProcessProtection } from "./process-protection.js";
import { createRuntimeFileBridgeFactoryV1 } from "./runtime-file-exchange.js";
import {
	createRuntimeOAuthApp,
	prepareRuntimeOAuth,
	type RuntimeOAuthAssembly,
} from "./runtime-oauth.js";
import {
	openRuntimeSafetyEvidenceV1,
	type RuntimeSafetyEvidenceAssemblyV1,
} from "./safety-evidence.js";
import { createSessionInstanceReaderV1 } from "./session-instance.js";
import {
	readRuntimeSkillHubBindingV1,
	runtimeSkillHubMountRootV1,
} from "./skill-hub-configuration.js";
import { createProtectedStandardMcpInput } from "./standard-mcp-input.js";
import { receiveProtectedStandardMcpInstallation } from "./standard-mcp-installation.js";
import { assertStandardMcpProcessProtection } from "./standard-mcp-protection.js";
import { runtimeHostStartupFailureReasonV1 } from "./startup-diagnostics.js";

export { createRuntimeHostApp, runtimeHostService } from "./app.js";
export {
	createRuntimeNativeMetadataCurrentAssemblyV1,
	createRuntimeNativeMetadataReadV1,
	type RuntimeNativeMetadataReadAssemblyV1,
} from "./native-metadata-assembly.js";
export { createRuntimeNativeMetadataCurrentClientV1 } from "./native-metadata-current-client.js";
export { createRuntimeNativeMetadataProofVerifierV1 } from "./native-metadata-proof.js";

interface StartOptions {
	corePod?: ReturnType<typeof admittedCorePod>;
	sessionInstanceRead?: ReturnType<typeof createSessionInstanceReaderV1>;
	executorInstanceRead?: (
		request: import("@agent-infra/contracts/runtime").ExecutorInstanceAdoptionReadV2,
	) => Promise<
		import("@agent-infra/contracts/runtime").ExecutorInstanceAdoptionV2
	>;
	browserCapability?:
		| RuntimeBrowserCapabilityAssemblyV1
		| (() => RuntimeBrowserCapabilityAssemblyV1 | undefined);
	oauth?: RuntimeOAuthAssembly;
	connectionInstall?: ConnectionInstallReceiverAssemblyV1;
	connectionConsumer?: RuntimeConnectionConsumerProfile;
	readinessWorkerId?: string;
	runtimeWorkerId?: string;
	verifyGrantV2?: (
		grant: RuntimeExecutionGrantV2,
	) =>
		| VerifiedRuntimeExecutionGrantV2
		| Promise<VerifiedRuntimeExecutionGrantV2>;
	verifyGrantV4?: (request: unknown) => Promise<{
		request: RuntimeBusinessRequestV4;
		claims: import("@agent-infra/contracts/runtime").RuntimeBusinessGrantClaimsV4;
	}>;
	verifyRecoveryGrantV4?: (request: unknown) => Promise<{
		request: RuntimeRestoreExecutionKeyRequestV4;
		claims: import("@agent-infra/contracts/runtime").RuntimeRestoreExecutionKeyGrantClaimsV4;
	}>;
	verifyGrantV5?: (request: unknown) => Promise<{
		request: RuntimeNativeCapabilityRequestV5;
		claims: import("@agent-infra/contracts/runtime").RuntimeBusinessGrantClaimsV4;
	}>;
	verifyGrantV6?: RuntimeHostOptions["validateGrantV6"];
	verifyRecoveryGrantV5?: (request: unknown) => Promise<{
		request: RuntimeRestoreExecutionKeyRequestV5;
		claims: import("@agent-infra/contracts/runtime").RuntimeRestoreExecutionKeyGrantClaimsV5;
	}>;
	nativeMetadataRead?: (
		request: import("@agent-infra/contracts/runtime").RuntimeNativeMetadataReadRequestV1,
		signal: AbortSignal,
	) => Promise<unknown>;
	/** Evidence log of an enabled acceptance window; absent by default (Spec §18.5.1). */
	safetyEvidence?: RuntimeSafetyEvidenceAssemblyV1["log"];
	/** #4358 I3: present only when the deployment enables the check. */
	originalAdmissionCheck?: RuntimeOriginalAdmissionCheckV1;
	host: RuntimeHost;
	serviceToken: string;
	verifyGrant: (
		grant: ExecutionGrantV1,
	) => VerifiedExecutionGrantV1 | Promise<VerifiedExecutionGrantV1>;
	log?: (message: string) => void;
	port?: number;
	configVersion?: string;
}

export type RuntimeHostAssemblyOptionsV1 = Pick<
	RuntimeHostOptions,
	"createBrowserExecutionContext" | "providerDeploymentBinding"
> & {
	/** Deployment-owned Worker proof/current binding for native metadata reads. */
	nativeMetadataRead?: RuntimeNativeMetadataReadAssemblyV1;
	/** Explicit composition input only; no production caller supplies this before step 4. */
	sessionInstanceEvidence?: {
		readonly profileDigest: string;
		readonly hostKeyId: string;
	};
	/**
	 * §13.5.6 install receiver preparation (Codex only) on the opened Host
	 * store; its dynamic reader backs the Codex Driver's declared Connection
	 * tools. Absent, the production entry prepares the receiver from the
	 * Worker-rendered deployment input (#4199); callers override it only in tests.
	 */
	prepareConnectionInstall?: (
		store: FileRuntimeStore,
	) => Promise<ConnectionInstallReceiverAssemblyV1 | undefined>;
};

export interface RuntimeNativeMetadataDeploymentModuleV1 {
	createRuntimeNativeMetadataReadAssembly(input: {
		readonly environment: NodeJS.ProcessEnv;
		readonly host: RuntimeHost;
		readonly current: ReturnType<
			typeof createRuntimeNativeMetadataCurrentClientV1
		>;
	}):
		| RuntimeNativeMetadataReadAssemblyV1
		| Promise<RuntimeNativeMetadataReadAssemblyV1>;
}

export async function createRuntimeNativeMetadataDeploymentAssemblyV1(input: {
	readonly environment: NodeJS.ProcessEnv;
	readonly host: RuntimeHost;
	readonly deployment?: RuntimeNativeMetadataDeploymentModuleV1;
}) {
	const origin =
		input.environment.AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_ORIGIN;
	const token =
		input.environment.AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_SERVICE_TOKEN;
	const moduleSpecifier =
		input.environment.AGENT_INFRA_RUNTIME_NATIVE_METADATA_DEPLOYMENT_MODULE;
	if (
		origin === undefined &&
		token === undefined &&
		moduleSpecifier === undefined
	)
		return undefined;
	// A partially configured target is deliberately unavailable.  Never infer a
	// Worker origin, token, proof key or session from request data.
	if (!origin || !token) return undefined;
	let deployment = input.deployment;
	if (moduleSpecifier !== undefined && !deployment) {
		try {
			if (!moduleSpecifier.startsWith("file:")) return undefined;
			deployment = (await import(
				moduleSpecifier
			)) as RuntimeNativeMetadataDeploymentModuleV1;
		} catch {
			return undefined;
		}
	}
	const current = createRuntimeNativeMetadataCurrentClientV1({
		baseUrl: origin,
		serviceToken: token,
	});
	if (deployment) {
		if (
			typeof deployment.createRuntimeNativeMetadataReadAssembly !== "function"
		)
			return undefined;
		return deployment.createRuntimeNativeMetadataReadAssembly({
			environment: input.environment,
			host: input.host,
			current,
		});
	}
	const publicKeyText = input.environment.AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY;
	const issuer = input.environment.AGENT_INFRA_RUNTIME_GRANT_ISSUER;
	const keyVersion = input.environment.AGENT_INFRA_RUNTIME_GRANT_KEY_ID;
	let workerId = input.environment.AGENT_INFRA_RUNTIME_WORKER_ID;
	if (!workerId && input.environment.AGENT_INFRA_RUNTIME_READINESS_BINDING) {
		try {
			const candidate = JSON.parse(
				input.environment.AGENT_INFRA_RUNTIME_READINESS_BINDING,
			) as { workerId?: unknown };
			if (typeof candidate.workerId === "string") workerId = candidate.workerId;
		} catch {
			workerId = undefined;
		}
	}
	if (!publicKeyText || !issuer || !keyVersion || !workerId) return undefined;
	try {
		const publicKey = createPublicKey(publicKeyText);
		const proof = createRuntimeNativeMetadataProofVerifierV1({
			publicKey,
			issuer,
			workerId,
			keyVersion,
		});
		return createRuntimeNativeMetadataCurrentAssemblyV1({
			current,
			verifyProof: proof.verify,
			resolveNativeSessionRef: async ({ request }) => {
				try {
					return await input.host.resolveNativeMetadataSessionRef(
						request.scope,
						request.originalHostScopeRef,
					);
				} catch {
					return null;
				}
			},
		});
	} catch {
		return undefined;
	}
}

function runtimePort(value: string | undefined, fallback: number) {
	const port = Number(value ?? fallback);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		runtimeConfigurationInvalid();
	}
	return port;
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string) {
	const value = environment[name];
	if (!value) runtimeConfigurationInvalid();
	return value;
}

/**
 * In-cluster plaintext HTTP (ADR-0020): the service token and signed Grant
 * authorize every call; NetworkPolicy admits only the Worker.
 */
const oauthServers = new WeakMap<
	ReturnType<typeof serve>,
	ReturnType<typeof createHttpsServer>
>();
const connectionInstallServers = new WeakMap<
	ReturnType<typeof serve>,
	ReturnType<typeof createHttpsServer>
>();

export function startRuntimeOAuthServer(
	assembly: Extract<RuntimeOAuthAssembly, { status: "available" }>,
	serviceToken: string,
) {
	assertStandardMcpProcessProtection();
	const server = createHttpsServer(
		{ key: assembly.key, cert: assembly.cert, minVersion: "TLSv1.2" },
		getRequestListener(createRuntimeOAuthApp(assembly, serviceToken).fetch),
	);
	server.headersTimeout = 15_000;
	server.requestTimeout = 15_000;
	server.on("error", () => {
		void assembly.client.close();
		server.close();
	});
	server.listen(assembly.port);
	return server;
}

export function startRuntimeHost(options: StartOptions) {
	const port = options.port ?? runtimePort(process.env.PORT, 3003);
	const log = options.log ?? console.info;
	const connectionConsumer = options.connectionConsumer
		? structuredClone(options.connectionConsumer)
		: undefined;
	let oauthServer: ReturnType<typeof createHttpsServer> | undefined;
	if (options.oauth?.status === "available" && options.oauth.port !== port) {
		try {
			oauthServer = startRuntimeOAuthServer(
				options.oauth,
				options.serviceToken,
			);
		} catch {
			void options.oauth.client.close().catch(() => undefined);
		}
	}
	if (options.oauth?.status === "available" && options.oauth.port === port)
		void options.oauth.client.close().catch(() => undefined);
	let connectionInstallServer: ReturnType<typeof createHttpsServer> | undefined;
	const connectionInstall = options.connectionInstall;
	const connectionInstallUnavailable = () =>
		console.warn(
			JSON.stringify({
				service: runtimeHostService,
				code: "CONNECTION_INSTALL_RECEIVER_UNAVAILABLE",
			}),
		);
	if (connectionInstall?.status === "available") {
		if (
			connectionInstall.port !== port &&
			!(
				options.oauth?.status === "available" &&
				options.oauth.port === connectionInstall.port
			)
		) {
			try {
				const started =
					startConnectionInstallReceiverServerV1(connectionInstall);
				started.once("error", connectionInstallUnavailable);
				started.once("listening", () =>
					log(
						JSON.stringify({
							service: runtimeHostService,
							code: "CONNECTION_INSTALL_RECEIVER_LISTENING",
							port: connectionInstall.port,
						}),
					),
				);
				connectionInstallServer = started;
			} catch {
				connectionInstallUnavailable();
				void connectionInstall.close().catch(() => undefined);
			}
		} else {
			connectionInstallUnavailable();
			void connectionInstall.close().catch(() => undefined);
		}
	}
	const server = serve(
		{
			fetch: createRuntimeHostApp({ ...options, connectionConsumer }).fetch,
			port,
		},
		(info) =>
			log(
				JSON.stringify({
					service: runtimeHostService,
					status: "ready",
					...(options.configVersion
						? { configVersion: options.configVersion }
						: {}),
					...(connectionConsumer
						? {
								connectionConsumerProfile:
									connectionConsumer.status === "available"
										? {
												schemaVersion: connectionConsumer.schemaVersion,
												configFingerprint: connectionConsumer.configFingerprint,
												source: connectionConsumer.source,
											}
										: connectionConsumer,
							}
						: {}),
					port: info.port,
				}),
			),
	);
	if (oauthServer) {
		oauthServers.set(server, oauthServer);
		server.once("close", () => {
			oauthServer.close();
		});
	}
	if (connectionInstallServer) {
		connectionInstallServers.set(server, connectionInstallServer);
		server.once("close", () => {
			connectionInstallServer.close();
		});
	}
	return server;
}

export async function assembleRuntimeHost(
	environment: NodeJS.ProcessEnv,
	filesystem?: RuntimeLegacyMigrationFilesystem,
	options: RuntimeHostAssemblyOptionsV1 = {},
) {
	const required = (name: string) => requiredEnvironment(environment, name);
	const binding = required("AGENT_INFRA_RUNTIME_DRIVER");
	if (
		binding !== "codex" &&
		binding !== "claude" &&
		binding !== "acp" &&
		binding !== "pi" &&
		binding !== "fake"
	)
		runtimeConfigurationInvalid();
	if (binding === "claude" || binding === "pi" || binding === "acp")
		assertRegisteredProvider(binding === "acp" ? "opencode" : binding);
	if (binding === "codex") assertRegisteredProvider("codex");
	assertRuntimeProcessProtection();
	const dataDirectory = required("AGENT_INFRA_RUNTIME_DATA_DIR");
	if (
		!isAbsolute(dataDirectory) ||
		resolve(dataDirectory) !== dataDirectory ||
		dataDirectory === "/"
	) {
		runtimeConfigurationInvalid();
	}
	const port = runtimePort(environment.PORT, 3003);
	const readinessBinding = readWorkloadReadinessBindingV1(environment);
	const runtimeWorkerId =
		readinessBinding?.workerId ??
		(binding === "codex"
			? required("AGENT_INFRA_RUNTIME_WORKER_ID")
			: environment.AGENT_INFRA_RUNTIME_WORKER_ID);
	if (
		readinessBinding &&
		environment.AGENT_INFRA_RUNTIME_WORKER_ID !== undefined &&
		environment.AGENT_INFRA_RUNTIME_WORKER_ID !== readinessBinding.workerId
	)
		runtimeConfigurationInvalid();
	if (runtimeWorkerId !== undefined && !runtimeWorkerId.trim())
		runtimeConfigurationInvalid();
	const keyId = required("AGENT_INFRA_RUNTIME_GRANT_KEY_ID");
	const serviceToken = required("AGENT_INFRA_RUNTIME_SERVICE_TOKEN");
	const fileExchangeOptions = readRuntimeFileExchangeOptions(environment);
	const expectedIssuer = required("AGENT_INFRA_RUNTIME_GRANT_ISSUER");
	let publicKey: KeyObject;
	try {
		publicKey = createPublicKey(
			required("AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY"),
		);
		if (publicKey.asymmetricKeyType !== "ed25519") {
			runtimeConfigurationInvalid();
		}
	} catch {
		runtimeConfigurationInvalid();
	}
	const configuration =
		binding === "codex" ? readCodexPilotConfiguration(environment) : undefined;
	const codexIsolationMode =
		binding === "codex"
			? readCodexIsolationMode(environment, serviceToken)
			: undefined;
	const coreUid = environment.AGENT_INFRA_CORE_POD_UID;
	const coreConversationKey = environment.AGENT_INFRA_CORE_CONVERSATION_KEY;
	if (coreUid !== undefined || coreConversationKey !== undefined) {
		if (
			!coreUid ||
			!coreConversationKey ||
			process.platform !== "linux" ||
			codexIsolationMode !== "landlock"
		)
			runtimeConfigurationInvalid();
	}
	const sessionExecutorBinding =
		codexIsolationMode === "session-executor"
			? readCodexSessionExecutorBindingV1(environment, serviceToken)
			: undefined;
	if (
		binding !== "codex" &&
		environment.AGENT_INFRA_RUNTIME_ISOLATION_MODE === "session-executor"
	)
		runtimeConfigurationInvalid();
	const sessionScope =
		binding === "codex"
			? undefined
			: readSessionScopeAttestationV1(environment, serviceToken);
	// Only Worker-issued, Host-verified Session scope can admit non-dumpable
	// protection (ADR-0051); an Agent-level or unattested Pod never does.
	establishCredentialHolderSessionScopeV1(
		sessionExecutorBinding
			? {
					kind: "session-executor",
					agentId: sessionExecutorBinding.agentId,
					conversationId: sessionExecutorBinding.conversationId,
					sessionGeneration: sessionExecutorBinding.sessionGeneration,
				}
			: codexIsolationMode === "container-boundary"
				? {
						kind: "container-boundary",
						agentId: required("AGENT_INFRA_RUNTIME_AGENT_ID"),
						scope: required("AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_SCOPE"),
					}
				: sessionScope !== undefined
					? {
							kind: "session-scope",
							agentId: required("AGENT_INFRA_RUNTIME_AGENT_ID"),
							scope: sessionScope,
						}
					: undefined,
	);
	const connectionProfile = readConnectionClientProfile(
		environment.AGENT_INFRA_RUNTIME_CONNECTION_PROFILE,
	);
	if (connectionProfile && binding !== "codex") runtimeConfigurationInvalid();
	let connectionConsumer = await readRuntimeConnectionConsumerProfile(
		environment.AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_FILE,
		environment.AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_REVISION,
	);
	if (connectionProfile && connectionConsumer !== undefined)
		runtimeConfigurationInvalid();
	const installationRevision =
		environment.AGENT_INFRA_RUNTIME_CONNECTION_INSTALLATION_REVISION;
	const supportsProtectedStandardMcp =
		binding === "codex" ||
		binding === "claude" ||
		(binding === "acp" &&
			environment.AGENT_INFRA_RUNTIME_ACP_MCP_BRIDGE === "verified-v1" &&
			supportsProtectedOpenCodeMcpTransport()) ||
		(binding === "pi" &&
			environment.AGENT_INFRA_RUNTIME_PI_MCP_BRIDGE === "verified-v1" &&
			supportsProtectedPiMcpTransport());
	if (
		installationRevision !== undefined &&
		(!supportsProtectedStandardMcp ||
			connectionConsumer?.status !== "available")
	)
		connectionConsumer = {
			status: "unavailable",
			schemaVersion: 1,
			reason: "invalid",
		};
	const messagesConfiguration =
		binding === "claude" || binding === "acp" || binding === "pi"
			? (() => {
					let schemaVersion: unknown;
					try {
						schemaVersion = JSON.parse(
							environment.AGENT_INFRA_RUNTIME_MODEL_CONFIG ?? "{}",
						)?.schemaVersion;
					} catch {
						runtimeConfigurationInvalid();
					}
					return schemaVersion === 4
						? readRuntimeModelConfigurationV4(environment, binding)
						: readRuntimeModelConfigurationV3(environment, binding);
				})()
			: undefined;
	const activeConfiguration = configuration ?? messagesConfiguration;
	let providerDeploymentBinding = options.providerDeploymentBinding;
	const wire = environment[providerEvidenceEnv];
	if (wire) {
		try {
			if (binding === "fake" || wire.length > 4096)
				runtimeConfigurationInvalid();
			const digest = environment[providerImageEnv];
			if (
				!digest ||
				(readinessBinding && readinessBinding.imageDigest !== digest)
			)
				runtimeConfigurationInvalid();
			providerDeploymentBinding = selectProviderDeploymentBinding(
				[JSON.parse(wire)],
				binding,
				digest,
				activeConfiguration?.configVersion ?? "",
			);
		} catch {
			runtimeConfigurationInvalid();
		}
	}
	const messagesRuntimeOptions = messagesConfiguration?.modelOptions.map(
		(option) => ({
			...option,
			endpoint: option.endpoint ?? runtimeConfigurationInvalid(),
			authentication: option.authentication ?? "bearer",
		}),
	);
	const agentId = activeConfiguration
		? required("AGENT_INFRA_RUNTIME_AGENT_ID")
		: undefined;
	const skillHubBinding = readRuntimeSkillHubBindingV1(environment);
	const skillDirectory = skillHubBinding
		? createAppliedRuntimeSkillDirectoryV1({
				root: runtimeSkillHubMountRootV1,
				agentId: skillHubBinding.agentId,
				agentVersion: skillHubBinding.agentVersion,
				configurationRevision: skillHubBinding.configurationRevision,
				generationId: skillHubBinding.generationId,
				projections: skillHubBinding.projections,
				appliedBindings: skillHubBinding.appliedBindings,
			})
		: undefined;
	const legacyMigration = await readRuntimeLegacyMigrationV1({
		environment,
		expectedIssuer,
		binding: readinessBinding,
		dataDirectory,
		filesystem,
	});
	const installedSkill = configuration
		? await readCodexInstalledSkillDeployment(
				environment,
				configuration.configVersion,
			)
		: undefined;
	if (configuration && !installedSkill) {
		await verifyCodexPilotInstallation();
	}
	let assembledHost: RuntimeHost | undefined;
	let closeDriver: (() => Promise<void>) | undefined;
	let openedStore: FileRuntimeStore | undefined;
	let safetyEvidence: RuntimeSafetyEvidenceAssemblyV1 | undefined;
	let modelTelemetry: ReturnType<typeof startObservability> | undefined;
	let oauth: RuntimeOAuthAssembly | undefined;
	let connectionInstall: ConnectionInstallReceiverAssemblyV1 | undefined;
	let browserCapabilityAssembly: RuntimeBrowserCapabilityAssemblyV1 | undefined;
	let sessionExecutor: CodexSessionExecutorAdmissionV1 | undefined;
	let detachSessionExecutorFailure: (() => void) | undefined;
	const verifiedBrowserCapability = () => {
		const result = discoverRuntimeBrowserCapabilityV1(
			{},
			browserCapabilityAssembly,
		);
		return "operations" in result && result.status === "available"
			? result
			: undefined;
	};
	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= (async () => {
			detachSessionExecutorFailure?.();
			try {
				await sessionExecutor?.close();
				// Cancel native transport before Host waits for active remote work.
				if (sessionExecutor) await closeDriver?.();
				if (oauth?.status === "available") await oauth.client.close();
				if (connectionInstall?.status === "available")
					await connectionInstall.close();
			} finally {
				try {
					await assembledHost?.close();
				} finally {
					try {
						await closeDriver?.();
					} finally {
						try {
							await openedStore?.close();
						} finally {
							await safetyEvidence?.log.close().catch(() => {});
							await modelTelemetry?.close().catch(() => {});
						}
					}
				}
			}
		})();
		return closing;
	};
	let executorInstanceRead: StartOptions["executorInstanceRead"];
	let consumedHostIdentity: ExecutorIdentityV1 | undefined;
	try {
		if (sessionExecutorBinding) {
			sessionExecutor = await openCodexSessionExecutorAdmissionV1(
				sessionExecutorBinding,
				required("AGENT_INFRA_RUNTIME_POD_UID"),
			);
			if (environment.AGENT_INFRA_EXECUTOR_STARTUP_REF !== undefined) {
				const identity = await consumeExecutorIdentityV1(
					"host",
					sessionExecutorBinding,
					environment,
				);
				consumedHostIdentity = identity;
				const pin = await pinCodexSessionExecutorEpochV1(
					dataDirectory,
					sessionExecutor,
					identity,
					activeConfiguration?.configVersion,
				);
				if (pin)
					executorInstanceRead = async (request) => {
						if (
							request.startupRef !== pin.startupRef ||
							request.attemptId !== pin.attemptId ||
							request.podUid !== pin.podUid
						)
							throw new Error("CODEX_SESSION_EXECUTOR_INVALID");
						return pin.read(request.challenge);
					};
				sessionExecutor = await openExecutorDrainHostV1(
					sessionExecutor,
					identity,
					dataDirectory,
				);
			} else
				await pinCodexSessionExecutorEpochV1(dataDirectory, sessionExecutor);
			detachSessionExecutorFailure = sessionExecutor.onFailure(() => {
				void Promise.resolve()
					.then(async () => {
						if (assembledHost) await close();
						else {
							await sessionExecutor?.close();
							await closeDriver?.();
						}
					})
					.catch(() => undefined);
			});
		}
		const storePath = join(dataDirectory, "host.json");
		if (legacyMigration) {
			const { bytes } = await readRuntimeLegacyJournal(storePath);
			await previewRuntimeLegacyMigration(bytes, legacyMigration);
		}
		const store = await FileRuntimeStore.open(storePath);
		openedStore = store;
		// A separate file with its own cursor and ACK; never the business journal (HLD §8.5.6).
		safetyEvidence = await openRuntimeSafetyEvidenceV1({
			environment,
			path: join(dataDirectory, "safety-evidence.json"),
			logDiagnostic: (entry) => console.warn(JSON.stringify(entry)),
		});
		await legacyMigration?.apply(store);
		oauth = await prepareRuntimeOAuth({
			environment,
			dataDirectory,
			target: connectionConsumer,
			store,
			agentId,
			serviceToken,
			workerId: runtimeWorkerId,
			key: publicKey,
			keyId,
			issuer: expectedIssuer,
		});
		// §13.5.6: any Worker-rendered receiver input asks this Host for the
		// install receiver; reported below when it cannot be opened.
		const connectionInstallRequested = Object.keys(environment).some(
			(key) =>
				key.startsWith("AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_") &&
				environment[key] !== undefined,
		);
		// Protected Standard MCP is assembled only for a pinned, explicitly gated
		// native transport. Connection credentials remain in this Host client.
		const standardConnectionClient =
			supportsProtectedStandardMcp &&
			agentId !== undefined &&
			connectionConsumer?.status === "available"
				? await createProtectedStandardMcpInput({
						dataDirectory,
						target: connectionConsumer,
						store,
						delivery: await receiveProtectedStandardMcpInstallation({
							dataDirectory,
							agentId,
							target: connectionConsumer,
							revision: installationRevision,
							requireOAuthPublication:
								environment.AGENT_INFRA_RUNTIME_CONNECTION_OAUTH_PUBLICATION !==
								undefined,
						}),
					})
				: undefined;
		const prepareConnectionInstall =
			options.prepareConnectionInstall ??
			((opened: FileRuntimeStore) =>
				prepareConnectionInstallReceiverV1({
					environment,
					dataDirectory,
					agentId,
					workerId: runtimeWorkerId,
					key: publicKey,
					keyId,
					issuer: expectedIssuer,
					serviceToken,
					store: opened,
				}));
		// §13.5.6: the receiver follows the Driver that can consume its reader.
		// Claude, ACP and Pi reach it only through their protected transport.
		connectionInstall = supportsProtectedStandardMcp
			? await prepareConnectionInstall(store)
			: undefined;
		// Missing or invalid input closes only this receiver; ordinary Sessions keep running.
		if (connectionInstallRequested && connectionInstall?.status !== "available")
			console.warn(
				JSON.stringify({
					service: runtimeHostService,
					code: "CONNECTION_INSTALL_RECEIVER_UNAVAILABLE",
				}),
			);
		const dynamicReader =
			connectionInstall?.status === "available"
				? connectionInstall.dynamicReader
				: undefined;
		const dynamicConnectionClient = dynamicReader
			? dynamicConnectionClientForReaderV1(dynamicReader)
			: undefined;
		await sessionExecutor?.assertCurrent();
		const driver = configuration
			? await CodexRuntimeDriver.open({
					observeModelTransportFailure: (event) => {
						modelTelemetry ??= startObservability({
							service: "agent-runtime-host",
							...(environment.AGENT_INFRA_OBSERVABILITY_OTLP_ENDPOINT
								? {
										otlpEndpoint:
											environment.AGENT_INFRA_OBSERVABILITY_OTLP_ENDPOINT,
									}
								: {}),
						});
						modelTelemetry.record({
							stage: "model",
							outcome: "unknown",
							code: "OPERATION_UNKNOWN",
							modelTransport: event,
							operationRef: event.operationRef,
							attemptRef: event.attemptRef,
							agentId: event.agentId,
							conversationId: event.conversationId,
							executionId: event.executionId,
						});
					},
					observeNativeCompactStage: (event) => {
						modelTelemetry ??= startObservability({
							service: "agent-runtime-host",
							...(environment.AGENT_INFRA_OBSERVABILITY_OTLP_ENDPOINT
								? {
										otlpEndpoint:
											environment.AGENT_INFRA_OBSERVABILITY_OTLP_ENDPOINT,
									}
								: {}),
						});
						modelTelemetry.record({
							stage: "runtime",
							outcome: event.outcome,
							protocolCode: `NATIVE_COMPACT_${event.stage.toUpperCase()}${
								event.code ? `_${event.code.toUpperCase()}` : ""
							}`,
							...(event.durationMs === undefined
								? {}
								: { durationMs: event.durationMs }),
							operationRef: event.operationRef,
							agentId: event.agentId,
							conversationId: event.conversationId,
							executionId: event.executionId,
						});
					},
					isolationMode: codexIsolationMode,
					...(coreConversationKey ? { coreConversationKey } : {}),
					...(sessionExecutor ? { sessionExecutor } : {}),
					browserCapability: verifiedBrowserCapability,
					...(skillDirectory ? { skillDirectory } : {}),
					...(standardConnectionClient ? { standardConnectionClient } : {}),
					...(dynamicConnectionClient ? { dynamicConnectionClient } : {}),
					...(connectionProfile && installationRevision === undefined
						? {
								connectionClient: createIndependentConnectionClientInput({
									dataDirectory,
									profile: connectionProfile,
									// The deployment profile is the only configured service
									// authority; native input cannot choose another service.
									authorizedService: {
										serviceRef: connectionProfile.serviceRef,
										issuer: connectionProfile.issuer,
										resource: connectionProfile.resource,
									},
									// The committed Store is ready before Host startup
									// recovery invokes native bootstrap.
									resolveOriginalBinding: (reference) =>
										store.resolveOriginalExecutionBinding(reference, Date.now),
								}),
							}
						: {}),
					authorizeExternalAction: async (action) => {
						if (!assembledHost)
							throw new RuntimeHostError(
								"RUNTIME_GRANT_INVALID",
								"Runtime authorization is not ready",
								403,
							);
						const authorized =
							await assembledHost.authorizeExternalAction(action);
						if (
							action.kind !== "tool" ||
							// The Driver binds this local reader to its durable tool fact.
							action.toolId === "workspace.read_text_file" ||
							connectionConsumer?.status !== "available"
						)
							return authorized;
						return {
							...authorized,
							revalidate: () => {
								assertStandardMcpProcessProtection();
								store.assertExternalActionCurrent(action, Date.now);
							},
						};
					},
					launchPath: "/opt/codex/bin:/usr/local/bin:/usr/bin:/bin",
					path: join(dataDirectory, "codex-driver.json"),
					configVersion: configuration.configVersion,
					...(installedSkill ? { installedSkill } : {}),
					defaultModelOptionId: configuration.defaultModelOptionId,
					defaultReasoningLevel: configuration.defaultReasoningLevel,
					modelOptions: configuration.modelOptions,
				})
			: messagesConfiguration
				? binding === "acp"
					? await openOpenCodeRuntime({
							...messagesConfiguration,
							browserCapability: verifiedBrowserCapability,
							...(standardConnectionClient ? { standardConnectionClient } : {}),
							...(dynamicConnectionClient ? { dynamicConnectionClient } : {}),
							...(skillDirectory ? { skillDirectory } : {}),
							modelOptions: messagesRuntimeOptions ?? [],
							...(messagesConfiguration.schemaVersion === 4
								? {
										authorizeModelAction: async (
											action: RuntimeExternalActionAuthorization,
										) => {
											if (!assembledHost)
												throw new Error("RUNTIME_AUTHORIZATION_UNAVAILABLE");
											return assembledHost.authorizeExternalAction(action);
										},
										authorizeToolAction: async (
											action: RuntimeExternalActionAuthorization,
										) => {
											if (!assembledHost)
												throw new Error("RUNTIME_AUTHORIZATION_UNAVAILABLE");
											return assembledHost.authorizeExternalAction(action);
										},
									}
								: {}),
							path: join(dataDirectory, "acp-driver"),
							executable:
								environment.AGENT_INFRA_OPENCODE_EXECUTABLE ??
								"/opt/opencode/bin/opencode",
						})
					: binding === "pi"
						? await openPiRuntime({
								...messagesConfiguration,
								browserCapability: verifiedBrowserCapability,
								...(standardConnectionClient
									? { standardConnectionClient }
									: {}),
								...(dynamicConnectionClient ? { dynamicConnectionClient } : {}),
								...(skillDirectory ? { skillDirectory } : {}),
								modelOptions: messagesRuntimeOptions ?? [],
								...(messagesConfiguration.schemaVersion === 4
									? {
											authorizeModelAction: async (
												action: RuntimeExternalActionAuthorization,
											) => {
												if (!assembledHost)
													throw new Error("RUNTIME_AUTHORIZATION_UNAVAILABLE");
												return assembledHost.authorizeExternalAction(action);
											},
											authorizeToolAction: async (
												action: RuntimeExternalActionAuthorization,
											) => {
												if (!assembledHost)
													throw new Error("RUNTIME_AUTHORIZATION_UNAVAILABLE");
												return assembledHost.authorizeExternalAction(action);
											},
										}
									: {}),
								path: join(dataDirectory, "pi-driver"),
							})
						: await ClaudeRuntimeDriver.open({
								...messagesConfiguration,
								browserCapability: verifiedBrowserCapability,
								...(skillDirectory ? { skillDirectory } : {}),
								...(standardConnectionClient
									? { standardConnectionClient }
									: {}),
								...(dynamicConnectionClient ? { dynamicConnectionClient } : {}),
								modelOptions: messagesRuntimeOptions ?? [],
								...(messagesConfiguration.schemaVersion === 4
									? {
											authorizeModelAction: async (
												action: RuntimeExternalActionAuthorization,
											) => {
												if (!assembledHost)
													throw new Error("RUNTIME_AUTHORIZATION_UNAVAILABLE");
												return assembledHost.authorizeExternalAction(action);
											},
										}
									: {}),
								path: join(dataDirectory, "claude-driver"),
							})
				: await FakeRuntimeDriver.open(join(dataDirectory, "fake-driver.json"));
		let closingDriver: Promise<void> | undefined;
		closeDriver = () => {
			closingDriver ??= (async () => {
				if ("close" in driver) await driver.close();
			})();
			return closingDriver;
		};
		await sessionExecutor?.assertCurrent();
		const rawValidateV4 =
			runtimeWorkerId && activeConfiguration?.schemaVersion === 4
				? createRuntimeExecutionGrantValidatorV4(
						new Map([[keyId, publicKey]]),
						{
							expectedIssuer,
							expectedWorkerId: runtimeWorkerId,
						},
					)
				: undefined;
		const validateV4 = rawValidateV4
			? async (request: unknown) => {
					const verified = await rawValidateV4(request);
					if (agentId && verified.claims.agentId !== agentId)
						throw new RuntimeHostError(
							"RUNTIME_GRANT_INVALID",
							"Runtime authorization does not match this deployment",
							403,
						);
					return verified;
				}
			: undefined;
		const createBrowserExecutionContext =
			options.createBrowserExecutionContext ??
			(async (
				input: Parameters<
					NonNullable<RuntimeHostOptions["createBrowserExecutionContext"]>
				>[0],
			) => {
				const capability = verifiedBrowserCapability();
				if (!capability || !input.principal) return undefined;
				return createSessionBrowserExecutionContextV1({
					sandboxRoot: join(
						dataDirectory,
						"browser",
						input.binding.conversationId,
					),
					capability,
					binding: {
						...input.binding,
						subjectId: input.principal.id,
						executionId: input.executionId,
						pageRevision: input.pageRevision,
						capabilityVersion: input.capabilityVersion,
					},
				});
			});

		const rawValidateRecoveryV4 =
			runtimeWorkerId && activeConfiguration?.schemaVersion === 4
				? createRuntimeExecutionKeyRecoveryValidatorV4(
						new Map([[keyId, publicKey]]),
						{
							expectedIssuer,
							expectedWorkerId: runtimeWorkerId,
						},
					)
				: undefined;
		const validateRecoveryV4 = rawValidateRecoveryV4
			? async (request: unknown) => {
					const verified = await rawValidateRecoveryV4(request);
					if (agentId && verified.claims.agentId !== agentId)
						throw new RuntimeHostError(
							"RUNTIME_GRANT_INVALID",
							"Runtime authorization does not match this deployment",
							403,
						);
					return verified;
				}
			: undefined;
		const rawValidateV5 =
			runtimeWorkerId && activeConfiguration?.schemaVersion === 4
				? createRuntimeExecutionGrantValidatorV5(
						new Map([[keyId, publicKey]]),
						{
							expectedIssuer,
							expectedWorkerId: runtimeWorkerId,
						},
					)
				: undefined;
		const validateV5 = rawValidateV5
			? async (request: unknown) => {
					const verified = await rawValidateV5(request);
					if (agentId && verified.claims.agentId !== agentId)
						throw new RuntimeHostError(
							"RUNTIME_GRANT_INVALID",
							"Runtime authorization does not match this deployment",
							403,
						);
					return verified;
				}
			: undefined;
		const rawValidateRecoveryV5 =
			runtimeWorkerId && activeConfiguration?.schemaVersion === 4
				? createRuntimeExecutionKeyRecoveryValidatorV5(
						new Map([[keyId, publicKey]]),
						{
							expectedIssuer,
							expectedWorkerId: runtimeWorkerId,
						},
					)
				: undefined;
		const validateRecoveryV5 = rawValidateRecoveryV5
			? async (request: unknown) => {
					const verified = await rawValidateRecoveryV5(request);
					if (agentId && verified.claims.agentId !== agentId)
						throw new RuntimeHostError(
							"RUNTIME_GRANT_INVALID",
							"Runtime authorization does not match this deployment",
							403,
						);
					return verified;
				}
			: undefined;
		const rawValidateV6 =
			runtimeWorkerId && activeConfiguration?.schemaVersion === 4
				? createRuntimeExecutionGrantValidatorV6(
						new Map([[keyId, publicKey]]),
						{ expectedIssuer, expectedWorkerId: runtimeWorkerId },
					)
				: undefined;
		const validateV6 = rawValidateV6
			? async (request: unknown) => {
					const verified = await rawValidateV6(request);
					if (
						(agentId && verified.claims.agentId !== agentId) ||
						verified.request.configVersion !==
							activeConfiguration?.configVersion
					)
						throw new RuntimeHostError(
							"RUNTIME_GRANT_INVALID",
							"Runtime authorization does not match this deployment",
							403,
						);
					return verified;
				}
			: undefined;
		const podUid = environment.AGENT_INFRA_RUNTIME_POD_UID;
		if (
			coreUid &&
			(!(driver instanceof CodexRuntimeDriver) || !driver.liveCoreProcessId)
		)
			runtimeConfigurationInvalid();
		const host = await RuntimeHost.open({
			...(providerDeploymentBinding ? { providerDeploymentBinding } : {}),
			...(binding !== "fake"
				? {
						runtimeDriverBinding: resolveProviderRegistration(
							binding === "acp" ? "opencode" : binding,
						).runtimeDriverBinding,
					}
				: {}),
			// #4358 I2: one observer per process, so its clock domain is this
			// Pod UID plus process start; it writes fixed stdout records only.
			controlObserver: createRuntimeControlObserverV1(podUid ? { podUid } : {}),
			createBrowserExecutionContext,
			probeBrowserCapability: async ({ declaration, binding, signal }) =>
				probeRuntimeBrowserCapabilityV1({
					dataDirectory,
					declaration,
					binding,
					signal,
				}),
			onBrowserCapabilityAssembly: (input) => {
				browserCapabilityAssembly = input;
			},
			...(readinessBinding
				? {
						readinessVerifier: createWorkloadReadinessVerifierV1({
							binding: readinessBinding,
							expectedIssuer,
							publicKeys: new Map([[keyId, publicKey]]),
						}),
					}
				: {}),
			store,
			driver,
			grantValidation: { expectedIssuer },
			...(fileExchangeOptions
				? {
						fileBridge: createRuntimeFileBridgeFactoryV1(fileExchangeOptions),
					}
				: {}),
			...(runtimeWorkerId
				? {
						grantValidationV2: {
							expectedIssuer,
							expectedWorkerId: runtimeWorkerId,
						},
					}
				: {}),
			...(validateV4 ? { validateGrantV4: validateV4 } : {}),
			...(validateRecoveryV4
				? { validateRecoveryGrantV4: validateRecoveryV4 }
				: {}),
			...(validateV5 ? { validateGrantV5: validateV5 } : {}),
			...(validateV6 ? { validateGrantV6: validateV6 } : {}),
			...(validateRecoveryV5
				? { validateRecoveryGrantV5: validateRecoveryV5 }
				: {}),
		});
		assembledHost = host;
		const nativeMetadataAssembly =
			options.nativeMetadataRead ??
			(await createRuntimeNativeMetadataDeploymentAssemblyV1({
				environment,
				host,
			}));
		const nativeMetadataRead = nativeMetadataAssembly
			? createRuntimeNativeMetadataReadV1(host, nativeMetadataAssembly)
			: undefined;
		// #4358 I3: default off. The proof reuses the deployment Grant trust
		// root under its own JWS type, purpose and audience.
		let originalAdmissionCheck: RuntimeOriginalAdmissionCheckV1 | undefined;
		if (
			environment.AGENT_INFRA_RUNTIME_ORIGINAL_ADMISSION_CHECK !== undefined
		) {
			const admissionPodUid = environment.AGENT_INFRA_RUNTIME_POD_UID;
			if (
				environment.AGENT_INFRA_RUNTIME_ORIGINAL_ADMISSION_CHECK !==
					"enabled" ||
				!admissionPodUid ||
				!runtimeWorkerId
			)
				runtimeConfigurationInvalid();
			originalAdmissionCheck = createRuntimeOriginalAdmissionCheckV1({
				host,
				publicKey,
				issuer: expectedIssuer,
				workerId: runtimeWorkerId,
				keyVersion: keyId,
				podUid: admissionPodUid,
			});
		}
		const verifyV2 = createRuntimeExecutionGrantVerifierV2(
			new Map([[keyId, publicKey]]),
		);
		const verify = createExecutionGrantVerifier(new Map([[keyId, publicKey]]));
		await sessionExecutor?.assertCurrent();
		let sessionInstanceRead: StartOptions["sessionInstanceRead"];
		if (options.sessionInstanceEvidence) {
			if (
				!consumedHostIdentity ||
				!sessionExecutor ||
				!sessionExecutorBinding ||
				!runtimeWorkerId ||
				!configuration
			)
				throw new RuntimeHostError(
					"RUNTIME_SESSION_INSTANCE_UNAVAILABLE",
					"Session instance evidence is unavailable",
					503,
					true,
				);
			const identity = consumedHostIdentity;
			const admission = sessionExecutor;
			sessionInstanceRead = createSessionInstanceReaderV1({
				identity,
				binding: sessionExecutorBinding,
				podUid: required("AGENT_INFRA_RUNTIME_POD_UID"),
				runnerEpoch: admission.epoch,
				...options.sessionInstanceEvidence,
				worker: {
					workerId: runtimeWorkerId,
					issuer: expectedIssuer,
					keyId,
					publicKey,
				},
				readPreparation: async (signal) => {
					await admission.assertCurrent();
					const result = (await executorControlRequestV1(
						identity,
						executorRunnerControlOriginV1,
						"/control/session-instance/read",
						{
							epoch: admission.epoch,
							generation: sessionExecutorBinding.sessionGeneration,
							resourceFence: sessionExecutorBinding.resourceFence,
						},
						signal,
					)) as Record<string, unknown>;
					await admission.assertCurrent();
					return {
						runnerEpoch: typeof result.epoch === "string" ? result.epoch : "",
						runnerIdentityConsumed: result.runnerIdentityConsumed === true,
						deliveryFilesRemoved: result.deliveryFilesRemoved === true,
						executorReady: result.executorReady === true,
						emptyBusinessState: result.emptyBusinessState === true,
					};
				},
				isBusinessStateEmpty: () =>
					store.isBusinessStateEmpty() &&
					(driver as CodexRuntimeDriver).isBusinessStateEmpty(),
			});
		}
		return {
			host,
			...(coreUid && driver instanceof CodexRuntimeDriver
				? {
						corePod: admittedCorePod(
							serviceToken,
							coreUid,
							() => driver.liveCoreProcessId,
						),
					}
				: {}),
			browserCapability: () => browserCapabilityAssembly,
			...(connectionConsumer ? { connectionConsumer } : {}),
			...(readinessBinding
				? { readinessWorkerId: readinessBinding.workerId }
				: {}),
			...(runtimeWorkerId
				? {
						runtimeWorkerId,
						verifyGrantV2: (grant: RuntimeExecutionGrantV2) => {
							const verified = verifyV2(grant);
							if (
								(agentId && verified.claims.agentId !== agentId) ||
								verified.claims.workerId !== runtimeWorkerId
							)
								throw new RuntimeHostError(
									"RUNTIME_GRANT_INVALID",
									"Runtime authorization does not match this deployment",
									403,
								);
							return verified;
						},
					}
				: {}),
			...(validateV4
				? { verifyGrantV4: (request: unknown) => validateV4(request) }
				: {}),
			...(validateRecoveryV4
				? {
						verifyRecoveryGrantV4: (request: unknown) =>
							validateRecoveryV4(request),
					}
				: {}),
			...(validateV5
				? { verifyGrantV5: (request: unknown) => validateV5(request) }
				: {}),
			...(validateV6 ? { verifyGrantV6: validateV6 } : {}),
			...(validateRecoveryV5
				? {
						verifyRecoveryGrantV5: (request: unknown) =>
							validateRecoveryV5(request),
					}
				: {}),
			...(activeConfiguration
				? { configVersion: activeConfiguration.configVersion }
				: {}),
			...(oauth ? { oauth } : {}),
			...(connectionInstall ? { connectionInstall } : {}),
			...(nativeMetadataRead ? { nativeMetadataRead } : {}),
			...(originalAdmissionCheck ? { originalAdmissionCheck } : {}),
			...(executorInstanceRead ? { executorInstanceRead } : {}),
			...(sessionInstanceRead ? { sessionInstanceRead } : {}),
			...(safetyEvidence ? { safetyEvidence: safetyEvidence.log } : {}),
			serviceToken,
			port,
			close,
			verifyGrant: (grant: ExecutionGrantV1) => {
				const verified = verify(grant);
				if (agentId && verified.claims.agentId !== agentId) {
					throw new RuntimeHostError(
						"RUNTIME_GRANT_INVALID",
						"Execution Grant is invalid or does not authorize this request",
						403,
					);
				}
				return verified;
			},
		};
	} catch (error) {
		await close().catch(() => undefined);
		throw error;
	}
}

export async function closeRuntimeHost(
	server: ReturnType<typeof serve>,
	closeRuntime: () => Promise<void>,
	timeoutMs = 30_000,
) {
	const timeout = setTimeout(() => {
		if ("closeAllConnections" in server) server.closeAllConnections();
	}, timeoutMs);
	try {
		const oauthServer = oauthServers.get(server);
		if (oauthServer) {
			await new Promise<void>((resolve) => {
				oauthServer.close(() => resolve());
				oauthServer.closeAllConnections();
			});
			oauthServers.delete(server);
		}
		const connectionInstallServer = connectionInstallServers.get(server);
		if (connectionInstallServer) {
			await new Promise<void>((resolve) => {
				connectionInstallServer.close(() => resolve());
				connectionInstallServer.closeAllConnections();
			});
			connectionInstallServers.delete(server);
		}
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	} finally {
		clearTimeout(timeout);
		await closeRuntime();
	}
}

async function startFromEnvironment() {
	// First, before any protected material or child process (ADR-0051).
	protectCredentialHolderProcessV1();
	assertRuntimeProcessProtection();
	const runtime = await assembleRuntimeHost(process.env);
	let server: ReturnType<typeof startRuntimeHost>;
	try {
		server = startRuntimeHost(runtime);
	} catch (error) {
		await runtime.close();
		throw error;
	}
	let stopping = false;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		void closeRuntimeHost(server, runtime.close).catch(() => {
			process.exitCode = 1;
		});
	};
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	server.once("error", () => {
		console.error(
			JSON.stringify({
				service: runtimeHostService,
				code: "RUNTIME_STARTUP_FAILED",
			}),
		);
		process.exitCode = 1;
		stop();
	});
}

/**
 * The Host's one startup failure line. Codes are chosen exactly as before; a
 * generic `RUNTIME_STARTUP_FAILED` only adds a fixed `reason` (#3054).
 */
export function runtimeHostStartupFailureLineV1(error: unknown) {
	const code =
		error instanceof RuntimeHostError
			? error.code
			: error instanceof Error &&
					[
						"RUNTIME_CONFIGURATION_INVALID",
						"RUNTIME_CODEX_PROVENANCE_MISMATCH",
						// #3255：文件交换配置无效时原样输出错误码，不再归为启动失败。
						"RUNTIME_FILE_EXCHANGE_CONFIGURATION_INVALID",
					].includes(error.message)
				? error.message
				: "RUNTIME_STARTUP_FAILED";
	return JSON.stringify({
		service: runtimeHostService,
		code,
		...(code === "RUNTIME_STARTUP_FAILED"
			? { reason: runtimeHostStartupFailureReasonV1(error) }
			: {}),
	});
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
	try {
		await startFromEnvironment();
	} catch (error) {
		console.error(runtimeHostStartupFailureLineV1(error));
		process.exitCode = 1;
	}
}

export type { SessionBrowserExecutionBindingV1 } from "./browser-session-provider.js";
export { createSessionBrowserExecutionContextV1 } from "./browser-session-provider.js";
