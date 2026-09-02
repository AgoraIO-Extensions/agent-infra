import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";

import {
	createPlatformApp,
	type PlatformAppDependencies,
	platformApiService,
} from "./app";
import {
	assemblePlatformApi,
	type PlatformApiAssembly,
	type PlatformApiAssemblyInput,
} from "./assembly.js";

interface StartOptions {
	dependencies: PlatformAppDependencies;
	log?: (message: string) => void;
	port?: number;
}

interface DeploymentStartOptions {
	log?: (message: string) => void;
	moduleSpecifier?: string;
	port?: number;
}

interface PlatformApiDeploymentModule {
	createPlatformApiAssemblyInput():
		| PlatformApiAssemblyInput
		| Promise<PlatformApiAssemblyInput>;
}

function runtimePort(value: string | undefined, fallback: number) {
	const port = Number(value ?? fallback);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`Invalid PORT: ${value}`);
	}
	return port;
}

export function startPlatformApi(options: StartOptions) {
	const port = options.port ?? runtimePort(process.env.PORT, 3000);
	const log = options.log ?? console.info;
	return serve(
		{
			fetch: createPlatformApp(options.dependencies).fetch,
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

export async function loadPlatformApiAssembly(
	moduleSpecifier = process.env.PLATFORM_API_DEPLOYMENT_MODULE,
): Promise<PlatformApiAssembly> {
	if (!moduleSpecifier) {
		throw new Error("PLATFORM_API_DEPLOYMENT_MODULE is required");
	}
	let deployment: PlatformApiDeploymentModule;
	try {
		const imported = (await import(
			moduleSpecifier
		)) as Partial<PlatformApiDeploymentModule>;
		if (typeof imported.createPlatformApiAssemblyInput !== "function") {
			throw new Error();
		}
		deployment = imported as PlatformApiDeploymentModule;
	} catch {
		throw new Error("Platform API deployment module is invalid");
	}
	let input: PlatformApiAssemblyInput;
	try {
		input = await deployment.createPlatformApiAssemblyInput();
	} catch {
		throw new Error("Platform API deployment dependencies are unavailable");
	}
	return assemblePlatformApi(input);
}

export async function startPlatformApiFromDeployment(
	options: DeploymentStartOptions = {},
) {
	const assembly = await loadPlatformApiAssembly(options.moduleSpecifier);
	let server: ReturnType<typeof startPlatformApi> | undefined;
	try {
		server = startPlatformApi({
			dependencies: assembly.dependencies,
			log: options.log,
			port: options.port,
		});
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				server?.off("listening", onListening);
				server?.off("error", onError);
			};
			const onListening = () => {
				cleanup();
				resolve();
			};
			const onError = (error: Error) => {
				cleanup();
				reject(error);
			};
			server?.once("listening", onListening);
			server?.once("error", onError);
			if (server?.listening) onListening();
		});
		return { assembly, server };
	} catch (error) {
		if (server?.listening) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
		}
		await assembly.close();
		throw error;
	}
}

export {
	assemblePlatformApi,
	type PlatformApiAssembly,
	type PlatformApiAssemblyInput,
};

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
	void startPlatformApiFromDeployment().catch(() => {
		console.error("Platform API failed to start");
		process.exitCode = 1;
	});
}
