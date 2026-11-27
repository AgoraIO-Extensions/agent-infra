import { OpaqueIdV1Schema } from "@agent-infra/contracts";
import type { Hono } from "hono";
import type { maintenanceSshEndpoint } from "../maintenance-terminal-ssh.js";
import { HttpProtocolError, requestMetadata } from "./common.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";
import {
	type MaintenanceTerminalTransport,
	registerMaintenanceTerminal,
} from "./maintenance-terminal.js";

export interface MaintenanceTerminalAccessDependencies {
	readonly identity: IdentityAdapter;
	readonly ssh?: ReturnType<typeof maintenanceSshEndpoint>;
	readonly transport?: MaintenanceTerminalTransport;
	readonly activateDirectory?: (input: {
		agentId: string;
		actorId: string;
	}) => Promise<string | null>;
	readonly readDirectory?: (input: {
		agentId: string;
		actorId: string;
	}) => Promise<string | null>;
	readonly readAccess: (input: {
		agentId: string;
		actorId: string;
	}) => Promise<boolean>;
}

export function registerMaintenanceTerminalAccess(
	app: Hono,
	dependencies: MaintenanceTerminalAccessDependencies,
) {
	if (dependencies.transport && dependencies.readDirectory)
		registerMaintenanceTerminal(app, {
			identity: dependencies.identity,
			transport: dependencies.transport,
			readDirectory: dependencies.readDirectory,
			activateDirectory: dependencies.activateDirectory,
		});
	if (dependencies.ssh && dependencies.transport) {
		const ssh = dependencies.ssh;
		const origin = dependencies.transport.publicOrigin;
		app.post("/api/v2/agents/:agentId/maintenance-terminal/ssh", async (c) => {
			c.header("Cache-Control", "no-store");
			const request = c.req.raw;
			const { traceId } = requestMetadata(request);
			if (request.headers.has("Authorization"))
				throw new HttpProtocolError("AUTHENTICATION_REQUIRED", traceId);
			if (request.headers.get("Origin") !== origin)
				throw new HttpProtocolError("FORBIDDEN", traceId);
			if (
				new URL(request.url).search ||
				(request.body && !(await request.body.getReader().read()).done)
			)
				throw new HttpProtocolError("INVALID_REQUEST", traceId);
			const actor = await resolveIdentity(
				dependencies.identity,
				request,
				traceId,
			);
			const scope = { agentId: c.req.param("agentId"), actorId: actor.userId };
			if (!(await dependencies.readDirectory?.(scope)))
				throw new HttpProtocolError("FORBIDDEN", traceId);
			return c.json(await ssh.issue(scope), 201);
		});
	}
	app.get("/api/v2/agents/:agentId/maintenance-terminal/access", async (c) => {
		const request = c.req.raw;
		const { traceId } = requestMetadata(request);
		c.header("Cache-Control", "no-store");
		if (request.headers.has("Authorization"))
			throw new HttpProtocolError("AUTHENTICATION_REQUIRED", traceId);
		const agentId = OpaqueIdV1Schema.safeParse(c.req.param("agentId"));
		if (!agentId.success || new URL(request.url).search)
			throw new HttpProtocolError("INVALID_REQUEST", traceId);
		const actor = await resolveIdentity(
			dependencies.identity,
			request,
			traceId,
		);
		let allowed: boolean;
		try {
			allowed = await dependencies.readAccess({
				agentId: agentId.data,
				actorId: actor.userId,
			});
		} catch {
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
		}
		if (allowed !== true) throw new HttpProtocolError("FORBIDDEN", traceId);
		if (
			dependencies.transport &&
			(await dependencies.readDirectory?.({
				agentId: agentId.data,
				actorId: actor.userId,
			}))
		)
			c.header(
				"X-Maintenance-Terminal",
				dependencies.ssh ? "websocket,ssh" : "websocket",
			);
		return c.body(null, 204);
	});
}
