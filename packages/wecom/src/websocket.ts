import { createHash, randomUUID } from "node:crypto";
import type {
	WecomMediaDownloadV1,
	WecomMediaReferenceV1,
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
/** 加密媒体的下载材料只在 Worker 内存中短暂存在（工程 Spec §14.2.3）。 */
function mediaDownload(
	value: unknown,
	expiresAt: string,
): WecomMediaDownloadV1 {
	const item = object(value);
	const url = item.url;
	const aesKey = item.aeskey;
	if (!text(url, 4096) || !text(aesKey, 256))
		throw new Error("Invalid WeCom media");
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" || parsed.username || parsed.password)
		throw new Error("Invalid WeCom media");
	return { url, aesKey, expiresAt };
}
/**
 * #3227：长连接正文与媒体。image、file、video 取下载地址与 aeskey（文件名来自下载响应）；
 * voice 只有转写文本，按普通文本受理；mixed 的文本项按顺序拼成正文，图片项作为附件。
 */
function parseContent(
	body: Record<string, unknown>,
	downloadExpiresAt: string,
): { readonly content: unknown; readonly media?: WecomMediaReferenceV1[] } {
	switch (body.msgtype) {
		case "image":
		case "file":
		case "video":
			return {
				content: "",
				media: [
					{
						kind: body.msgtype,
						name: null,
						download: mediaDownload(body[body.msgtype], downloadExpiresAt),
					},
				],
			};
		case "voice":
			return { content: object(body.voice).content };
		case "mixed": {
			const items = object(body.mixed).msg_item;
			if (!Array.isArray(items) || items.length === 0 || items.length > 64)
				throw new Error("Invalid WeCom mixed message");
			const texts: string[] = [];
			const media: WecomMediaReferenceV1[] = [];
			for (const entry of items) {
				const item = object(entry);
				if (item.msgtype === "text") {
					const value = object(item.text).content;
					if (typeof value !== "string")
						throw new Error("Invalid WeCom mixed message");
					texts.push(value);
				} else if (item.msgtype === "image")
					media.push({
						kind: "image",
						name: null,
						download: mediaDownload(item.image, downloadExpiresAt),
					});
				else throw new Error("Invalid WeCom mixed message");
			}
			if (media.length > 32) throw new Error("Invalid WeCom mixed message");
			const content = texts.join("\n").trim();
			return media.length ? { content, media } : { content };
		}
		default:
			return { content: object(body.text).content };
	}
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
	// #3077：处理中提示仍在等待 ACK 的请求。最终回复先等它结束（SDK 回复队列长度为 1），
	// 已开始最终回复的请求不再发处理中提示，避免它落在已结束的 stream 之后。只保留最近的请求。
	const acknowledging = new Map<string, Promise<unknown>>();
	const replied = new Set<string>();
	function markReplied(requestId: string) {
		replied.add(requestId);
		if (replied.size > 256) {
			const oldest = replied.values().next().value;
			if (oldest !== undefined) replied.delete(oldest);
		}
	}
	async function settleAcknowledgement(requestId: string) {
		const pending = acknowledging.get(requestId);
		if (!pending) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				pending.catch(() => {}),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, 5_000);
					timer.unref();
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	/** 揭开回复路由并核对它仍属于当前连接、绑定和会话，且未过期。 */
	async function currentRoute(
		input: { readonly scope: WecomScopeV1; readonly replyHandle: string },
		content: string,
	) {
		const route = await options.revealReply(input.replyHandle);
		const ws = route.websocket;
		if (
			!authenticated ||
			closed ||
			!ws ||
			ws.connectionId !== connectionId ||
			!text(ws.requestId) ||
			!text(ws.streamId) ||
			route.bindingReference !== config.bindingReference ||
			route.credentialVersion !== config.credentialVersion ||
			route.scope.agentId !== config.agentId ||
			route.scope.kind !== "wecom_bot" ||
			scopeKey(route.scope) !== scopeKey(input.scope) ||
			!Number.isFinite(Date.parse(route.expiresAt)) ||
			Date.parse(route.expiresAt) <= now().getTime() ||
			!text(content, 20480)
		)
			return null;
		return { route, ws };
	}
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
				!["text", "image", "file", "voice", "video", "mixed"].includes(
					body.msgtype as string,
				) ||
				!text(body.msgid) ||
				(body.chattype !== "single" && body.chattype !== "group")
			)
				return observeIngress("invalid");
			const senderId = object(body.from).userid;
			const receivedAt = now().getTime();
			// create_time is optional in the official protocol. Without it, use the authenticated receipt lifetime.
			if (
				body.create_time !== undefined &&
				(typeof body.create_time !== "number" ||
					!Number.isSafeInteger(body.create_time) ||
					Math.abs(receivedAt / 1000 - body.create_time) > 300)
			)
				return observeIngress("invalid");
			const { content, media } = parseContent(
				body,
				// #3227：官方下载地址 5 分钟内有效，从消息产生与收到中较早的一个起算。
				new Date(
					Math.min(
						typeof body.create_time === "number"
							? body.create_time * 1000
							: receivedAt,
						receivedAt,
					) + 300_000,
				).toISOString(),
			);
			const peerId = body.chattype === "single" ? senderId : body.chatid;
			if (
				!text(senderId) ||
				!text(peerId) ||
				(media === undefined
					? !text(content, 32768)
					: content !== "" && !text(content, 32768))
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
			// #3077：官方 stream 从首次发送起 10 分钟内必须结束；处理中提示在受理后立即发送，
			// 回复有效期取 9 分钟，留出余量。
			const expiresAt = new Date(receivedAt + 540_000).toISOString();
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
				text: content as string,
				...(media ? { media } : {}),
				replyHandle,
				replyExpiresAt: expiresAt,
			});
		} catch {
			observeIngress("unavailable");
		}
	}
	const receiveMessageFrame = (frame: WsFrame) => {
		if (closed || !authenticated) return;
		if (pending >= 64) {
			observeIngress("overloaded");
			return;
		}
		pending++;
		void receive(frame, connectionId).finally(() => {
			pending--;
		});
	};
	client.on("message.text", receiveMessageFrame);
	for (const kind of ["image", "file", "voice", "video", "mixed"] as const)
		client.on(`message.${kind}`, receiveMessageFrame);
	const sender: WecomSendPortV1 = {
		async send(input) {
			// #2982：stream 回复按企微思考过程样式渲染 `<think>`；带思考的文本不合规时退回只发答案，
			// 思考过程不会让答案发送失败。
			const content =
				input.textWithThinking && text(input.textWithThinking, 20480)
					? input.textWithThinking
					: input.text;
			let route: WecomReplyRouteV1;
			let ws: NonNullable<WecomReplyRouteV1["websocket"]>;
			try {
				const resolved = await currentRoute(input, content);
				if (
					!resolved ||
					sending.has(resolved.ws.requestId) ||
					!(await current())
				)
					return "failed";
				({ route, ws } = resolved);
			} catch {
				return "failed";
			}
			if (!authenticated || ws.connectionId !== connectionId || closed)
				return "failed";
			sending.add(ws.requestId);
			markReplied(ws.requestId);
			try {
				// 标记之后不会再开始新的处理中提示；已经在途的先等它结束。
				await settleAcknowledgement(ws.requestId);
				let authorized = false;
				try {
					authorized =
						(!input.revalidate || (await input.revalidate())) &&
						(await current()) &&
						authenticated &&
						!closed &&
						ws.connectionId === connectionId &&
						Date.parse(route.expiresAt) > now().getTime();
				} catch {
					return "failed";
				}
				if (!authorized) return "failed";
				const ack = await client.replyStream(
					{ headers: { req_id: ws.requestId } },
					ws.streamId,
					content,
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
	/**
	 * #3077：受理后立即在该消息的 stream 上发送 `finish=false` 的固定处理中提示。它不是业务回复：
	 * 不经回执状态机、不重发；最终回复在同一 stream 上 `finish=true` 覆盖它。
	 */
	async function acknowledge(input: {
		readonly scope: WecomScopeV1;
		readonly replyHandle: string;
		readonly text: string;
	}): Promise<"sent" | "failed" | "unknown"> {
		let ws: NonNullable<WecomReplyRouteV1["websocket"]>;
		try {
			const resolved = await currentRoute(input, input.text);
			if (!resolved || !(await current())) return "failed";
			ws = resolved.ws;
		} catch {
			return "failed";
		}
		// 同步核对后立即登记，最终回复与重复提示都不会与它交错。
		if (
			!authenticated ||
			closed ||
			ws.connectionId !== connectionId ||
			sending.has(ws.requestId) ||
			replied.has(ws.requestId) ||
			acknowledging.has(ws.requestId)
		)
			return "failed";
		let pending: ReturnType<typeof client.replyStream>;
		try {
			pending = client.replyStream(
				{ headers: { req_id: ws.requestId } },
				ws.streamId,
				input.text,
				false,
			);
		} catch {
			return "failed";
		}
		acknowledging.set(ws.requestId, pending);
		try {
			const ack = await pending;
			return ack.errcode === 0 ? "sent" : "unknown";
		} catch (error) {
			return error &&
				typeof error === "object" &&
				"errcode" in error &&
				typeof error.errcode === "number" &&
				error.errcode !== 0
				? "failed"
				: "unknown";
		} finally {
			if (acknowledging.get(ws.requestId) === pending)
				acknowledging.delete(ws.requestId);
		}
	}
	return {
		acknowledge,
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
