import { createHash } from "node:crypto";
import { once } from "node:events";
import type { WecomMessageV1 } from "@agent-infra/platform-core";
import { afterEach, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import {
	createWecomWebSocketV1,
	type WecomWebSocketMediaInputV1,
} from "./websocket.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup() {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await once(server, "listening");
	const address = server.address();
	if (typeof address === "string" || !address) throw new Error("No address");
	const messages: WecomMessageV1[] = [];
	const states: string[] = [];
	let current = true;
	const adapter = createWecomWebSocketV1({
		configuration: {
			agentId: "agent-1",
			bindingReference: "binding-1",
			credentialVersion: "v1",
			botId: "bot-1",
			secret: "fixture-secret",
		},
		endpoint: `ws://127.0.0.1:${address.port}`,
		isCurrent: async () => current,
		receive: async (message) => {
			messages.push(message);
		},
		protectReply: async (route) => JSON.stringify(route),
		revealReply: async (handle) => JSON.parse(handle),
		observe: (state) => states.push(state),
	});
	cleanups.push(async () => {
		adapter.close();
		for (const socket of server.clients) socket.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const connected = once(server, "connection");
	await adapter.connect();
	const [socket] = (await connected) as [WebSocket];
	const [raw] = await once(socket, "message");
	const auth = JSON.parse(raw.toString());
	expect(auth.cmd).toBe("aibot_subscribe");
	const authenticate = async () => {
		socket.send(JSON.stringify({ headers: auth.headers, errcode: 0 }));
		await expect.poll(() => states).toContain("connected");
	};
	const push = (overrides = {}) =>
		socket.send(
			JSON.stringify({
				cmd: "aibot_msg_callback",
				headers: { req_id: "request-1" },
				body: {
					aibotid: "bot-1",
					msgid: "event-1",
					chattype: "group",
					chatid: "group-1",
					from: { userid: "sender-1" },
					msgtype: "text",
					text: { content: "fixture question" },
					...overrides,
				},
			}),
		);
	return {
		adapter,
		server,
		socket,
		messages,
		states,
		authenticate,
		push,
		revoke: () => {
			current = false;
		},
	};
}
it("admits only authenticated text for the configured bot through the official SDK", async () => {
	const s = await setup();
	s.push();
	await s.authenticate();
	s.push({ aibotid: "other-bot" });
	s.push();
	await expect.poll(() => s.messages.length).toBe(1);
	expect(s.messages[0]).toMatchObject({
		agentId: "agent-1",
		providerId: "bot-1",
		eventId: "event-1",
		peerId: "group-1",
		senderId: "sender-1",
		threadId: null,
	});
});
it("maps authenticated media callbacks to Worker-only download material (#3227)", async () => {
	const s = await setup();
	await s.authenticate();
	s.push({
		msgid: "media-event",
		msgtype: "file",
		file: { url: "https://provider.test/media/file-1", aeskey: "fixture-key" },
	});
	s.push({
		msgid: "voice-event",
		msgtype: "voice",
		voice: { content: "语音转写的问题" },
	});
	s.push({
		msgid: "mixed-event",
		msgtype: "mixed",
		mixed: {
			msg_item: [
				{ msgtype: "text", text: { content: "第一段" } },
				{
					msgtype: "image",
					image: { url: "https://provider.test/media/image-1", aeskey: "k1" },
				},
				{ msgtype: "text", text: { content: "第二段" } },
				{
					msgtype: "image",
					image: { url: "https://provider.test/media/image-2", aeskey: "k2" },
				},
			],
		},
	});
	// 没有 aeskey 无法解密，按无效帧丢弃。
	s.push({
		msgid: "keyless-event",
		msgtype: "image",
		image: { url: "https://provider.test/media/image-3" },
	});
	await expect.poll(() => s.messages.length).toBe(3);
	const byEvent = Object.fromEntries(
		s.messages.map((received) => [received.eventId, received]),
	);
	const expiresAt = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/);
	expect(byEvent["media-event"]).toMatchObject({
		text: "",
		media: [
			{
				kind: "file",
				name: null,
				download: {
					url: "https://provider.test/media/file-1",
					aesKey: "fixture-key",
					expiresAt,
				},
			},
		],
	});
	// voice 在长连接里只是转写文本，按普通文本受理。
	expect(byEvent["voice-event"]?.text).toBe("语音转写的问题");
	expect(byEvent["voice-event"]).not.toHaveProperty("media");
	expect(byEvent["mixed-event"]).toMatchObject({
		text: "第一段\n第二段",
		media: [
			{
				kind: "image",
				name: null,
				download: { url: "https://provider.test/media/image-1", aesKey: "k1" },
			},
			{
				kind: "image",
				name: null,
				download: { url: "https://provider.test/media/image-2", aesKey: "k2" },
			},
		],
	});
	expect(byEvent["keyless-event"]).toBeUndefined();
	// 下载地址 5 分钟内有效，不晚于收到后 5 分钟。
	const expiry = Date.parse(
		byEvent["media-event"]?.media?.[0]?.download?.expiresAt ?? "",
	);
	expect(expiry - Date.now()).toBeLessThanOrEqual(300_000);
	expect(expiry - Date.now()).toBeGreaterThan(290_000);
});
it("returns unknown on lost ACK and does not resend after reconnect", async () => {
	const s = await setup();
	await s.authenticate();
	s.push();
	await expect.poll(() => s.messages.length).toBe(1);
	const message = s.messages[0];
	if (!message) throw new Error("Missing admitted message");
	const reply = once(s.socket, "message");
	const result = s.adapter.sender.send({
		scope: message,
		replyHandle: message.replyHandle,
		text: "fixture answer",
	});
	const [raw] = await reply;
	expect(JSON.parse(raw.toString())).toMatchObject({
		cmd: "aibot_respond_msg",
		headers: { req_id: "request-1" },
		body: {
			msgtype: "stream",
			stream: { finish: true, content: "fixture answer" },
		},
	});
	const reconnected = once(s.server, "connection");
	s.socket.terminate();
	expect(await result).toBe("unknown");
	const [nextSocket] = (await reconnected) as [WebSocket];
	const [nextAuth] = await once(nextSocket, "message");
	const received: string[] = [];
	nextSocket.on("message", (data) => received.push(data.toString()));
	nextSocket.send(
		JSON.stringify({
			headers: JSON.parse(nextAuth.toString()).headers,
			errcode: 0,
		}),
	);
	await expect
		.poll(() => s.states.filter((status) => status === "connected").length)
		.toBe(2);
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(received).toEqual([]);
	s.adapter.close();
	expect(
		await s.adapter.sender.send({
			scope: message,
			replyHandle: message.replyHandle,
			text: "fixture answer",
		}),
	).toBe("failed");
});
it("only reports sent after provider ACK and rejects a swapped sender", async () => {
	const s = await setup();
	await s.authenticate();
	s.push();
	await expect.poll(() => s.messages.length).toBe(1);
	const message = s.messages[0];
	if (!message) throw new Error("Missing admitted message");
	expect(
		await s.adapter.sender.send({
			scope: { ...message, senderId: "other-user" },
			replyHandle: message.replyHandle,
			text: "fixture answer",
		}),
	).toBe("failed");
	const reply = once(s.socket, "message");
	const result = s.adapter.sender.send({
		scope: message,
		replyHandle: message.replyHandle,
		text: "fixture answer",
	});
	const [raw] = await reply;
	s.socket.send(
		JSON.stringify({ headers: JSON.parse(raw.toString()).headers, errcode: 0 }),
	);
	expect(await result).toBe("sent");
});
// #2982：长连接 stream 回复带 `<think>` 思考过程；带思考的文本不合规时退回只发答案。
it.each([
	[
		"the thinking block above the answer",
		"<think>先读题</think>\n\nfixture answer",
		"<think>先读题</think>\n\nfixture answer",
	],
	[
		"only the answer when the thinking text exceeds the bound",
		"x".repeat(20_481),
		"fixture answer",
	],
	[
		"only the answer when the thinking text is not well-formed",
		"<think>\ud800</think>\n\nfixture answer",
		"fixture answer",
	],
])("streams %s", async (_name, textWithThinking, content) => {
	const s = await setup();
	await s.authenticate();
	s.push();
	await expect.poll(() => s.messages.length).toBe(1);
	const message = s.messages[0];
	if (!message) throw new Error("Missing admitted message");
	const reply = once(s.socket, "message");
	const result = s.adapter.sender.send({
		scope: message,
		replyHandle: message.replyHandle,
		text: "fixture answer",
		textWithThinking,
	});
	const [raw] = await reply;
	const frame = JSON.parse(raw.toString());
	expect(frame).toMatchObject({
		cmd: "aibot_respond_msg",
		body: { msgtype: "stream", stream: { finish: true, content } },
	});
	s.socket.send(JSON.stringify({ headers: frame.headers, errcode: 0 }));
	expect(await result).toBe("sent");
});
// #3077：受理后立即发 finish=false 的处理中提示，最终回复在同一 stream 上 finish=true 覆盖它。
it("acknowledges on the message stream first and finishes the same stream with the reply", async () => {
	const s = await setup();
	await s.authenticate();
	const before = Date.now();
	s.push();
	await expect.poll(() => s.messages.length).toBe(1);
	const message = s.messages[0];
	if (!message) throw new Error("Missing admitted message");
	// 回复有效期留在官方 stream 的 10 分钟时限之内。
	const lifetime = Date.parse(message.replyExpiresAt) - before;
	expect(lifetime).toBeGreaterThan(530_000);
	expect(lifetime).toBeLessThanOrEqual(540_000 + 1_000);
	const frames: Record<string, unknown>[] = [];
	s.socket.on("message", (data) => {
		const frame = JSON.parse(data.toString());
		frames.push(frame);
		// ACK 延迟一点：最终回复必须等处理中提示的 ACK 之后才发出。
		setTimeout(
			() =>
				s.socket.send(JSON.stringify({ headers: frame.headers, errcode: 0 })),
			frames.length === 1 ? 150 : 0,
		);
	});
	const acknowledged = s.adapter.acknowledge({
		scope: message,
		replyHandle: message.replyHandle,
		text: "已收到，正在处理…",
	});
	const replied = s.adapter.sender.send({
		scope: message,
		replyHandle: message.replyHandle,
		text: "fixture answer",
	});
	expect(await acknowledged).toBe("sent");
	expect(await replied).toBe("sent");
	expect(frames).toHaveLength(2);
	const [first, second] = frames as {
		headers: { req_id: string };
		body: { stream: { id: string; finish: boolean; content: string } };
	}[];
	expect(first).toMatchObject({
		cmd: "aibot_respond_msg",
		headers: { req_id: "request-1" },
		body: {
			msgtype: "stream",
			stream: { finish: false, content: "已收到，正在处理…" },
		},
	});
	expect(second).toMatchObject({
		cmd: "aibot_respond_msg",
		headers: { req_id: "request-1" },
		body: {
			msgtype: "stream",
			stream: { finish: true, content: "fixture answer" },
		},
	});
	expect(second?.body.stream.id).toBe(first?.body.stream.id);
});
it("does not acknowledge a stream whose final reply has started", async () => {
	const s = await setup();
	await s.authenticate();
	s.push();
	await expect.poll(() => s.messages.length).toBe(1);
	const message = s.messages[0];
	if (!message) throw new Error("Missing admitted message");
	const frames: string[] = [];
	s.socket.on("message", (data) => {
		frames.push(data.toString());
		s.socket.send(
			JSON.stringify({
				headers: JSON.parse(data.toString()).headers,
				errcode: 0,
			}),
		);
	});
	expect(
		await s.adapter.sender.send({
			scope: message,
			replyHandle: message.replyHandle,
			text: "fixture answer",
		}),
	).toBe("sent");
	expect(
		await s.adapter.acknowledge({
			scope: message,
			replyHandle: message.replyHandle,
			text: "已收到，正在处理…",
		}),
	).toBe("failed");
	// 其他会话的路由或已关闭的连接同样不发。
	expect(
		await s.adapter.acknowledge({
			scope: { ...message, senderId: "other-user" },
			replyHandle: message.replyHandle,
			text: "已收到，正在处理…",
		}),
	).toBe("failed");
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(frames).toHaveLength(1);
});
it("does not send a bot reply after the final actor authorization is revoked", async () => {
	const s = await setup();
	await s.authenticate();
	s.push();
	await expect.poll(() => s.messages.length).toBe(1);
	const message = s.messages[0];
	if (!message) throw new Error("Missing admitted message");
	const sent: string[] = [];
	s.socket.on("message", (data) => sent.push(data.toString()));
	let checks = 0;
	expect(
		await s.adapter.sender.send({
			scope: message,
			replyHandle: message.replyHandle,
			text: "fixture answer",
			revalidate: async () => {
				checks++;
				return false;
			},
		}),
	).toBe("failed");
	expect(checks).toBe(1);
	expect(sent).toEqual([]);
});
it("rejects stale timestamps and stops ingress and replies after losing ownership", async () => {
	const s = await setup();
	await s.authenticate();
	s.push({ create_time: 1 });
	s.push({ text: { content: "x".repeat(32769) } });
	s.push();
	await expect.poll(() => s.messages.length).toBe(1);
	const message = s.messages[0];
	if (!message) throw new Error("Missing admitted message");
	s.revoke();
	expect(
		await s.adapter.sender.send({
			scope: message,
			replyHandle: message.replyHandle,
			text: "fixture",
		}),
	).toBe("failed");
	expect(s.messages).toHaveLength(1);
	expect(s.states.at(-1)).toBe("disconnected");
});
it("rejects invalid credentials without exposing the provider error", async () => {
	const s = await setup();
	s.socket.send(
		JSON.stringify({
			headers: { req_id: "aibot_subscribe_rejected" },
			errcode: 40014,
			errmsg: "fixture provider secret",
		}),
	);
	await expect.poll(() => s.states).toContain("auth_failed");
	expect(s.messages).toHaveLength(0);
	expect(JSON.stringify(s.states)).not.toContain("fixture provider secret");
});

it("does not send authentication when ownership expires during the handshake", async () => {
	let finish: ((accepted: boolean) => void) | undefined;
	const server = new WebSocketServer({
		host: "127.0.0.1",
		port: 0,
		verifyClient(_info, done) {
			finish = done;
		},
	});
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No address");
	let locallyCurrent = true;
	const frames: unknown[] = [];
	server.on("connection", (socket) =>
		socket.on("message", (data) => frames.push(data)),
	);
	const adapter = createWecomWebSocketV1({
		configuration: {
			agentId: "agent",
			bindingReference: "binding",
			credentialVersion: "v1",
			botId: "bot",
			secret: "fixture",
		},
		endpoint: `ws://127.0.0.1:${address.port}`,
		isCurrent: async () => true,
		isLocallyCurrent: () => locallyCurrent,
		receive: async () => {},
		protectReply: async () => "fixture",
		revealReply: async () => {
			throw new Error("unused");
		},
		observe() {},
	});
	cleanups.push(async () => {
		adapter.close();
		for (const socket of server.clients) socket.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	await adapter.connect();
	await expect.poll(() => typeof finish).toBe("function");
	locallyCurrent = false;
	if (!finish) throw new Error("Missing handshake");
	finish(true);
	await expect.poll(() => adapter.terminalReason).not.toBeNull();
	expect(frames).toEqual([]);
});

it.each([
	{ ack: { errcode: 40014 }, outcome: "failed" },
	{ ack: {}, outcome: "unknown" },
])(
	"classifies provider acknowledgement $outcome through the official SDK",
	async ({ ack, outcome }) => {
		const s = await setup();
		await s.authenticate();
		s.push();
		await expect.poll(() => s.messages.length).toBe(1);
		const message = s.messages[0];
		if (!message) throw new Error("Missing message");
		const reply = once(s.socket, "message");
		const result = s.adapter.sender.send({
			scope: message,
			replyHandle: message.replyHandle,
			text: "fixture answer",
		});
		const [raw] = await reply;
		s.socket.send(
			JSON.stringify({ headers: JSON.parse(raw.toString()).headers, ...ack }),
		);
		expect(await result).toBe(outcome);
	},
);

it("allows eight distinct requests to await ACK on the same connection", async () => {
	const fixture = await setup();
	await fixture.authenticate();
	for (let i = 0; i < 8; i++)
		fixture.socket.send(
			JSON.stringify({
				cmd: "aibot_msg_callback",
				headers: { req_id: `request-${i}` },
				body: {
					aibotid: "bot-1",
					msgid: `event-${i}`,
					chattype: "group",
					chatid: "group-1",
					from: { userid: "sender-1" },
					msgtype: "text",
					text: { content: "fixture" },
				},
			}),
		);
	await expect.poll(() => fixture.messages.length).toBe(8);
	const replies: { headers: { req_id: string } }[] = [];
	fixture.socket.on("message", (raw) => {
		const frame = JSON.parse(raw.toString());
		if (frame.cmd === "aibot_respond_msg") replies.push(frame);
	});
	const sent = fixture.messages.map((message) =>
		fixture.adapter.sender.send({
			scope: message,
			replyHandle: message.replyHandle,
			text: "fixture reply",
		}),
	);
	// All frames must arrive before any ACK: the SDK queue limit is per request ID.
	await expect.poll(() => replies.length).toBe(8);
	for (const frame of replies)
		fixture.socket.send(JSON.stringify({ headers: frame.headers, errcode: 0 }));
	expect(await Promise.all(sent)).toEqual(Array(8).fill("sent"));
});

// #3229：长连接出站媒体：分片上传临时素材后在同一 req_id 上被动回复（工程 Spec §14.2.3）。
type ProviderFrame = {
	cmd: string;
	headers: { req_id: string };
	body: Record<string, unknown> & {
		upload_id?: string;
		chunk_index?: number;
		base64_data?: string;
	};
};
/** 企微服务端替身：按帧类型回 ACK；`respond` 返回 null 表示不回 ACK。 */
function provider(
	socket: WebSocket,
	respond: (frame: ProviderFrame) => Record<string, unknown> | null = () => ({
		errcode: 0,
	}),
) {
	const frames: ProviderFrame[] = [];
	socket.on("message", (data) => {
		const frame = JSON.parse(data.toString()) as ProviderFrame;
		frames.push(frame);
		const defaults: Record<string, Record<string, unknown>> = {
			aibot_upload_media_init: { errcode: 0, body: { upload_id: "upload-1" } },
			aibot_upload_media_finish: {
				errcode: 0,
				body: { media_id: "SENTINEL-MEDIA-ID", type: "file" },
			},
		};
		const ack = respond(frame);
		if (ack)
			socket.send(
				JSON.stringify({
					headers: frame.headers,
					...(defaults[frame.cmd] ?? {}),
					...ack,
				}),
			);
	});
	return frames;
}
async function admitted() {
	const s = await setup();
	await s.authenticate();
	s.push();
	await expect.poll(() => s.messages.length).toBe(1);
	const message = s.messages[0];
	if (!message) throw new Error("Missing admitted message");
	return { ...s, message };
}
const fileBytes = (size: number, seed = 7) =>
	Uint8Array.from({ length: size }, (_, index) => (index * seed) % 251);
function mediaInput(
	message: WecomMessageV1,
	file: { kind: "image" | "video" | "file"; name: string; bytes: Uint8Array },
	overrides: Partial<WecomWebSocketMediaInputV1> = {},
): WecomWebSocketMediaInputV1 {
	return {
		scope: message,
		replyHandle: message.replyHandle,
		file: {
			fileId: `file-${file.name}`,
			name: file.name,
			mediaType: "application/octet-stream",
			sizeBytes: file.bytes.byteLength,
			workspaceReference: `out/${file.name}`,
			kind: file.kind,
		},
		source: {
			actorId: "actor",
			conversationId: "conversation",
			executionId: "execution",
		},
		revalidate: async () => true,
		read: async () => file.bytes,
		...overrides,
	};
}

it("AC-1: uploads in 512KB chunks and replies image, file and video after the text stream", async () => {
	const s = await admitted();
	const frames = provider(s.socket);
	const png = fileBytes(600 * 1024);
	const pdf = fileBytes(64, 3);
	const mp4 = fileBytes(2048, 5);
	expect(
		await s.adapter.sender.send({
			scope: s.message,
			replyHandle: s.message.replyHandle,
			text: "chart.png（见下方文件）",
		}),
	).toBe("sent");
	for (const [kind, name, bytes] of [
		["image", "chart.png", png],
		["file", "report.pdf", pdf],
		["video", "demo.mp4", mp4],
	] as const)
		expect(
			await s.adapter.sender.sendMedia(
				mediaInput(s.message, { kind, name, bytes }),
			),
		).toBe("sent");
	expect(frames.map((frame) => frame.cmd)).toEqual([
		"aibot_respond_msg",
		"aibot_upload_media_init",
		"aibot_upload_media_chunk",
		"aibot_upload_media_chunk",
		"aibot_upload_media_finish",
		"aibot_respond_msg",
		"aibot_upload_media_init",
		"aibot_upload_media_chunk",
		"aibot_upload_media_finish",
		"aibot_respond_msg",
		"aibot_upload_media_init",
		"aibot_upload_media_chunk",
		"aibot_upload_media_finish",
		"aibot_respond_msg",
	]);
	expect(frames[0]?.body).toMatchObject({
		msgtype: "stream",
		stream: { finish: true },
	});
	expect(frames[1]?.body).toEqual({
		type: "image",
		filename: "chart.png",
		total_size: png.byteLength,
		total_chunks: 2,
		md5: createHash("md5").update(png).digest("hex"),
	});
	const chunks = frames
		.slice(2, 4)
		.sort(
			(left, right) =>
				(left.body.chunk_index ?? 0) - (right.body.chunk_index ?? 0),
		);
	expect(chunks.map((frame) => frame.body.chunk_index)).toEqual([0, 1]);
	expect(
		Buffer.concat(
			chunks.map((frame) =>
				Buffer.from(frame.body.base64_data ?? "", "base64"),
			),
		).equals(Buffer.from(png)),
	).toBe(true);
	expect(Buffer.from(chunks[0]?.body.base64_data ?? "", "base64")).toHaveLength(
		512 * 1024,
	);
	const replies = frames.filter(
		(frame) =>
			frame.cmd === "aibot_respond_msg" && frame.body.msgtype !== "stream",
	);
	expect(replies).toEqual([
		{
			cmd: "aibot_respond_msg",
			headers: { req_id: "request-1" },
			body: { msgtype: "image", image: { media_id: "SENTINEL-MEDIA-ID" } },
		},
		{
			cmd: "aibot_respond_msg",
			headers: { req_id: "request-1" },
			body: { msgtype: "file", file: { media_id: "SENTINEL-MEDIA-ID" } },
		},
		{
			cmd: "aibot_respond_msg",
			headers: { req_id: "request-1" },
			body: { msgtype: "video", video: { media_id: "SENTINEL-MEDIA-ID" } },
		},
	]);
});

it.each([
	[
		"the upload init is rejected",
		"aibot_upload_media_init",
		{ errcode: 40008 },
	],
	["a chunk is rejected", "aibot_upload_media_chunk", { errcode: 45009 }],
	["the upload returns no media_id", "aibot_upload_media_finish", { body: {} }],
])("AC-3: fails without replying when %s", async (_name, cmd, ack) => {
	const s = await admitted();
	const frames = provider(s.socket, (frame) =>
		frame.cmd === cmd ? ack : { errcode: 0 },
	);
	expect(
		await s.adapter.sender.sendMedia(
			mediaInput(s.message, {
				kind: "file",
				name: "report.pdf",
				bytes: fileBytes(64),
			}),
		),
	).toBe("failed");
	expect(frames.some((frame) => frame.cmd === "aibot_respond_msg")).toBe(false);
});

it("AC-3: classifies a rejected media reply as failed", async () => {
	const s = await admitted();
	provider(s.socket, (frame) =>
		frame.cmd === "aibot_respond_msg" ? { errcode: 40008 } : { errcode: 0 },
	);
	expect(
		await s.adapter.sender.sendMedia(
			mediaInput(s.message, {
				kind: "image",
				name: "chart.png",
				bytes: fileBytes(64),
			}),
		),
	).toBe("failed");
});

it("AC-3: keeps a media reply whose ACK is lost unknown and does not resend it after reconnect", async () => {
	const s = await admitted();
	const frames = provider(s.socket, (frame) =>
		frame.cmd === "aibot_respond_msg" ? null : { errcode: 0 },
	);
	const reconnected = once(s.server, "connection");
	const result = s.adapter.sender.sendMedia(
		mediaInput(s.message, {
			kind: "file",
			name: "report.pdf",
			bytes: fileBytes(64),
		}),
	);
	await expect
		.poll(() => frames.filter((frame) => frame.cmd === "aibot_respond_msg"))
		.toHaveLength(1);
	s.socket.terminate();
	expect(await result).toBe("unknown");
	const [next] = (await reconnected) as [WebSocket];
	const [auth] = await once(next, "message");
	const after: string[] = [];
	next.on("message", (data) => after.push(data.toString()));
	next.send(
		JSON.stringify({
			headers: JSON.parse(auth.toString()).headers,
			errcode: 0,
		}),
	);
	await expect
		.poll(() => s.states.filter((status) => status === "connected").length)
		.toBe(2);
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(after).toEqual([]);
	// 旧连接上的回复路由不再可用，同一媒体不会在新连接上发出。
	expect(
		await s.adapter.sender.sendMedia(
			mediaInput(s.message, {
				kind: "file",
				name: "report.pdf",
				bytes: fileBytes(64),
			}),
		),
	).toBe("failed");
	expect(after).toEqual([]);
});

it("AC-5: does not read or upload after authorization is revoked, and never exposes media_id", async () => {
	const s = await admitted();
	const frames = provider(s.socket);
	const logs = [
		vi.spyOn(console, "log"),
		vi.spyOn(console, "info"),
		vi.spyOn(console, "warn"),
		vi.spyOn(console, "error"),
		vi.spyOn(console, "debug"),
	];
	let reads = 0;
	expect(
		await s.adapter.sender.sendMedia(
			mediaInput(
				s.message,
				{ kind: "file", name: "report.pdf", bytes: fileBytes(64) },
				{
					revalidate: async () => false,
					read: async () => {
						reads++;
						return fileBytes(64);
					},
				},
			),
		),
	).toBe("failed");
	expect(reads).toBe(0);
	expect(frames).toEqual([]);
	// 上传完成后、被动回复前撤权：已上传的临时素材不被使用。
	let checks = 0;
	const result = await s.adapter.sender.sendMedia(
		mediaInput(
			s.message,
			{ kind: "file", name: "report.pdf", bytes: fileBytes(64) },
			{ revalidate: async () => ++checks === 1 },
		),
	);
	expect(result).toBe("failed");
	expect(frames.map((frame) => frame.cmd)).toEqual([
		"aibot_upload_media_init",
		"aibot_upload_media_chunk",
		"aibot_upload_media_finish",
	]);
	// 读取的字节与声明的大小不一致时不上传。
	expect(
		await s.adapter.sender.sendMedia(
			mediaInput(
				s.message,
				{ kind: "file", name: "report.pdf", bytes: fileBytes(64) },
				{ read: async () => fileBytes(63) },
			),
		),
	).toBe("failed");
	expect(frames).toHaveLength(3);
	const printed = JSON.stringify(logs.map((spy) => spy.mock.calls));
	expect(printed).not.toContain("SENTINEL-MEDIA-ID");
	expect(JSON.stringify(result)).not.toContain("SENTINEL-MEDIA-ID");
	for (const spy of logs) spy.mockRestore();
});

it("AC-2: plans media within the per-conversation and per-bot WeCom rate limits", async () => {
	const s = await admitted();
	provider(s.socket);
	const file = mediaInput(s.message, {
		kind: "file",
		name: "a.pdf",
		bytes: fileBytes(64),
	}).file;
	const first = await s.adapter.sender.planMedia({
		scope: s.message,
		replyHandle: s.message.replyHandle,
		files: Array(40).fill(file),
	});
	// 文本占会话的一条：每会话 30 条/分钟，剩下 29 个媒体。
	expect(first?.filter((plan) => plan === "send")).toHaveLength(29);
	expect(first?.slice(29)).toEqual(Array(11).fill("rate_limited"));
	// 同一会话的另一条消息：会话额度已用完。
	s.socket.send(
		JSON.stringify({
			cmd: "aibot_msg_callback",
			headers: { req_id: "request-same" },
			body: {
				aibotid: "bot-1",
				msgid: "event-same",
				chattype: "group",
				chatid: "group-1",
				from: { userid: "sender-2" },
				msgtype: "text",
				text: { content: "fixture question" },
			},
		}),
	);
	await expect
		.poll(() => s.messages.some((entry) => entry.eventId === "event-same"))
		.toBe(true);
	const same = s.messages.find((entry) => entry.eventId === "event-same");
	if (!same) throw new Error("Missing same-conversation message");
	expect(
		await s.adapter.sender.planMedia({
			scope: same,
			replyHandle: same.replyHandle,
			files: [file],
		}),
	).toEqual(["rate_limited"]);
	// 另一个会话：每个机器人上传 30 次/分钟，只剩 1 次。
	s.socket.send(
		JSON.stringify({
			cmd: "aibot_msg_callback",
			headers: { req_id: "request-other" },
			body: {
				aibotid: "bot-1",
				msgid: "event-other",
				chattype: "group",
				chatid: "group-2",
				from: { userid: "sender-1" },
				msgtype: "text",
				text: { content: "fixture question" },
			},
		}),
	);
	await expect
		.poll(() => s.messages.some((entry) => entry.eventId === "event-other"))
		.toBe(true);
	const other = s.messages.find((entry) => entry.eventId === "event-other");
	if (!other) throw new Error("Missing second message");
	expect(
		await s.adapter.sender.planMedia({
			scope: other,
			replyHandle: other.replyHandle,
			files: [file, file],
		}),
	).toEqual(["send", "rate_limited"]);
	// 不属于本连接或其他会话的路由不支持媒体。
	expect(
		await s.adapter.sender.planMedia({
			scope: { ...s.message, senderId: "other-user" },
			replyHandle: s.message.replyHandle,
			files: [file],
		}),
	).toBeNull();
});

it("returns the planned media quota when the text is not accepted or the reply is planned again", async () => {
	const s = await admitted();
	provider(s.socket, (frame) =>
		frame.cmd === "aibot_respond_msg" ? { errcode: 40008 } : { errcode: 0 },
	);
	const file = mediaInput(s.message, {
		kind: "file",
		name: "a.pdf",
		bytes: fileBytes(64),
	}).file;
	const plan = () =>
		s.adapter.sender.planMedia({
			scope: s.message,
			replyHandle: s.message.replyHandle,
			files: Array(29).fill(file),
		});
	expect((await plan())?.every((entry) => entry === "send")).toBe(true);
	// 同一回复重新规划：先归还上一次的占用，不会被自己的占用挤掉。
	expect((await plan())?.every((entry) => entry === "send")).toBe(true);
	// 文本被企微拒绝：媒体不会发送，额度归还（文本本身仍计一条）。
	expect(
		await s.adapter.sender.send({
			scope: s.message,
			replyHandle: s.message.replyHandle,
			text: "fixture answer",
		}),
	).toBe("failed");
	const again = await plan();
	expect(again?.filter((entry) => entry === "send")).toHaveLength(28);
});

it("uploads a result file whose name is long in UTF-8 but within 255 characters", async () => {
	const s = await admitted();
	const frames = provider(s.socket);
	const name = `${"季度经营分析报告".repeat(12)}.pdf`;
	expect(name.length).toBeLessThanOrEqual(255);
	expect(Buffer.byteLength(name)).toBeGreaterThan(255);
	expect(
		await s.adapter.sender.sendMedia(
			mediaInput(s.message, { kind: "file", name, bytes: fileBytes(64) }),
		),
	).toBe("sent");
	expect(frames[0]?.body).toMatchObject({ filename: name });
});
