import {
	AgentDefaultRelayKeyCandidatesV1Schema,
	AgentDefaultRelayKeySavedCandidatesV1Schema,
	AgentDefaultRelayKeyStateV1Schema,
	AgentDefaultRelayKeyCandidatesRequestV1Schema as candidates,
	AgentDefaultRelayKeyReplaceRequestV1Schema as replace,
} from "@agent-infra/contracts/pilot";
import {
	type RuntimeSavedKeyCandidatesRequestV1,
	RuntimeSavedKeyCandidatesRequestV1Schema,
	RuntimeSavedKeyCandidatesResponseV1Schema,
} from "@agent-infra/contracts/runtime";
import type { createAgentDefaultRelayKeyUseCaseV1 } from "@agent-infra/platform-core";
import { AgentDefaultRelayKeyErrorV1 } from "@agent-infra/platform-core";
import type { Context, Hono } from "hono";
import { HttpProtocolError, parseJson, requestMetadata } from "./common.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

export interface AgentDefaultRelayKeyRoutesDependencies {
	readonly identity: IdentityAdapter;
	readonly keys: ReturnType<typeof createAgentDefaultRelayKeyUseCaseV1>;
	readonly savedCandidates?: {
		read(
			request: RuntimeSavedKeyCandidatesRequestV1,
			signal: AbortSignal,
		): Promise<unknown>;
	};
}
export function registerAgentDefaultRelayKeyRoutes(
	app: Hono,
	dependencies: AgentDefaultRelayKeyRoutesDependencies,
) {
	async function handle(
		context: Context,
		operation: "read" | "replace" | "candidates" | "read-saved-candidates",
	) {
		const request = context.req.raw;
		const metadata = requestMetadata(request);
		context.header("Cache-Control", "no-store");
		context.header("Referrer-Policy", "no-referrer");
		try {
			if (request.headers.has("Authorization"))
				throw new HttpProtocolError(
					"AUTHENTICATION_REQUIRED",
					metadata.traceId,
				);
			if (new URL(request.url).search)
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const identity = await resolveIdentity(
				dependencies.identity,
				request,
				metadata.traceId,
			);
			const trusted = {
				...metadata,
				userId: identity.userId,
				agentId: context.req.param("agentId") ?? "",
			};
			if (operation === "read") {
				if (request.body !== null)
					throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
				return context.json(
					AgentDefaultRelayKeyStateV1Schema.parse(
						await dependencies.keys.current(trusted),
					),
				);
			}
			if (operation === "read-saved-candidates") {
				if (request.body !== null)
					throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
				if (!dependencies.savedCandidates)
					throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
				const state = AgentDefaultRelayKeyStateV1Schema.parse(
					await dependencies.keys.current(trusted),
				);
				if (!state.isSet || state.keyVersion === null)
					throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
				const controller = new AbortController();
				try {
					const response = RuntimeSavedKeyCandidatesResponseV1Schema.parse(
						await dependencies.savedCandidates.read(
							RuntimeSavedKeyCandidatesRequestV1Schema.parse({
								schemaVersion: 1,
								requestId: metadata.requestId,
								traceId: metadata.traceId,
								actorId: identity.userId,
								agentId: trusted.agentId,
								configurationRevision: state.configurationRevision,
								keyVersion: state.keyVersion,
							}),
							controller.signal,
						),
					);
					if (
						response.agentId !== trusted.agentId ||
						response.configurationRevision !== state.configurationRevision ||
						response.keyVersion !== state.keyVersion
					)
						throw new Error("SAVED_RELAY_KEY_BINDING_INVALID");
					return context.json(
						AgentDefaultRelayKeySavedCandidatesV1Schema.parse({
							schemaVersion: response.schemaVersion,
							configurationRevision: response.configurationRevision,
							keyVersion: response.keyVersion,
							candidates: response.candidates,
						}),
					);
				} finally {
					controller.abort();
				}
			}
			const { value } = await parseJson(
				request,
				operation === "replace" ? replace : candidates,
				metadata.traceId,
			);
			const result = await dependencies.keys[operation](trusted, value);
			return context.json(
				(operation === "replace"
					? AgentDefaultRelayKeyStateV1Schema
					: AgentDefaultRelayKeyCandidatesV1Schema
				).parse(result),
			);
		} catch (error) {
			const protocol =
				error instanceof HttpProtocolError
					? error
					: new HttpProtocolError(
							error instanceof AgentDefaultRelayKeyErrorV1
								? error.code === "not_authorized"
									? "RESOURCE_UNAVAILABLE"
									: error.code === "invalid_input"
										? "INVALID_REQUEST"
										: error.code === "conflict"
											? "CONFLICT"
											: "DEPENDENCY_UNAVAILABLE"
								: "DEPENDENCY_UNAVAILABLE",
							metadata.traceId,
						);
			return context.json(protocol.body, protocol.status);
		}
	}
	app.get("/api/v2/agents/:agentId/default-relay-key", (c) =>
		handle(c, "read"),
	);
	app.get("/api/v2/agents/:agentId/default-relay-key/candidates", (c) =>
		handle(c, "read-saved-candidates"),
	);
	app.put("/api/v2/agents/:agentId/default-relay-key", (c) =>
		handle(c, "replace"),
	);
	app.post("/api/v2/agents/:agentId/default-relay-key/candidates", (c) =>
		handle(c, "candidates"),
	);
}
