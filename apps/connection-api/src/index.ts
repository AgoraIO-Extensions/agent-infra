import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";

import {
	connectionApiService,
	createProductionConnectionApp,
} from "./production-app";

interface StartOptions {
	app?: { fetch(request: Request): Response | Promise<Response> };
	hostname?: string;
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

export function startConnectionApi(options: StartOptions = {}) {
	const port = options.port ?? runtimePort(process.env.PORT, 3002);
	const log = options.log ?? console.info;
	const app = options.app ?? createProductionConnectionApp();
	return serve(
		{
			fetch: app.fetch,
			hostname: options.hostname,
			port,
		},
		(info) =>
			log(
				JSON.stringify({
					service: connectionApiService,
					status: "ready",
					port: info.port,
				}),
			),
	);
}

async function startConfiguredConnectionApi() {
	return startConnectionApi();
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
	await startConfiguredConnectionApi();
}
