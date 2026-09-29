import { createPublicKey, type KeyObject } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	ClaudeRuntimeDriver,
	CodexRuntimeDriver,
	createExecutionGrantVerifier,
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
	RuntimeExecutionGrantV2,
	VerifiedExecutionGrantV1,
	VerifiedRuntimeExecutionGrantV2,
} from "@agent-infra/contracts/runtime";
import { serve } from "@hono/node-server";

import { createRuntimeHostApp, runtimeHostService } from "./app.js";
import {
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
	type RuntimeLegacyMigrationFilesystem,
	readRuntimeLegacyMigrationV1,
} from "./legacy-migration.js";
import {
	previewRuntimeLegacyMigration,
	readRuntimeLegacyJournal,
} from "./legacy-migration-journal.js";
import { assertRuntimeProcessProtection } from "./process-protection.js";

export { createRuntimeHostApp, runtimeHostService } from "./app.js";

interface StartOptions {
	readinessWorkerId?: string;
	runtimeWorkerId?: string;
	verifyGrantV2?: (
		grant: RuntimeExecutionGrantV2,
	) =>
		| VerifiedRuntimeExecutionGrantV2
		| Promise<VerifiedRuntimeExecutionGrantV2>;
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

export function startRuntimeHost(options: StartOptions) {
	const port = options.port ?? runtimePort(process.env.PORT, 3003);
	const log = options.log ?? console.info;
	return serve(
		{
			fetch: createRuntimeHostApp(options).fetch,
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
					port: info.port,
				}),
			),
	);
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
	if (configuration) {
		await verifyCodexPilotInstallation();
	}
	let assembledHost: RuntimeHost | undefined;
	let closeDriver: (() => Promise<void>) | undefined;
	let openedStore: FileRuntimeStore | undefined;
	const close = async () => {
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
		const driver = configuration
			? await CodexRuntimeDriver.open({
					...(connectionProfile
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
						await assembledHost.authorizeExternalAction(action);
					},
					launchPath: "/opt/codex/bin:/usr/local/bin:/usr/bin:/bin",
					path: join(dataDirectory, "codex-driver.json"),
					configVersion: configuration.configVersion,
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
		const host = await RuntimeHost.open({
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
		});
		assembledHost = host;
		const verifyV2 = createRuntimeExecutionGrantVerifierV2(
			new Map([[keyId, publicKey]]),
		);
		const verify = createExecutionGrantVerifier(new Map([[keyId, publicKey]]));
		return {
			host,
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
			...(activeConfiguration
				? { configVersion: activeConfiguration.configVersion }
				: {}),
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
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	} finally {
		clearTimeout(timeout);
		await closeRuntime();
	}
}

async function startFromEnvironment() {
	const runtime = await assembleRuntimeHost(process.env);
	const server = startRuntimeHost(runtime);
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
