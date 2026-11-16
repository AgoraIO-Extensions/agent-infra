import {
	AgentConnectionAssociationDisconnectRequestV1Schema,
	AgentConnectionAssociationRequestV1Schema,
	AgentConnectionAssociationStateV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	type AgentConnectionAssociationEntryV1,
	AgentConnectionAssociationErrorV1,
	type AgentConnectionAssociationUseCaseV1,
} from "@agent-infra/platform-core";
import type { Context, Hono } from "hono";
import { requireApiCredentialMaterial } from "./agent-api-management-support.js";
import { HttpProtocolError, parseJson, requestMetadata } from "./common.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface AgentConnectionAssociationRoutesDependencies {
	readonly identity: IdentityAdapter;
	readonly associations: AgentConnectionAssociationUseCaseV1;
}

const codes = {
	invalid_input: "INVALID_REQUEST",
	// A non-Owner sees the Agent as absent, like the other Owner-only routes.
	not_authorized: "RESOURCE_UNAVAILABLE",
	conflict: "CONFLICT",
	already_associated: "CONNECTION_ALREADY_ASSOCIATED",
	credential_rejected: "CONNECTION_CREDENTIAL_REJECTED",
	consumer_unavailable: "CONNECTION_CONSUMER_UNAVAILABLE",
	verification_unavailable: "CONNECTION_VERIFICATION_UNAVAILABLE",
	automatic_unavailable: "CONNECTION_AUTOMATIC_REGISTRATION_UNAVAILABLE",
	unavailable: "DEPENDENCY_UNAVAILABLE",
} as const satisfies Record<AgentConnectionAssociationErrorV1["code"], string>;

/**
 * Spec §13.5.7 Owner manual association. The browser session and an Owner's own
 * API credential reach the same Core command; identity is resolved server-side.
 */
export function registerAgentConnectionAssociationRoutes(
	app: Hono,
	dependencies: AgentConnectionAssociationRoutesDependencies,
) {
	async function entry(
		request: Request,
		traceId: string,
	): Promise<AgentConnectionAssociationEntryV1> {
		if (request.headers.has("Authorization"))
			return {
				kind: "api",
				material: requireApiCredentialMaterial(request, traceId),
			};
		const identity = await resolveIdentity(
			dependencies.identity,
			request,
			traceId,
		);
		return { kind: "browser", userId: identity.userId };
	}
	async function handle(
		context: Context,
		operation: "read" | "associate" | "disconnect",
	) {
		const request = context.req.raw;
		const metadata = requestMetadata(request);
		context.header("Cache-Control", "no-store");
		context.header("Referrer-Policy", "no-referrer");
		try {
			if (new URL(request.url).search)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const trusted = {
				...metadata,
				entry: await entry(request, metadata.traceId),
				agentId: context.req.param("agentId") ?? "",
			};
			let result: unknown;
			if (operation === "read") {
				if (request.body !== null)
					throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
				result = await dependencies.associations.current(trusted);
			} else if (operation === "associate") {
				const { value } = await parseJson(
					request,
					AgentConnectionAssociationRequestV1Schema,
					metadata.traceId,
				);
				result = await dependencies.associations.associate(trusted, value);
			} else {
				const { value } = await parseJson(
					request,
					AgentConnectionAssociationDisconnectRequestV1Schema,
					metadata.traceId,
				);
				result = await dependencies.associations.disconnect(trusted, value);
			}
			return context.json(
				AgentConnectionAssociationStateV1Schema.parse(result),
			);
		} catch (error) {
			const protocol =
				error instanceof HttpProtocolError
					? error
					: new HttpProtocolError(
							error instanceof AgentConnectionAssociationErrorV1
								? codes[error.code]
								: "DEPENDENCY_UNAVAILABLE",
							metadata.traceId,
						);
			return context.json(protocol.body, protocol.status);
		}
	}
	app.get("/api/v2/agents/:agentId/connection-association", (c) =>
		handle(c, "read"),
	);
	app.put("/api/v2/agents/:agentId/connection-association", (c) =>
		handle(c, "associate"),
	);
	app.delete("/api/v2/agents/:agentId/connection-association", (c) =>
		handle(c, "disconnect"),
	);
}
