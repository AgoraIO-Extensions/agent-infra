import { createHash, randomUUID } from "node:crypto";
import type {
	WecomMessageV1,
	WecomScopeV1,
	WecomSendPortV1,
} from "@agent-infra/platform-core";
import {
	WSAuthFailureError,
	WSClient,
	WSReconnectExhaustedError,
	type WsFrame,
} from "@wecom/aibot-node-sdk";
import type { WecomReplyRouteV1 } from "./reply.js";

export interface WecomWebSocketConfigurationV1 {
	readonly agentId: string;
	readonly bindingReference: string;
	readonly credentialVersion: string;
	readonly botId: string;
	readonly secret: string;
}
export type WecomConnectionStatusV1 =
	| "verifying"
	| "connected"
	| "disconnected"
	| "auth_failed";
const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };
function text(value: unknown, maximum = 1024): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.isWellFormed() &&
		!value.includes("\0") &&
		Buffer.byteLength(value) <= maximum
	);
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid WeCom frame");
	return value as Record<string, unknown>;
}
function scopeKey(scope: WecomMessageV1 | WecomReplyRouteV1["scope"]) {
	return JSON.stringify([
		scope.agentId,
		scope.bindingReference,
		scope.kind,
		scope.senderId,
		scope.peerId,
		scope.conversationType,
		scope.threadId,
	]);
}
/** Transport only. The caller owns durable connection fencing and the shared Core ingress. */
export function createWecomWebSocketV1(options: {
	readonly configuration: WecomWebSocketConfigurationV1;
	/** Trusted deployment input, never a browser-supplied URL. */
	readonly endpoint?: string;
	readonly isCurrent: () => Promise<boolean>;
	readonly isLocallyCurrent?: () => boolean;
	readonly receive: (message: WecomMessageV1) => Promise<void>;
	readonly protectReply: (route: WecomReplyRouteV1) => Promise<string>;
	readonly revealReply: (handle: string) => Promise<WecomReplyRouteV1>;
	readonly observe: (status: WecomConnectionStatusV1) => void;
	readonly observeIngress?: (
		outcome: "invalid" | "overloaded" | "unavailable",
	) => void;
	readonly now?: () => Date;
}) {
	const config = { ...options.configuration };
	if (Object.values(config).some((value) => !text(value)))
		throw new Error("Invalid WeCom connection configuration");
	const now = options.now ?? (() => new Date());
	const client = new WSClient({
		botId: config.botId,
		secret: config.secret,
		...(options.endpoint ? { wsUrl: options.endpoint } : {}),
		logger: quietLogger,
		maxAuthFailureAttempts: 0,
		maxReconnectAttempts: 5,
		maxReplyQueueSize: 1,
		wsOptions: {
			maxPayload: 128 * 1024,
			handshakeTimeout: 5000,
			finishRequest(request, socket) {
				// ws emits upgrade before open; fence here because the SDK sends auth before its connected event.
				socket.on("upgrade", () => {
					if (closed || options.isLocallyCurrent?.() === false) close();
				});
				if (closed || options.isLocallyCurrent?.() === false) request.destroy();
				else request.end();
			},
		},
	});
	let resolveAuthentication: (value: boolean) => void = () => {};
	const authentication = new Promise<boolean>((resolve) => {
		resolveAuthentication = resolve;
	});
	let closed = false;
	let terminalReason:
		| "ownership_lost"
		| "auth_failed"
		| "retry_exhausted"
		| "stopped"
		| "timeout"
		| null = null;
	let started = false;
	let authenticated = false;
	let connectionId = randomUUID();
	let authTimer: ReturnType<typeof setTimeout> | undefined;
	let pending = 0;
	const ownershipTimer = setInterval(() => {
		if (options.isLocallyCurrent?.() === false) close("ownership_lost");
	}, 500);
	ownershipTimer.unref();
	const sending = new Set<string>();
	function observe(status: WecomConnectionStatusV1) {
		try {
			options.observe(status);
		} catch {
			/* Metrics cannot change transport behavior. */
		}
	}
	function close(reason: NonNullable<typeof terminalReason> = "stopped") {
		if (closed) return;
		closed = true;
		terminalReason = reason;
		resolveAuthentication(false);
		clearInterval(ownershipTimer);
		authenticated = false;
		clearTimeout(authTimer);
		client.disconnect();
		observe("disconnected");
	}
	async function current() {
		try {
			if (
				!closed &&
				options.isLocallyCurrent?.() !== false &&
				(await options.isCurrent())
			)
				return !closed && options.isLocallyCurrent?.() !== false;
		} catch {
			/* Fail closed on lease lookup failure. */
		}
		close("ownership_lost");
		return false;
	}
	function verifying() {
		if (closed || options.isLocallyCurrent?.() === false) {
			close();
			return;
		}
		authenticated = false;
		connectionId = randomUUID();
		clearTimeout(authTimer);
		observe("verifying");
		authTimer = setTimeout(() => close("timeout"), 15_000);
		authTimer.unref();
	}
	client.on("connected", verifying);
	client.on("authenticated", () => {
		clearTimeout(authTimer);
		if (closed || options.isLocallyCurrent?.() === false) {
			close();
			return;
		}
		authenticated = true;
		resolveAuthentication(true);
		observe("connected");
	});
	client.on("disconnected", () => {
		authenticated = false;
		clearTimeout(authTimer);
		observe("disconnected");
	});
	client.on("reconnecting", () => {
		authenticated = false;
		observe("disconnected");
		if (options.isLocallyCurrent?.() === false) close("ownership_lost");
		else void current();
	});
	client.on("error", (error) => {
		// Initial SDK auth errors include provider data; only its typed terminal errors determine status.
		if (error instanceof WSAuthFailureError) {
			close("auth_failed");
			observe("auth_failed");
		} else if (error instanceof WSReconnectExhaustedError)
			close("retry_exhausted");
	});
	function observeIngress(outcome: "invalid" | "overloaded" | "unavailable") {
		try {
			options.observeIngress?.(outcome);
		} catch {
			/* Fixed-label observation only. */
		}
	}

	async function receive(frame: WsFrame, generation: string) {
		try {
			if (
				!authenticated ||
				closed ||
				frame.cmd !== "aibot_msg_callback" ||
				Buffer.byteLength(JSON.stringify(frame)) > 128 * 1024
			)
				return observeIngress("invalid");
			const body = object(frame.body);
			const headers = object(frame.headers);
			if (
				!text(headers.req_id) ||
				body.aibotid !== config.botId ||
				body.msgtype !== "text" ||
				!text(body.msgid) ||
				(body.chattype !== "single" && body.chattype !== "group")
			)
				return observeIngress("invalid");
			const senderId = object(body.from).userid;
			const content = object(body.text).content;
			const peerId = body.chattype === "single" ? senderId : body.chatid;
			if (!text(senderId) || !text(peerId) || !text(content, 32768))
				return observeIngress("invalid");
			const receivedAt = now().getTime();
			// create_time is optional in the official protocol. Without it, use the authenticated receipt lifetime.
			if (
				body.create_time !== undefined &&
				(typeof body.create_time !== "number" ||
					!Number.isSafeInteger(body.create_time) ||
					Math.abs(receivedAt / 1000 - body.create_time) > 300)
			)
				return observeIngress("invalid");
			if (!(await current()) || !authenticated || generation !== connectionId)
				return observeIngress("invalid");
			const scope: WecomScopeV1 = {
				agentId: config.agentId,
				bindingReference: config.bindingReference,
				kind: "wecom_bot" as const,
				senderId,
				peerId,
				conversationType: body.chattype,
				threadId: null,
			};
			const expiresAt = new Date(receivedAt + 300_000).toISOString();
			const replyHandle = await options.protectReply({
				bindingReference: config.bindingReference,
				credentialVersion: config.credentialVersion,
				expiresAt,
				scope,
				websocket: {
					connectionId: generation,
					requestId: headers.req_id,
					streamId: createHash("sha256").update(body.msgid).digest("hex"),
				},
			});
			if (
				!(await current()) ||
				!authenticated ||
				generation !== connectionId ||
				now().getTime() >= Date.parse(expiresAt)
			)
				return observeIngress("invalid");
			await options.receive({
				...scope,
				providerId: config.botId,
				eventId: body.msgid,
				text: content,
				replyHandle,
				replyExpiresAt: expiresAt,
			});
		} catch {
			observeIngress("unavailable");
		}
	}
	client.on("message.text", (frame) => {
		if (closed || !authenticated) return;
		if (pending >= 64) {
			observeIngress("overloaded");
			return;
		}
		pending++;
		void receive(frame, connectionId).finally(() => {
			pending--;
		});
	});
	const sender: WecomSendPortV1 = {
		async send(input) {
			let route: WecomReplyRouteV1;
			try {
				route = await options.revealReply(input.replyHandle);
				if (
					!authenticated ||
					closed ||
					!route.websocket ||
					route.websocket.connectionId !== connectionId ||
					!text(route.websocket.requestId) ||
					!text(route.websocket.streamId) ||
					route.bindingReference !== config.bindingReference ||
					route.credentialVersion !== config.credentialVersion ||
					route.scope.agentId !== config.agentId ||
					route.scope.kind !== "wecom_bot" ||
					scopeKey(route.scope) !== scopeKey(input.scope) ||
					!Number.isFinite(Date.parse(route.expiresAt)) ||
					Date.parse(route.expiresAt) <= now().getTime() ||
					!text(input.text, 20480) ||
					sending.has(route.websocket.requestId) ||
					!(await current())
				)
					return "failed";
			} catch {
				return "failed";
			}
			const ws = route.websocket;
			if (!ws || !authenticated || ws.connectionId !== connectionId || closed)
				return "failed";
			sending.add(ws.requestId);
			try {
				const ack = await client.replyStream(
					{ headers: { req_id: ws.requestId } },
					ws.streamId,
					input.text,
					true,
				);
				return ack.errcode === 0 ? "sent" : "unknown";
			} catch (error) {
				if (
					error &&
					typeof error === "object" &&
					"errcode" in error &&
					typeof error.errcode === "number" &&
					error.errcode !== 0
				)
					return "failed";
				return "unknown";
			} finally {
				sending.delete(ws.requestId);
			}
		},
	};
	return {
		async connect() {
			if (started || closed) return;
			started = true;
			if (await current()) {
				verifying();
				client.connect();
			}
		},
		sender,
		authentication,
		get terminalReason() {
			return terminalReason;
		},
		close,
	};
}
