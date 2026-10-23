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
/** #3229：企微官方频率限制（WECOM-text-deployment.md「媒体」）。 */
const ratePerMinute = 30;
const ratePerHour = 1000;
/** 滑动窗口计数：返回一分钟与一小时内都还剩下的额度。 */
function createRateWindow() {
	const stamps: number[] = [];
	const prune = (instant: number) => {
		while (stamps.length && (stamps[0] ?? 0) <= instant - 3_600_000)
			stamps.shift();
	};
	return {
		available(instant: number) {
			prune(instant);
			const minute = stamps.filter((stamp) => stamp > instant - 60_000).length;
			return Math.max(
				0,
				Math.min(ratePerMinute - minute, ratePerHour - stamps.length),
			);
		},
		take(instant: number) {
			stamps.push(instant);
		},
		/** 归还一次没有用上的占用。 */
		release(instant: number) {
			const index = stamps.lastIndexOf(instant);
			if (index >= 0) stamps.splice(index, 1);
		},
		idle(instant: number) {
			prune(instant);
			return stamps.length === 0;
		},
	};
}
/** #3229：单个媒体的读取时限；上传由 SDK 按每帧 ACK 时限与有限重试结束，不提前放弃。 */
const mediaReadTimeoutMs = 60_000;
const mediaMaximumBytes = 20 * 1024 * 1024;
/**
 * 长连接发送一个结果文件的输入。`read` 由 Worker 提供，读取已确认结果文件的固定版本字节，
 * 只在路由与授权核对之后调用；字节不进入日志、错误或返回值。
 */
export type WecomWebSocketMediaInputV1 = Parameters<
	NonNullable<WecomSendPortV1["sendMedia"]>
>[0] & {
	readonly read: (signal: AbortSignal) => Promise<Uint8Array>;
};
/** 长连接回复端口：文本 stream 与 #3229 的媒体被动回复。 */
export interface WecomWebSocketSenderV1 {
	send: WecomSendPortV1["send"];
	planMedia: NonNullable<WecomSendPortV1["planMedia"]>;
	sendMedia(
		input: WecomWebSocketMediaInputV1,
	): Promise<"sent" | "failed" | "unknown">;
}
function providerRejected(error: unknown) {
	return (
		!!error &&
		typeof error === "object" &&
		"errcode" in error &&
		typeof error.errcode === "number" &&
		error.errcode !== 0
	);
}
async function withinDeadline<T>(
	work: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	let abort: (() => void) | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				abort = () => reject(new Error("WeCom media deadline"));
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			}),
		]);
	} finally {
		if (abort) signal.removeEventListener("abort", abort);
		// 超时后仍在进行的工作只会被丢弃，不能产生未处理的拒绝。
		work.catch(() => {});
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
	// #3229：企微频率限制。本连接持有者内存中按滑动窗口计数：每个会话的回复合计 30 条/分钟、
	// 1000 条/小时，每个机器人上传 30 次/分钟、1000 次/小时。规划媒体时占用额度。
	const uploads = createRateWindow();
	const conversations = new Map<string, ReturnType<typeof createRateWindow>>();
	function conversationWindow(scope: WecomScopeV1) {
		const key = JSON.stringify([scope.conversationType, scope.peerId]);
		const instant = now().getTime();
		for (const [other, window] of conversations)
			if (window.idle(instant)) conversations.delete(other);
		let window = conversations.get(key);
		if (!window) {
			window = createRateWindow();
			conversations.set(key, window);
		}
		return window;
	}
	// 规划时为每个请求占用的额度；同一回复重新规划或文本没有受理时归还，避免重复扣除。
	const reservations = new Map<
		string,
		{
			readonly instant: number;
			readonly count: number;
			readonly scope: WecomScopeV1;
		}
	>();
	function releaseReservation(requestId: string) {
		const reserved = reservations.get(requestId);
		if (!reserved) return;
		reservations.delete(requestId);
		const conversation = conversationWindow(reserved.scope);
		for (let index = 0; index < reserved.count; index++) {
			uploads.release(reserved.instant);
			conversation.release(reserved.instant);
		}
	}
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
	/** 揭开回复路由并核对它仍属于当前连接、绑定和会话，且未过期；有正文时同时核对正文。 */
	async function currentRoute(
		input: { readonly scope: WecomScopeV1; readonly replyHandle: string },
		content?: string,
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
			(content !== undefined && !text(content, 20480))
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
	async function sendText(
		input: Parameters<WecomSendPortV1["send"]>[0],
		resolvedRequest: (requestId: string) => void,
	): Promise<"sent" | "failed" | "unknown"> {
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
			if (resolved) resolvedRequest(resolved.ws.requestId);
			if (!resolved || sending.has(resolved.ws.requestId) || !(await current()))
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
			conversationWindow(route.scope).take(now().getTime());
			const ack = await client.replyStream(
				{ headers: { req_id: ws.requestId } },
				ws.streamId,
				content,
				true,
			);
			return ack.errcode === 0 ? "sent" : "unknown";
		} catch (error) {
			return providerRejected(error) ? "failed" : "unknown";
		} finally {
			sending.delete(ws.requestId);
		}
	}
	const sender: WecomWebSocketSenderV1 = {
		async send(input) {
			let requestId: string | undefined;
			const status = await sendText(input, (id) => {
				requestId = id;
			});
			// 文本没有受理时不会发送媒体，归还规划时为它占用的媒体额度。
			if (status !== "sent" && requestId) releaseReservation(requestId);
			return status;
		},
		/**
		 * #3229：发送文本前规划媒体。回复路由不属于当前连接时按不支持处理；按会话与机器人的剩余
		 * 频率额度依次占用，文本本身占会话的一条。同一回复重新规划时先归还上一次的占用。
		 */
		async planMedia(input) {
			try {
				const resolved = await currentRoute(input);
				if (!resolved || !(await current())) return null;
				releaseReservation(resolved.ws.requestId);
				const instant = now().getTime();
				const conversation = conversationWindow(resolved.route.scope);
				let room = Math.min(
					uploads.available(instant),
					conversation.available(instant) - 1,
				);
				let count = 0;
				const plans = input.files.map(() => {
					if (room <= 0) return "rate_limited" as const;
					room--;
					count++;
					uploads.take(instant);
					conversation.take(instant);
					return "send" as const;
				});
				if (count) {
					reservations.set(resolved.ws.requestId, {
						instant,
						count,
						scope: resolved.route.scope,
					});
					// 只保留最近的占用记录；更早的回复已经结束或会随时间窗口自然过期。
					if (reservations.size > 256) {
						const oldest = reservations.keys().next().value;
						if (oldest !== undefined) reservations.delete(oldest);
					}
				}
				return plans;
			} catch {
				return null;
			}
		},
		/**
		 * #3229：文本 stream 结束后被动回复一个结果文件：核对路由与当前授权，读取固定版本，分片上传
		 * 临时素材，再次核对后 `replyMedia`。上传没有用户可见的效果，失败一律为 failed；回复被企微
		 * 拒绝为 failed，ACK 丢失或断连为 unknown，不重发。`media_id` 与字节只在本次调用内使用。
		 * 上传由 SDK 按每帧 ACK 时限与有限重试结束；这里等待它真正结束，调用方的并发上限才有效。
		 */
		async sendMedia(input) {
			const file = input.file;
			if (
				!["image", "video", "file"].includes(file.kind) ||
				!text(file.name, 1024) ||
				!Number.isSafeInteger(file.sizeBytes) ||
				file.sizeBytes < 5 ||
				file.sizeBytes > mediaMaximumBytes
			)
				return "failed";
			let route: WecomReplyRouteV1;
			let ws: NonNullable<WecomReplyRouteV1["websocket"]>;
			try {
				const resolved = await currentRoute(input);
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
			reservations.delete(ws.requestId);
			const usable = async () => {
				try {
					return (
						(await input.revalidate()) &&
						(await current()) &&
						authenticated &&
						!closed &&
						ws.connectionId === connectionId &&
						Date.parse(route.expiresAt) > now().getTime()
					);
				} catch {
					return false;
				}
			};
			try {
				if (!(await usable())) return "failed";
				let mediaId: string;
				try {
					const deadline = AbortSignal.timeout(mediaReadTimeoutMs);
					const read = await withinDeadline(input.read(deadline), deadline);
					if (read.byteLength !== file.sizeBytes) return "failed";
					// 读取可能耗时：上传前确认连接仍可用，断开后不再开始上传。
					if (!authenticated || closed || ws.connectionId !== connectionId)
						return "failed";
					const uploaded = await client.uploadMedia(
						Buffer.from(read.buffer, read.byteOffset, read.byteLength),
						{ type: file.kind, filename: file.name },
					);
					if (!text(uploaded?.media_id, 1024)) return "failed";
					mediaId = uploaded.media_id;
				} catch {
					return "failed";
				}
				// 上传可能耗时：被动回复前再核对一次授权、连接与回复有效期。
				if (!(await usable())) return "failed";
				try {
					const ack = await client.replyMedia(
						{ headers: { req_id: ws.requestId } },
						file.kind,
						mediaId,
					);
					return ack.errcode === 0 ? "sent" : "unknown";
				} catch (error) {
					return providerRejected(error) ? "failed" : "unknown";
				}
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
