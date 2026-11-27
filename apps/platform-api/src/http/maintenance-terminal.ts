import { readFileSync } from "node:fs";
import { upgradeWebSocket } from "@hono/node-server";
import type { Hono } from "hono";
import WebSocket from "ws";
import { attachMaintenanceTerminal } from "../maintenance-terminal-connection.js";
import { HttpProtocolError, requestMetadata } from "./common.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface MaintenanceTerminalTransport {
	publicOrigin: string;
	connect(directoryId: string): WebSocket;
}
export function maintenanceTransportFromEnvironment():
	| MaintenanceTerminalTransport
	| undefined {
	const base = process.env.PLATFORM_MAINTENANCE_WORKER_ORIGIN;
	if (!base) return undefined;
	const worker = new URL(base);
	const publicOrigin = new URL(
		process.env.PLATFORM_MAINTENANCE_PUBLIC_ORIGIN ?? "",
	);
	if (
		!["ws:", "wss:"].includes(worker.protocol) ||
		worker.origin !== base ||
		!["http:", "https:"].includes(publicOrigin.protocol) ||
		publicOrigin.origin !== process.env.PLATFORM_MAINTENANCE_PUBLIC_ORIGIN
	)
		throw new Error("Invalid maintenance origin");
	const serviceToken = readFileSync(
		process.env.PLATFORM_MAINTENANCE_TOKEN_FILE ?? "",
		"utf8",
	).trim();
	if (!/^[\x21-\x7e]{32,512}$/.test(serviceToken))
		throw new Error("Invalid maintenance credential");
	return {
		publicOrigin: publicOrigin.origin,
		connect: (directoryId) =>
			new WebSocket(
				new URL(
					"/internal/worker/v1/maintenance-terminal/" +
						encodeURIComponent(directoryId),
					worker,
				),
				{
					headers: { authorization: `Bearer ${serviceToken}` },
					followRedirects: false,
					perMessageDeflate: false,
					handshakeTimeout: 10_000,
					maxPayload: 65_536,
				},
			),
	};
}

export function registerMaintenanceTerminal(
	app: Hono,
	deps: {
		identity: IdentityAdapter;
		readDirectory(input: {
			agentId: string;
			actorId: string;
		}): Promise<string | null>;
		transport: MaintenanceTerminalTransport;
		activateDirectory?: (scope: {
			agentId: string;
			actorId: string;
		}) => Promise<string | null>;
	},
) {
	app.get(
		"/api/v2/agents/:agentId/maintenance-terminal/socket",
		async (c, next) => {
			const request = c.req.raw;
			const { traceId } = requestMetadata(request);
			c.header("Cache-Control", "no-store");
			if (request.headers.has("Authorization"))
				throw new HttpProtocolError("AUTHENTICATION_REQUIRED", traceId);
			if (request.headers.get("Origin") !== deps.transport.publicOrigin)
				throw new HttpProtocolError("FORBIDDEN", traceId);
			if (
				new URL(request.url).search ||
				request.headers.get("upgrade")?.toLowerCase() !== "websocket"
			)
				throw new HttpProtocolError("INVALID_REQUEST", traceId);
			const agentId = c.req.param("agentId");
			const actor = (await resolveIdentity(deps.identity, request, traceId))
				.userId;
			const directory = await (deps.activateDirectory ?? deps.readDirectory)({
				agentId,
				actorId: actor,
			});
			if (!directory) throw new HttpProtocolError("FORBIDDEN", traceId);
			let connection: ReturnType<typeof attachMaintenanceTerminal> | undefined;
			return upgradeWebSocket(() => ({
				onOpen(_event, ws) {
					try {
						connection = attachMaintenanceTerminal({
							connect: () => deps.transport.connect(directory),
							authorized: async () =>
								(await resolveIdentity(deps.identity, request, traceId))
									.userId === actor &&
								(await deps.readDirectory({ agentId, actorId: actor })) ===
									directory,
							output: (bytes, binary) => {
								if ((ws.raw as WebSocket).bufferedAmount > 262144)
									throw new Error("Slow terminal client");
								ws.send(binary ? Uint8Array.from(bytes) : bytes.toString());
							},
							close: (code) => ws.close(code),
						});
					} catch {
						ws.close(1011);
					}
				},
				onMessage(event, ws) {
					if (
						typeof event.data !== "string" &&
						!(event.data instanceof ArrayBuffer)
					) {
						ws.close(1008);
						return;
					}
					connection?.send(event.data);
				},
				onClose() {
					connection?.close();
				},
				onError() {
					connection?.close();
				},
			}))(c, next);
		},
	);
}
