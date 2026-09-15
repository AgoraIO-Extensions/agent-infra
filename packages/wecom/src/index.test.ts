import { createCipheriv, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createWecomAdapterV1 } from "./index.ts";

// Independent implementation of the documented wire envelope, not production helpers.
const key = Buffer.alloc(32, 7);
const now = new Date("2026-09-15T00:00:00Z");
const config = {
	bindingReference: "bot-binding",
	agentId: "agent-1",
	kind: "wecom_bot" as const,
	token: "fixture-token",
	encodingAesKey: key.toString("base64").slice(0, 43),
	botId: "bot-1",
	credentialVersion: "v1",
};
function request(
	payload: unknown,
	receiver = "",
	timestamp = String(now.getTime() / 1000),
) {
	const message = Buffer.from(
		typeof payload === "string" ? payload : JSON.stringify(payload),
	);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(message.length);
	const plain = Buffer.concat([
		Buffer.alloc(16, 3),
		length,
		message,
		Buffer.from(receiver),
	]);
	const pad = 32 - (plain.length % 32);
	const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
	cipher.setAutoPadding(false);
	const encrypt = Buffer.concat([
		cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])),
		cipher.final(),
	]).toString("base64");
	const nonce = "fixture-nonce";
	const signature = createHash("sha1")
		.update([config.token, timestamp, nonce, encrypt].sort().join(""))
		.digest("hex");
	return new Request(
		`https://platform.test/callback?timestamp=${timestamp}&nonce=${nonce}&msg_signature=${signature}`,
		{
			method: "POST",
			body:
				typeof payload === "string"
					? `<xml><Encrypt>${encrypt}</Encrypt></xml>`
					: JSON.stringify({ encrypt }),
		},
	);
}
const message = {
	msgid: "message-1",
	aibotid: "bot-1",
	chattype: "group",
	chatid: "group-1",
	from: { userid: "sender-1" },
	msgtype: "text",
	text: { content: "hello" },
	response_url:
		"https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=fixture",
};
describe("WeCom callback boundary", () => {
	it("verifies and decrypts the official bot envelope before exposing sender and text", async () => {
		const adapter = createWecomAdapterV1({
			now: () => now,
			protectReply: async () => "protected-handle",
		});
		await expect(
			adapter.receive(config, request(message)),
		).resolves.toMatchObject({
			type: "message",
			message: {
				eventId: "message-1",
				senderId: "sender-1",
				peerId: "group-1",
				conversationType: "group",
				text: "hello",
				replyHandle: "protected-handle",
			},
		});
	});
});

it.each([
	["wrong robot", { ...message, aibotid: "bot-other" }],
	[
		"unsafe reply host",
		{ ...message, response_url: "https://evil.test/collect" },
	],
	["missing group identity", { ...message, chatid: undefined }],
])("rejects %s before protecting a reply route", async (_label, payload) => {
	let calls = 0;
	const adapter = createWecomAdapterV1({
		now: () => now,
		protectReply: async () => {
			calls++;
			return "protected";
		},
	});
	await expect(adapter.receive(config, request(payload))).rejects.toThrow(
		"Invalid WeCom callback",
	);
	expect(calls).toBe(0);
});
it("rejects stale and cross-receiver signed envelopes", async () => {
	const adapter = createWecomAdapterV1({
		now: () => now,
		protectReply: async () => "protected",
	});
	await expect(
		adapter.receive(config, request(message, "other-corp")),
	).rejects.toThrow("Invalid WeCom callback");
	await expect(
		adapter.receive(
			config,
			request(message, "", String(now.getTime() / 1000 - 301)),
		),
	).rejects.toThrow("Invalid WeCom callback");
});

it("validates application XML identity and rejects DTD or duplicate fields", async () => {
	const app = {
		...config,
		kind: "wecom_app" as const,
		corporationId: "corp-1",
		applicationId: "42",
	};
	const xml = `<xml><ToUserName>corp-1</ToUserName><FromUserName>member-1</FromUserName><CreateTime>${now.getTime() / 1000}</CreateTime><MsgType>text</MsgType><Content><![CDATA[hello <world>]]></Content><MsgId>1234</MsgId><AgentID>42</AgentID></xml>`;
	const adapter = createWecomAdapterV1({
		now: () => now,
		protectReply: async () => "protected",
	});
	await expect(
		adapter.receive(app, request(xml, "corp-1")),
	).resolves.toMatchObject({
		type: "message",
		message: {
			kind: "wecom_app",
			senderId: "member-1",
			text: "hello <world>",
			conversationType: "single",
		},
	});
	await expect(
		adapter.receive(
			app,
			request(xml.replace("<AgentID>42", "<AgentID>43"), "corp-1"),
		),
	).rejects.toThrow("Invalid WeCom callback");
	await expect(
		adapter.receive(
			app,
			request(xml.replace("</xml>", "<MsgId>another</MsgId></xml>"), "corp-1"),
		),
	).rejects.toThrow("Invalid WeCom callback");
	await expect(
		adapter.receive(
			app,
			request(
				`<!DOCTYPE xml [<!ENTITY leak SYSTEM "file:///etc/passwd">]>${xml}`,
				"corp-1",
			),
		),
	).rejects.toThrow("Invalid WeCom callback");
});
it("rejects a tampered signature and duplicate signature parameters", async () => {
	const adapter = createWecomAdapterV1({
		now: () => now,
		protectReply: async () => "protected",
	});
	const original = request(message);
	const url = new URL(original.url);
	url.searchParams.set("msg_signature", "0".repeat(40));
	await expect(
		adapter.receive(
			config,
			new Request(url, { method: "POST", body: await original.text() }),
		),
	).rejects.toThrow("Invalid WeCom callback");
	const duplicate = request(message);
	await expect(
		adapter.receive(
			config,
			new Request(`${duplicate.url}&nonce=other`, {
				method: "POST",
				body: await duplicate.text(),
			}),
		),
	).rejects.toThrow("Invalid WeCom callback");
});
