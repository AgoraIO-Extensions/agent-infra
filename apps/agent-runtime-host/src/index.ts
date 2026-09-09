import { createPublicKey, type KeyObject } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	CodexRuntimeDriver,
	createExecutionGrantVerifier,
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
	RuntimeHostError,
	verifyCodexPilotInstallation,
} from "@agent-infra/agent-runtime";
import type {
	ExecutionGrantV1,
	VerifiedExecutionGrantV1,
} from "@agent-infra/contracts/runtime";
import { serve } from "@hono/node-server";

import { createRuntimeHostApp, runtimeHostService } from "./app.js";
import {
	readCodexPilotConfiguration,
	runtimeConfigurationInvalid,
} from "./configuration.js";

export { createRuntimeHostApp, runtimeHostService } from "./app.js";

interface StartOptions {
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

export async function assembleRuntimeHost(environment: NodeJS.ProcessEnv) {
	const required = (name: string) => requiredEnvironment(environment, name);
	const binding = required("AGENT_INFRA_RUNTIME_DRIVER");
	if (binding !== "codex" && binding !== "fake") runtimeConfigurationInvalid();
	const dataDirectory = required("AGENT_INFRA_RUNTIME_DATA_DIR");
	if (
		!isAbsolute(dataDirectory) ||
		resolve(dataDirectory) !== dataDirectory ||
		dataDirectory === "/"
	) {
		runtimeConfigurationInvalid();
	}
	const port = runtimePort(environment.PORT, 3003);
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
	const agentId = configuration
		? required("AGENT_INFRA_RUNTIME_AGENT_ID")
		: undefined;
	if (configuration) {
		await verifyCodexPilotInstallation();
		// The fixed image executable was verified above; personal PATH cannot select it.
		process.env.PATH = "/opt/codex/bin:/usr/local/bin:/usr/bin:/bin";
	}
	const driver = configuration
		? await CodexRuntimeDriver.open({
				path: join(dataDirectory, "codex-driver.json"),
				configVersion: configuration.configVersion,
				defaultModelOptionId: configuration.defaultModelOptionId,
				defaultReasoningLevel: configuration.defaultReasoningLevel,
				modelOptions: configuration.modelOptions,
			})
		: await FakeRuntimeDriver.open(join(dataDirectory, "fake-driver.json"));
	const close = async () => {
		if (driver instanceof CodexRuntimeDriver) await driver.close();
	};
	try {
		const host = await RuntimeHost.open({
			store: await FileRuntimeStore.open(join(dataDirectory, "host.json")),
			driver,
			grantValidation: { expectedIssuer },
		});
		const verify = createExecutionGrantVerifier(new Map([[keyId, publicKey]]));
		return {
			host,
			...(configuration ? { configVersion: configuration.configVersion } : {}),
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
		await close();
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
