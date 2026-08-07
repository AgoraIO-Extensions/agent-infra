import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";

import { createPlatformApp, platformApiService } from "./app";

interface StartOptions {
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

export function startPlatformApi(options: StartOptions = {}) {
	const port = options.port ?? runtimePort(process.env.PORT, 3000);
	const log = options.log ?? console.info;
	return serve(
		{
			fetch: createPlatformApp().fetch,
			port,
		},
		(info) =>
			log(
				JSON.stringify({
					service: platformApiService,
					status: "ready",
					port: info.port,
				}),
			),
	);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
	startPlatformApi();
}
