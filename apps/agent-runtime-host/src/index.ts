import { createPublicKey, type KeyObject } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RuntimeBrowserCapabilityAssemblyV1 } from "@agent-infra/agent-runtime";
import {
	ClaudeRuntimeDriver,
	CodexRuntimeDriver,
	createExecutionGrantVerifier,
	createRuntimeExecutionGrantValidatorV4,
	createRuntimeExecutionGrantVerifierV2,
	createWorkloadReadinessVerifierV1,
	FakeRuntimeDriver,
	FileRuntimeStore,
	openOpenCodeRuntime,
	openPiRuntime,
	RuntimeHost,
	RuntimeHostError,
	verifyCodexPilotInstallation,
} from "@agent-infra/agent-runtime";
import type {
	ExecutionGrantV1,
	RuntimeBusinessRequestV4,
	RuntimeExecutionGrantV2,
	VerifiedExecutionGrantV1,
	VerifiedRuntimeExecutionGrantV2,
} from "@agent-infra/contracts/runtime";
import { getRequestListener, serve } from "@hono/node-server";
import { createRuntimeHostApp, runtimeHostService } from "./app.js";
import {
	readCodexInstalledSkillDeployment,
	readCodexPilotConfiguration,
	readRuntimeModelConfigurationV3,
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
	type RuntimeLegacyMigrationFilesystem,
	readRuntimeLegacyMigrationV1,
} from "./legacy-migration.js";
import {
	previewRuntimeLegacyMigration,
	readRuntimeLegacyJournal,
} from "./legacy-migration-journal.js";
import { assertRuntimeProcessProtection } from "./process-protection.js";
import {
	createRuntimeOAuthApp,
	prepareRuntimeOAuth,
	type RuntimeOAuthAssembly,
} from "./runtime-oauth.js";
import { createProtectedStandardMcpInput } from "./standard-mcp-input.js";
import { receiveProtectedStandardMcpInstallation } from "./standard-mcp-installation.js";
import { assertStandardMcpProcessProtection } from "./standard-mcp-protection.js";

export { createRuntimeHostApp, runtimeHostService } from "./app.js";

interface StartOptions {
	browserCapability?:
		| RuntimeBrowserCapabilityAssemblyV1
		| (() => RuntimeBrowserCapabilityAssemblyV1 | undefined);
	oauth?: RuntimeOAuthAssembly;
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
	host: RuntimeHost;
	serviceToken: string;
	verifyGrant: (
		grant: ExecutionGrantV1,
	) => VerifiedExecutionGrantV1 | Promise<VerifiedExecutionGrantV1>;
	log?: (message: string) => void;
	port?: number;
	configVersion?: string;
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
	return server;
}

export async function assembleRuntimeHost(
	environment: NodeJS.ProcessEnv,
	filesystem?: RuntimeLegacyMigrationFilesystem,
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
	if (
		installationRevision !== undefined &&
		(!configuration || connectionConsumer?.status !== "available")
	)
		connectionConsumer = {
			status: "unavailable",
			schemaVersion: 1,
			reason: "invalid",
		};
	const messagesConfiguration =
		binding === "claude" || binding === "acp" || binding === "pi"
			? readRuntimeModelConfigurationV3(environment, binding)
			: undefined;
	const activeConfiguration = configuration ?? messagesConfiguration;
	const agentId = activeConfiguration
		? required("AGENT_INFRA_RUNTIME_AGENT_ID")
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
	let oauth: RuntimeOAuthAssembly | undefined;
	let browserCapabilityAssembly: RuntimeBrowserCapabilityAssemblyV1 | undefined;
	const close = async () => {
		if (oauth?.status === "available") await oauth.client.close();
		try {
			await assembledHost?.close();
		} finally {
			try {
				await closeDriver?.();
			} finally {
				await openedStore?.close();
			}
		}
	};
	try {
		const storePath = join(dataDirectory, "host.json");
		if (legacyMigration) {
			const { bytes } = await readRuntimeLegacyJournal(storePath);
			await previewRuntimeLegacyMigration(bytes, legacyMigration);
		}
		const store = await FileRuntimeStore.open(storePath);
		openedStore = store;
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
		const standardConnectionClient =
			configuration &&
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
						}),
					})
				: undefined;
		const driver = configuration
			? await CodexRuntimeDriver.open({
					...(standardConnectionClient ? { standardConnectionClient } : {}),
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
							path: join(dataDirectory, "acp-driver"),
							executable:
								environment.AGENT_INFRA_OPENCODE_EXECUTABLE ??
								"/opt/opencode/bin/opencode",
						})
					: binding === "pi"
						? await openPiRuntime({
								...messagesConfiguration,
								path: join(dataDirectory, "pi-driver"),
							})
						: await ClaudeRuntimeDriver.open({
								...messagesConfiguration,
								path: join(dataDirectory, "claude-driver"),
							})
				: await FakeRuntimeDriver.open(join(dataDirectory, "fake-driver.json"));
		closeDriver = async () => {
			if ("close" in driver) await driver.close();
		};
		const rawValidateV4 =
			runtimeWorkerId && configuration?.schemaVersion === 4
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
		const host = await RuntimeHost.open({
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
			...(runtimeWorkerId
				? {
						grantValidationV2: {
							expectedIssuer,
							expectedWorkerId: runtimeWorkerId,
						},
					}
				: {}),
			...(validateV4 ? { validateGrantV4: validateV4 } : {}),
		});
		assembledHost = host;
		const verifyV2 = createRuntimeExecutionGrantVerifierV2(
			new Map([[keyId, publicKey]]),
		);
		const verify = createExecutionGrantVerifier(new Map([[keyId, publicKey]]));
		return {
			host,
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
			...(activeConfiguration
				? { configVersion: activeConfiguration.configVersion }
				: {}),
			...(oauth ? { oauth } : {}),
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
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	} finally {
		clearTimeout(timeout);
		await closeRuntime();
	}
}

async function startFromEnvironment() {
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

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
	try {
		await startFromEnvironment();
	} catch (error) {
		const code =
			error instanceof RuntimeHostError
				? error.code
				: error instanceof Error &&
						[
							"RUNTIME_CONFIGURATION_INVALID",
							"RUNTIME_CODEX_PROVENANCE_MISMATCH",
						].includes(error.message)
					? error.message
					: "RUNTIME_STARTUP_FAILED";
		console.error(JSON.stringify({ service: runtimeHostService, code }));
		process.exitCode = 1;
	}
}
