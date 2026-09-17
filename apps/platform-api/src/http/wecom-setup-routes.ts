import {
	WecomApplicationCredentialsV1Schema,
	WecomSetupCredentialsV1Schema,
} from "@agent-infra/contracts/pilot";
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
		readonly callbackUrl?: (sessionId: string) => string | undefined;
		readonly application?: boolean;
	},
) {
	app.get(
		dependencies.application
			? "/api/v1/agents/:agentId/wecom-app"
			: "/api/v1/agents/:agentId/wecom-bot",
		async (context) => {
			const metadata = requestMetadata(context.req.raw);
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			try {
				const current = await dependencies.setup.current(
					context.req.param("agentId"),
					identity.userId,
					...(dependencies.application ? ["wecom_app" as const] : []),
				);
				return context.json(
					dependencies.application &&
						"sessionId" in current &&
						current.sessionId
						? {
								...current,
								callbackUrl: dependencies.callbackUrl?.(current.sessionId),
							}
						: current,
				);
			} catch {
				throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
			}
		},
	);
	const base = dependencies.application
		? "/api/v1/agents/:agentId/wecom-app-setup"
		: "/api/v1/agents/:agentId/wecom-setup";
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
				if (operation === "begin") {
					const session = await dependencies.setup.begin(
						agentId,
						identity.userId,
						dependencies.application ? "wecom_app" : "wecom_bot",
					);
					return context.json(
						dependencies.application
							? {
									...session,
									callbackUrl: dependencies.callbackUrl?.(session.sessionId),
								}
							: {
									...session,
									qrAvailable: false,
									qrUnavailableReason: "authorization_correlation_unverified",
								},
					);
				}
				if (!sessionId)
					throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
				if (operation === "submit" && dependencies.application) {
					const { value } = await parseJson(
						request,
						WecomApplicationCredentialsV1Schema,
						metadata.traceId,
					);
					return context.json({
						...(await dependencies.setup.submitApplication(
							{ ...value, agentId, sessionId },
							identity.userId,
						)),
						callbackUrl: dependencies.callbackUrl?.(sessionId),
					});
				}
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
				const result = await dependencies.setup[operation](
					agentId,
					identity.userId,
					sessionId,
				);
				return context.json(
					dependencies.application
						? { ...result, callbackUrl: dependencies.callbackUrl?.(sessionId) }
						: result,
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
