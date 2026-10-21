import { once } from "node:events";
import type { WecomMessageV1 } from "@agent-infra/platform-core";
import { afterEach, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { createWecomWebSocketV1 } from "./websocket.js";

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
it("maps authenticated media callbacks to opaque media metadata", async () => {
	const s = await setup();
	await s.authenticate();
	s.push({
		msgid: "media-event",
		msgtype: "file",
		file: { url: "https://provider.test/media/file-1", name: "report.pdf" },
	});
	await expect.poll(() => s.messages.length).toBe(1);
	expect(s.messages[0]).toMatchObject({
		text: "",
		media: [
			{
				kind: "file",
				mediaId: "https://provider.test/media/file-1",
				name: "report.pdf",
				mediaType: "application/octet-stream",
			},
		],
	});
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
