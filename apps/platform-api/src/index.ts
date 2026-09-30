import { pathToFileURL } from "node:url";
import {
	type ObservabilityOptions,
	startObservability,
	startPlatformResourceSampler,
} from "@agent-infra/observability";
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
	browserAuth?: BrowserAuthHandler;
	observability?: ReturnType<typeof startObservability>;
	log?: (message: string) => void;
	port?: number;
}

interface BrowserAuthHandler {
	handleRequest(request: Request): Response | null | Promise<Response | null>;
	close?(): Promise<void>;
}

interface DeploymentStartOptions {
	log?: (message: string) => void;
	moduleSpecifier?: string;
	observabilityOptions?: Omit<ObservabilityOptions, "service">;
	port?: number;
}

interface PlatformApiDeploymentModule {
	createPlatformApiAssemblyInput():
		| PlatformApiAssemblyInput
		| Promise<PlatformApiAssemblyInput>;
	browserAuth?: BrowserAuthHandler;
}

interface LoadedPlatformApiAssembly extends PlatformApiAssembly {
	browserAuth?: BrowserAuthHandler;
}

const backgroundTaskWaiters = new WeakMap<object, () => Promise<void>>();

async function waitForPlatformApiBackgroundTasks(server: object) {
	await backgroundTaskWaiters.get(server)?.();
}

function runtimePort(value: string | undefined, fallback: number) {
	const port = Number(value ?? fallback);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`Invalid PORT: ${value}`);
	}
	return port;
}

function authUnavailable(): Response {
	return new Response(null, {
		status: 503,
		headers: { "Cache-Control": "no-store" },
	});
}

export function startPlatformApi(options: StartOptions) {
	const port = options.port ?? runtimePort(process.env.PORT, 3000);
	const log = options.log ?? console.info;
	const app = createPlatformApp(options.dependencies, options.observability);
	const browserAuth = options.browserAuth;
	const server = serve(
		{
			fetch: browserAuth
				? async (request) => {
						const path = new URL(request.url).pathname;
						if (path !== "/auth/login" && path !== "/auth/logout") {
							return app.fetch(request);
						}
						try {
							const response = await browserAuth.handleRequest(request);
							return response instanceof Response
								? response
								: authUnavailable();
						} catch {
							return authUnavailable();
						}
					}
				: app.fetch,
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
	const audit = options.dependencies.tasks?.audit;
	if (audit) {
		server.once("listening", () => {
			let recovery: Promise<void> | undefined;
			let stopped = false;
			const startRecovery = () => {
				if (stopped || recovery) return;
				const current = (async () => {
					try {
						await audit.recoverSubscriptions();
					} catch {
						log(
							JSON.stringify({
								service: platformApiService,
								status: "task_audit_recovery_failed",
							}),
						);
					}
				})();
				recovery = current;
				void current.then(
					() => {
						if (recovery === current) recovery = undefined;
					},
					() => {
						if (recovery === current) recovery = undefined;
					},
				);
			};
			const timer = setInterval(() => {
				startRecovery();
			}, 5000);
			timer.unref();
			const stopRecovery = () => {
				stopped = true;
				clearInterval(timer);
			};
			server.once("close", stopRecovery);
			server.once("error", stopRecovery);
			backgroundTaskWaiters.set(server, async () => {
				stopRecovery();
				await recovery;
			});
			startRecovery();
		});
	}
	return server;
}

export async function loadPlatformApiAssembly(
	moduleSpecifier = process.env.PLATFORM_API_DEPLOYMENT_MODULE,
): Promise<LoadedPlatformApiAssembly> {
	if (!moduleSpecifier) {
		throw new Error("PLATFORM_API_DEPLOYMENT_MODULE is required");
	}
	let deployment: PlatformApiDeploymentModule;
	try {
		const imported = (await import(
			moduleSpecifier
		)) as Partial<PlatformApiDeploymentModule>;
		if (
			typeof imported.createPlatformApiAssemblyInput !== "function" ||
			(imported.browserAuth !== undefined &&
				(typeof imported.browserAuth?.handleRequest !== "function" ||
					(imported.browserAuth.close !== undefined &&
						typeof imported.browserAuth.close !== "function")))
		) {
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
	const assembly = assemblePlatformApi(input);
	return {
		dependencies: assembly.dependencies,
		readQueue: assembly.readQueue,
		browserAuth: deployment.browserAuth,
		async close() {
			try {
				await assembly.close();
			} finally {
				await deployment.browserAuth?.close?.();
			}
		},
	};
}

export async function startPlatformApiFromDeployment(
	options: DeploymentStartOptions = {},
) {
	const assembly = await loadPlatformApiAssembly(options.moduleSpecifier);
	let server: ReturnType<typeof startPlatformApi> | undefined;
	let observability: ReturnType<typeof startObservability> | undefined;
	let sampler: ReturnType<typeof startPlatformResourceSampler> | undefined;
	try {
		observability = startObservability({
			service: platformApiService,
			...(process.env.AGENT_INFRA_OBSERVABILITY_OTLP_ENDPOINT
				? {
						otlpEndpoint: process.env.AGENT_INFRA_OBSERVABILITY_OTLP_ENDPOINT,
					}
				: {}),
			...options.observabilityOptions,
		});
		sampler = startPlatformResourceSampler({
			telemetry: observability,
			readQueue: assembly.readQueue,
			...(options.observabilityOptions?.metricIntervalMs === undefined
				? {}
				: { intervalMs: options.observabilityOptions.metricIntervalMs }),
		});
		server = startPlatformApi({
			dependencies: assembly.dependencies,
			browserAuth: assembly.browserAuth,
			observability,
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
		return { assembly, server, observability, sampler };
	} catch (error) {
		sampler?.stop();
		if (server?.listening) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
		}
		try {
			if (server) await waitForPlatformApiBackgroundTasks(server);
		} catch {
			// Continue closing the deployment after a background recovery failure.
		}
		try {
			await assembly.close();
		} finally {
			await observability?.close();
		}
		throw error;
	}
}

export function createPlatformApiShutdown(
	running: Pick<
		Awaited<ReturnType<typeof startPlatformApiFromDeployment>>,
		"assembly" | "server"
	> & {
		readonly observability?: ReturnType<typeof startObservability>;
		readonly sampler?: ReturnType<typeof startPlatformResourceSampler>;
	},
) {
	let shutdown: Promise<void> | undefined;
	return () => {
		shutdown ??= (async () => {
			running.sampler?.stop();
			const failures: unknown[] = [];
			try {
				await new Promise<void>((resolve, reject) =>
					running.server.close((error) => (error ? reject(error) : resolve())),
				);
			} catch (error) {
				failures.push(error);
			}
			try {
				await waitForPlatformApiBackgroundTasks(running.server);
			} catch (error) {
				failures.push(error);
			}
			try {
				await running.assembly.close();
			} catch (error) {
				failures.push(error);
			} finally {
				try {
					await running.observability?.close();
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1)
				throw new AggregateError(failures, "Platform API shutdown failed");
		})();
		return shutdown;
	};
}

export {
	createProductionPlatformApiAssemblyInputV1,
	type ProductionPlatformApiInputV1,
} from "./deployment.js";
export {
	createLdapBrowserAdapter,
	type LdapBrowserInput,
	type LdapSessionStore,
} from "./ldap-browser.js";
export { createPostgresLdapBrowserDeployment } from "./ldap-browser-deployment.js";
export {
	createPendingSecretRecordAttachmentResolverV1,
	type PreparedSecretPlaintextV1,
} from "./secret-preparation.js";
export {
	createProductionSingleAgentTemplateReleaseAppV1,
	type ProductionSingleAgentTemplateReleaseInputV1,
	type StandardTemplateReleaseDeploymentBindingV1,
} from "./template-release.js";
export {
	assemblePlatformApi,
	type PlatformApiAssembly,
	type PlatformApiAssemblyInput,
};

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
	void startPlatformApiFromDeployment()
		.then((running) => {
			const shutdown = createPlatformApiShutdown(running);
			const handleShutdown = () => {
				void shutdown().catch(() => {
					console.error("Platform API failed to stop");
					process.exitCode = 1;
				});
			};
			process.once("SIGTERM", handleShutdown);
			process.once("SIGINT", handleShutdown);
		})
		.catch(() => {
			console.error("Platform API failed to start");
			process.exitCode = 1;
		});
}
