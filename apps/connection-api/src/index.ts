import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";

import {
	connectionApiService,
	createConnectionRuntime,
} from "./production-app";

interface StartOptions {
	app: { fetch(request: Request): Response | Promise<Response> };
	hostname?: string;
	log?: (message: string) => void;
	port?: number;
	approvalMaintenance?: {
		expireDueAuthorizations(limit?: number): Promise<number>;
		expireDueRequests(limit?: number): Promise<number>;
	};
	approvalMaintenanceIntervalMs?: number;
	notificationDispatcher?: { runOnce(): Promise<boolean> };
	notificationDispatchIntervalMs?: number;
	recovery?: { runOnce(): Promise<boolean> };
	recoveryIntervalMs?: number;
}

function runtimePort(value: string | undefined, fallback: number) {
	const port = Number(value ?? fallback);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`Invalid PORT: ${value}`);
	}
	return port;
}

export function startConnectionApi(options: StartOptions) {
	const port = options.port ?? runtimePort(process.env.PORT, 3002);
	const log = options.log ?? console.info;
	const server = serve(
		{
			fetch: options.app.fetch,
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
	if (options.recovery) {
		let recoveryRunning = false;
		const timer = setInterval(() => {
			if (recoveryRunning) return;
			recoveryRunning = true;
			void options.recovery
				?.runOnce()
				.catch((error: unknown) =>
					log(
						JSON.stringify({
							error: error instanceof Error ? error.message : "Recovery failed",
							service: connectionApiService,
							status: "recovery_failed",
						}),
					),
				)
				.finally(() => {
					recoveryRunning = false;
				});
		}, options.recoveryIntervalMs ?? 1_000);
		timer.unref();
		server.once("close", () => clearInterval(timer));
	}
	if (options.approvalMaintenance) {
		let running = false;
		const timer = setInterval(() => {
			if (running) return;
			running = true;
			void (async () => {
				await options.approvalMaintenance?.expireDueAuthorizations();
				await options.approvalMaintenance?.expireDueRequests();
			})()
				.catch((error: unknown) =>
					log(
						JSON.stringify({
							error:
								error instanceof Error
									? error.message
									: "Approval maintenance failed",
							service: connectionApiService,
							status: "approval_maintenance_failed",
						}),
					),
				)
				.finally(() => {
					running = false;
				});
		}, options.approvalMaintenanceIntervalMs ?? 30_000);
		timer.unref();
		server.once("close", () => clearInterval(timer));
	}
	if (options.notificationDispatcher) {
		let running = false;
		const timer = setInterval(() => {
			if (running) return;
			running = true;
			void options.notificationDispatcher
				?.runOnce()
				.catch((error: unknown) =>
					log(
						JSON.stringify({
							error:
								error instanceof Error
									? error.message
									: "Notification dispatch failed",
							service: connectionApiService,
							status: "notification_dispatch_failed",
						}),
					),
				)
				.finally(() => {
					running = false;
				});
		}, options.notificationDispatchIntervalMs ?? 5_000);
		timer.unref();
		server.once("close", () => clearInterval(timer));
	}
	return server;
}

async function startConfiguredConnectionApi() {
	const runtime = await createConnectionRuntime();
	return startConnectionApi(runtime);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
	await startConfiguredConnectionApi();
}
