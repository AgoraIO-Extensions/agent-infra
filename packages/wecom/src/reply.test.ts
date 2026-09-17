import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createWecomReplyDecryptorV1,
	createWecomReplyEncryptorV1,
	createWecomSenderV1,
	type WecomReplyRouteV1,
} from "./reply.ts";

const pair = generateKeyPairSync("rsa", {
	modulusLength: 3072,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const scope = {
	agentId: "agent-1",
	bindingReference: "binding-1",
	kind: "wecom_bot" as const,
	senderId: "sender-1",
	peerId: "group-1",
	conversationType: "group" as const,
	threadId: null,
};
const route: WecomReplyRouteV1 = {
	scope,
	bindingReference: scope.bindingReference,
	credentialVersion: "v1",
	expiresAt: "2099-01-01T00:00:00Z",
	responseUrl:
		"https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=fixture",
};
const protect = createWecomReplyEncryptorV1(pair.publicKey);
const reveal = createWecomReplyDecryptorV1(pair.privateKey);
function sender(fetcher: typeof fetch) {
	return createWecomSenderV1({
		resolveConfiguration: async (s) => ({
			bindingReference: s.bindingReference,
			agentId: s.agentId,
			kind: s.kind,
			credentialVersion: "v1",
			token: "fixture",
			encodingAesKey: "fixture",
			botId: "bot-1",
		}),
		revealReply: reveal,
		getApplicationAccessToken: async () => "fixture-token",
		fetch: fetcher,
	});
}
describe("reply protection and external send", () => {
	it("encrypts a fresh envelope and authenticates persisted reply data", async () => {
		const one = await protect(route);
		const two = await protect(route);
		expect(one).not.toBe(two);
		expect(one).not.toContain("response_code");
		expect(await reveal(one)).toEqual(route);
		const tampered = JSON.parse(one);
		tampered.tag = Buffer.alloc(16).toString("base64");
		await expect(reveal(JSON.stringify(tampered))).rejects.toThrow(
			"WeCom reply route is unavailable",
		);
	});
	it("never transmits a swapped sender or group route", async () => {
		let calls = 0;
		const adapter = sender(async () => {
			calls++;
			return Response.json({ errcode: 0 });
		});
		const handle = await protect(route);
		expect(
			await adapter.send({
				scope: { ...scope, senderId: "other" },
				replyHandle: handle,
				text: "private fixture",
			}),
		).toBe("failed");
		expect(
			await adapter.send({
				scope: { ...scope, peerId: "other" },
				replyHandle: handle,
				text: "private fixture",
			}),
		).toBe("failed");
		expect(calls).toBe(0);
	});
	it("sends once and leaves a lost response uncertain", async () => {
		let calls = 0;
		const adapter = sender(async () => {
			calls++;
			throw new Error("response lost");
		});
		expect(
			await adapter.send({
				scope,
				replyHandle: await protect(route),
				text: "reply",
			}),
		).toBe("unknown");
		expect(calls).toBe(1);
	});
	it("requires a successful provider acknowledgment", async () => {
		const handle = await protect(route);
		expect(
			await sender(async () => Response.json({ errcode: 0 })).send({
				scope,
				replyHandle: handle,
				text: "reply",
			}),
		).toBe("sent");
		expect(
			await sender(async () => Response.json({ errcode: 40014 })).send({
				scope,
				replyHandle: handle,
				text: "reply",
			}),
		).toBe("failed");
		expect(
			await sender(
				async () => new Response("bad gateway", { status: 502 }),
			).send({ scope, replyHandle: handle, text: "reply" }),
		).toBe("unknown");
	});
});

it("keeps pending routes readable across a key rotation and fails closed for a retired key", async () => {
	const next = generateKeyPairSync("rsa", {
		modulusLength: 3072,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
	const oldHandle = await protect(route);
	const newHandle = await createWecomReplyEncryptorV1(next.publicKey)(route);
	const keyring = createWecomReplyDecryptorV1([
		pair.privateKey,
		next.privateKey,
	]);
	expect(await keyring(oldHandle)).toEqual(route);
	expect(await keyring(newHandle)).toEqual(route);
	await expect(
		createWecomReplyDecryptorV1(next.privateKey)(oldHandle),
	).rejects.toThrow("WeCom reply route is unavailable");
});

it.each(["short-tag", "short-iv", "short-key", "noncanonical"])(
	"rejects malformed persisted reply envelope: %s",
	async (kind) => {
		const envelope = JSON.parse(await protect(route));
		if (kind === "short-tag")
			envelope.tag = Buffer.from(envelope.tag, "base64")
				.subarray(0, 12)
				.toString("base64");
		if (kind === "short-iv")
			envelope.iv = Buffer.from(envelope.iv, "base64")
				.subarray(0, 8)
				.toString("base64");
		if (kind === "short-key")
			envelope.wrapped = Buffer.from(envelope.wrapped, "base64")
				.subarray(1)
				.toString("base64");
		if (kind === "noncanonical") envelope.ciphertext += "\n";
		await expect(reveal(JSON.stringify(envelope))).rejects.toThrow(
			"WeCom reply route is unavailable",
		);
	},
);
it("rechecks authorization after a slow app token lookup and before sending", async () => {
	const appScope = { ...scope, kind: "wecom_app" as const };
	let current = true;
	let posted = false;
	const token = Promise.withResolvers<string>();
	const requested = Promise.withResolvers<void>();
	const sender = createWecomSenderV1({
		resolveConfiguration: async () => ({
			agentId: scope.agentId,
			bindingReference: scope.bindingReference,
			kind: "wecom_app",
			credentialVersion: "v1",
			corporationId: "corp",
			applicationId: "7",
		}),
		revealReply: async () => ({
			...route,
			scope: appScope,
			recipientId: scope.senderId,
		}),
		getApplicationAccessToken: async () => {
			requested.resolve();
			return token.promise;
		},
		fetch: async () => {
			posted = true;
			return Response.json({ errcode: 0 });
		},
	});
	const sending = sender.send({
		scope: appScope,
		replyHandle: "opaque",
		text: "fixture",
		isCurrent: async () => current,
	});
	await requested.promise;
	current = false;
	token.resolve("fixture-access");
	expect(await sending).toBe("failed");
	expect(posted).toBe(false);
});
it("records authorization dependency failure before POST as failed, not unknown", async () => {
	let posted = false;
	const sender = createWecomSenderV1({
		resolveConfiguration: async () => ({
			agentId: scope.agentId,
			bindingReference: scope.bindingReference,
			kind: "wecom_bot",
			credentialVersion: "v1",
		}),
		revealReply: async () => route,
		getApplicationAccessToken: async () => "unused",
		fetch: async () => {
			posted = true;
			return Response.json({ errcode: 0 });
		},
	});
	expect(
		await sender.send({
			scope,
			replyHandle: "opaque",
			text: "fixture",
			isCurrent: () => {
				throw new Error("dependency unavailable");
			},
		}),
	).toBe("failed");
	expect(posted).toBe(false);
});
