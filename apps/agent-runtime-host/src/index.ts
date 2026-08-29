import { createPublicKey } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
	createExecutionGrantVerifier,
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
} from "@agent-infra/agent-runtime";
import type {
	ExecutionGrantV1,
	VerifiedExecutionGrantV1,
} from "@agent-infra/contracts/runtime";
import { serve } from "@hono/node-server";

import { createRuntimeHostApp, runtimeHostService } from "./app.js";

export { createRuntimeHostApp, runtimeHostService } from "./app.js";

interface StartOptions {
	host: RuntimeHost;
	serviceToken: string;
	verifyGrant: (
		grant: ExecutionGrantV1,
	) => VerifiedExecutionGrantV1 | Promise<VerifiedExecutionGrantV1>;
	log?: (message: string) => void;
	port?: number;
}

function runtimePort(value: string | undefined, fallback: number) {
	const port = Number(value ?? fallback);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`Invalid PORT: ${value}`);
	}
	return port;
}

function requiredEnvironment(name: string) {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required environment: ${name}`);
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
					port: info.port,
				}),
			),
	);
}

async function startFromEnvironment() {
	if (requiredEnvironment("AGENT_INFRA_RUNTIME_DRIVER") !== "fake") {
		throw new Error("Configured Runtime Driver is unavailable");
	}
	const dataDirectory = requiredEnvironment("AGENT_INFRA_RUNTIME_DATA_DIR");
	const keyId = requiredEnvironment("AGENT_INFRA_RUNTIME_GRANT_KEY_ID");
	const publicKey = createPublicKey(
		requiredEnvironment("AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY"),
	);
	const host = await RuntimeHost.open({
		store: await FileRuntimeStore.open(`${dataDirectory}/host.json`),
		driver: await FakeRuntimeDriver.open(`${dataDirectory}/fake-driver.json`),
		grantValidation: {
			expectedIssuer: requiredEnvironment("AGENT_INFRA_RUNTIME_GRANT_ISSUER"),
		},
	});
	startRuntimeHost({
		host,
		serviceToken: requiredEnvironment("AGENT_INFRA_RUNTIME_SERVICE_TOKEN"),
		verifyGrant: createExecutionGrantVerifier(new Map([[keyId, publicKey]])),
	});
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
	await startFromEnvironment();
}
