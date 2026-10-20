import {
	WecomApplicationCredentialsV1Schema,
	WecomBotConnectionProjectionV2Schema,
	WecomSetupCredentialsV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	type createWecomSetupV1,
	WecomSetupError,
} from "@agent-infra/platform-core";
import type { Context, Hono } from "hono";
import type { WecomBotQrConfigurationV1 } from "../wecom-setup-assembly.js";
import { HttpProtocolError, parseJson, requestMetadata } from "./common.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

/**
 * 扫码能力的唯一判定（#2911）：机器人状态 V2 与建立配置会话的响应都只由这里得出，
 * 只看部署获准的扫码配置，不接受请求指定的授权端点。
 */
export function resolveWecomBotQrAvailabilityV1(
	botQr: WecomBotQrConfigurationV1 | undefined,
):
	| {
			readonly qrAvailable: false;
			readonly qrUnavailableReason: "authorization_correlation_unverified";
	  }
	| { readonly qrAvailable: true; readonly botQr: WecomBotQrConfigurationV1 } {
	return botQr
		? { qrAvailable: true, botQr }
		: {
				qrAvailable: false,
				qrUnavailableReason: "authorization_correlation_unverified",
			};
}

export function registerWecomSetupRoutesV1(
	app: Hono,
	dependencies: {
		readonly identity: IdentityAdapter;
		readonly setup: ReturnType<typeof createWecomSetupV1>;
		readonly application?: boolean;
		readonly callbackUrl?: (sessionId: string) => string;
		readonly botQr?: WecomBotQrConfigurationV1;
	},
) {
	if (dependencies.application && !dependencies.callbackUrl)
		throw new Error("WeCom application callback URL unavailable");
	// 连接状态先按当前账号解析 Owner 权限；非 Owner、其他 Agent 与不存在的 Agent 同为 404。
	async function readCurrent(context: Context) {
		const metadata = requestMetadata(context.req.raw);
		const identity = await resolveIdentity(
			dependencies.identity,
			context.req.raw,
			metadata.traceId,
		);
		try {
			return {
				metadata,
				current: await dependencies.setup.current(
					context.req.param("agentId") ?? "",
					identity.userId,
					dependencies.application ? "wecom_app" : "wecom_bot",
				),
			};
		} catch {
			throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
		}
	}
	app.get(
		dependencies.application
			? "/api/v1/agents/:agentId/wecom-app"
			: "/api/v1/agents/:agentId/wecom-bot",
		async (context) => {
			const { current } = await readCurrent(context);
			return context.json(
				dependencies.application && "sessionId" in current && current.sessionId
					? {
							...current,
							callbackUrl: dependencies.callbackUrl?.(current.sessionId),
						}
					: current,
			);
		},
	);
	// #2911：V2 状态只在 Owner 权限校验通过后附带扫码能力；V1 响应保持只含 status。
	if (!dependencies.application)
		app.get("/api/v2/agents/:agentId/wecom-bot", async (context) => {
			const { metadata, current } = await readCurrent(context);
			const availability = resolveWecomBotQrAvailabilityV1(dependencies.botQr);
			const projection = WecomBotConnectionProjectionV2Schema.safeParse(
				availability.qrAvailable
					? { status: current.status, qrAvailable: true }
					: {
							status: current.status,
							qrAvailable: false,
							qrUnavailableReason: availability.qrUnavailableReason,
						},
			);
			if (!projection.success)
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			return context.json(projection.data);
		});
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
					if (dependencies.application)
						return context.json({
							...session,
							callbackUrl: dependencies.callbackUrl?.(session.sessionId),
						});
					const availability = resolveWecomBotQrAvailabilityV1(
						dependencies.botQr,
					);
					if (!availability.qrAvailable)
						return context.json({
							...session,
							qrAvailable: false,
							qrUnavailableReason: availability.qrUnavailableReason,
						});
					const { botQr } = availability;
					const authorizationUrl = new URL(botQr.authorizationEndpoint);
					authorizationUrl.searchParams.set("source", botQr.source);
					authorizationUrl.searchParams.set("state", session.state);
					return context.json({
						...session,
						qrAvailable: true,
						qr: {
							authorizationUrl: authorizationUrl.href,
							authOrigin: botQr.authOrigin,
							source: botQr.source,
							state: session.state,
						},
					});
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
					dependencies.application ? "wecom_app" : "wecom_bot",
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
