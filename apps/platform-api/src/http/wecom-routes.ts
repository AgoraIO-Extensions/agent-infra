import type {
	createWecomChannelV1,
	createWecomReceiptAccessV1,
	WecomMessageV1,
} from "@agent-infra/platform-core";
import type {
	createWecomAdapterV1,
	WecomConfigurationV1,
} from "@agent-infra/wecom";
import type { Hono } from "hono";
import { HttpProtocolError, requestMetadata } from "./common.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";
export interface WecomRoutesDependenciesV1 {
	readonly receipts: ReturnType<typeof createWecomReceiptAccessV1>;
	readonly identity?: IdentityAdapter;
	readonly resolveBinding: (
		reference: string,
	) => Promise<WecomConfigurationV1 | null>;
	readonly adapter: ReturnType<typeof createWecomAdapterV1>;
	readonly channel: ReturnType<typeof createWecomChannelV1>;
	readonly observe: (
		result:
			| "accepted"
			| "replayed"
			| "denied"
			| "unavailable"
			| "conflict"
			| "invalid",
	) => void;
}
export type WecomReceiptRoutesDependenciesV1 = Pick<
	WecomRoutesDependenciesV1,
	"receipts" | "identity"
>;
export function registerWecomReceiptRoutesV1(
	app: Hono,
	dependencies: WecomReceiptRoutesDependenciesV1,
) {
	app.get("/api/v1/wecom/receipts", async (context) => {
		const traceId = requestMetadata(context.req.raw).traceId;
		const identity = await resolveIdentity(
			dependencies.identity,
			context.req.raw,
			traceId,
		);
		const cursor = context.req.query("cursor");
		if (cursor !== undefined && !/^[a-f0-9]{64}$/.test(cursor))
			throw new HttpProtocolError("INVALID_REQUEST", traceId);
		return context.json(
			await dependencies.receipts.list(identity.userId, cursor),
		);
	});
	app.get("/api/v1/wecom/receipts/:receiptId", async (context) => {
		const identity = await resolveIdentity(
			dependencies.identity,
			context.req.raw,
			requestMetadata(context.req.raw).traceId,
		);
		const receipt = await dependencies.receipts.read(
			context.req.param("receiptId"),
			identity.userId,
		);
		if (!receipt)
			throw new HttpProtocolError(
				"RESOURCE_UNAVAILABLE",
				requestMetadata(context.req.raw).traceId,
			);
		return context.json({ schemaVersion: 1, ...receipt });
	});
	app.post("/api/v1/wecom/receipts/:receiptId/abandon", async (context) => {
		const identity = await resolveIdentity(
			dependencies.identity,
			context.req.raw,
			requestMetadata(context.req.raw).traceId,
		);
		const abandoned = await dependencies.receipts.abandon(
			context.req.param("receiptId"),
			identity.userId,
		);
		if (!abandoned)
			throw new HttpProtocolError(
				"RESOURCE_UNAVAILABLE",
				requestMetadata(context.req.raw).traceId,
			);
		return context.json({ schemaVersion: 1, status: "abandoned" });
	});
}
export function registerWecomRoutesV1(
	app: Hono,
	dependencies: WecomRoutesDependenciesV1,
) {
	const observe = (
		result: Parameters<WecomRoutesDependenciesV1["observe"]>[0],
	) => {
		try {
			dependencies.observe(result);
		} catch {
			/* Metrics must not alter acceptance. */
		}
	};
	app.on(
		["GET", "POST"],
		"/callbacks/wecom/:bindingReference",
		async (context) => {
			let configuration: WecomConfigurationV1 | null;
			try {
				configuration = await dependencies.resolveBinding(
					context.req.param("bindingReference"),
				);
			} catch {
				return context.text("Unavailable", 503);
			}
			if (
				!configuration ||
				configuration.bindingReference !== context.req.param("bindingReference")
			)
				return context.text("Not found", 404);
			let message: WecomMessageV1;
			let replyRequest: Request;
			try {
				const callbackRequest = context.req.raw.clone();
				replyRequest = context.req.raw.clone();
				const callback = await dependencies.adapter.receive(
					configuration,
					callbackRequest,
				);
				if (callback.type === "challenge") return context.text(callback.text);
				message = callback.message;
			} catch {
				observe("invalid");
				return context.text("Invalid callback", 400);
			}
			try {
				const result = await dependencies.channel.receive(message);
				observe(result.outcome);
				if (result.outcome === "denied")
					return dependencies.adapter.passiveReply(
						configuration,
						replyRequest,
						message,
						"暂无权限使用此 Agent",
					);
				if (result.outcome === "unavailable")
					return dependencies.adapter.passiveReply(
						configuration,
						replyRequest,
						message,
						"Agent 当前不可用，请稍后重试",
					);
				if (result.outcome === "conflict")
					return context.text("Conflicting callback", 409);
				return context.text("");
			} catch {
				observe("unavailable");
				return context.text("Unavailable", 503);
			}
		},
	);
	registerWecomReceiptRoutesV1(app, dependencies);
}
