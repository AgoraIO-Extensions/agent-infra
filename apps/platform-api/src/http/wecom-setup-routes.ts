import { WecomSetupCredentialsV1Schema } from "@agent-infra/contracts/pilot";
import {
	type createWecomSetupV1,
	WecomSetupError,
} from "@agent-infra/platform-core";
import type { Hono } from "hono";
import { HttpProtocolError, parseJson, requestMetadata } from "./common.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";
export function registerWecomSetupRoutesV1(
	app: Hono,
	dependencies: {
		readonly identity: IdentityAdapter;
		readonly setup: ReturnType<typeof createWecomSetupV1>;
	},
) {
	app.get("/api/v1/agents/:agentId/wecom-bot", async (context) => {
		const metadata = requestMetadata(context.req.raw);
		const identity = await resolveIdentity(
			dependencies.identity,
			context.req.raw,
			metadata.traceId,
		);
		try {
			return context.json(
				await dependencies.setup.current(
					context.req.param("agentId"),
					identity.userId,
				),
			);
		} catch {
			throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
		}
	});
	const base = "/api/v1/agents/:agentId/wecom-setup";
	for (const [method, suffix, operation] of [
		["POST", "", "begin"],
		["GET", "/:sessionId", "read"],
		["POST", "/:sessionId/credentials", "submit"],
		["POST", "/:sessionId/cancel", "cancel"],
	] as const) {
		app.on(method, base + suffix, async (context) => {
			const request = context.req.raw;
			const metadata = requestMetadata(request);
			const identity = await resolveIdentity(
				dependencies.identity,
				request,
				metadata.traceId,
			);
			const agentId = context.req.param("agentId");
			const sessionId = context.req.param("sessionId");
			if (!agentId)
				throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
			try {
				if (operation === "begin")
					return context.json({
						...(await dependencies.setup.begin(agentId, identity.userId)),
						qrAvailable: false,
						qrUnavailableReason: "authorization_correlation_unverified",
					});
				if (!sessionId)
					throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
				if (operation === "submit") {
					const { value } = await parseJson(
						request,
						WecomSetupCredentialsV1Schema,
						metadata.traceId,
					);
					return context.json(
						await dependencies.setup.submit(
							{ ...value, agentId, sessionId },
							identity.userId,
						),
					);
				}
				return context.json(
					await dependencies.setup[operation](
						agentId,
						identity.userId,
						sessionId,
					),
				);
			} catch (error) {
				if (error instanceof HttpProtocolError) throw error;
				if (error instanceof WecomSetupError)
					throw new HttpProtocolError(
						error.code === "stale"
							? "CONFLICT"
							: error.code === "invalid" ||
									error.code === "confirmation_required"
								? "INVALID_REQUEST"
								: "RESOURCE_UNAVAILABLE",
						metadata.traceId,
					);
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			}
		});
	}
}
