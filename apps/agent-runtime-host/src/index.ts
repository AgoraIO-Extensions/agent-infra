import { createPublicKey } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
} from "@agent-infra/agent-runtime";
import { serve } from "@hono/node-server";

import { createRuntimeHostApp, runtimeHostService } from "./app.js";

export { createRuntimeHostApp, runtimeHostService } from "./app.js";

interface StartOptions {
	host: RuntimeHost;
	serviceToken: string;
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
	const publicKey = createPublicKey(
		requiredEnvironment("AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY"),
	);
	const host = new RuntimeHost({
		store: await FileRuntimeStore.open(`${dataDirectory}/host.json`),
		driver: await FakeRuntimeDriver.open(`${dataDirectory}/fake-driver.json`),
		grantVerifier: {
			expectedIssuer: requiredEnvironment("AGENT_INFRA_RUNTIME_GRANT_ISSUER"),
			expectedAudience: "agent-runtime-host",
			publicKeys: new Map([
				[requiredEnvironment("AGENT_INFRA_RUNTIME_GRANT_KEY_ID"), publicKey],
			]),
		},
	});
	startRuntimeHost({
		host,
		serviceToken: requiredEnvironment("AGENT_INFRA_RUNTIME_SERVICE_TOKEN"),
	});
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
	await startFromEnvironment();
}
