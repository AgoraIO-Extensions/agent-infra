import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
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
function sender(
	fetcher: typeof fetch,
	now?: () => Date,
	configuration?: Parameters<
		typeof createWecomSenderV1
	>[0]["resolveConfiguration"],
	accessToken?: Parameters<
		typeof createWecomSenderV1
	>[0]["getApplicationAccessToken"],
	sendMedia?: Parameters<typeof createWecomSenderV1>[0]["sendMedia"],
) {
	const adapter = createWecomSenderV1({
		resolveConfiguration:
			configuration ??
			(async (s) => ({
				bindingReference: s.bindingReference,
				agentId: s.agentId,
				kind: s.kind,
				credentialVersion: "v1",
				token: "fixture",
				encodingAesKey: "fixture",
				botId: "bot-1",
				applicationId: "42",
			})),
		revealReply: reveal,
		getApplicationAccessToken: accessToken ?? (async () => "fixture-token"),
		fetch: fetcher,
		...(sendMedia ? { sendMedia } : {}),
		...(now ? { now } : {}),
	});
	return {
		send(input: Parameters<typeof adapter.send>[0]) {
			return adapter.send({
				...input,
				revalidate: input.revalidate ?? (async () => true),
			});
		},
	};
}
const applicationScope = {
	...scope,
	kind: "wecom_app" as const,
	peerId: "sender-1",
	conversationType: "single" as const,
};
const applicationRoute: WecomReplyRouteV1 = {
	...route,
	scope: applicationScope,
	responseUrl: undefined,
	recipientId: applicationScope.senderId,
};
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
	it.each([
		"?response_code=fixture&trace=untrusted",
		"?response_code=fixture&response_code=other",
	])(
		"rejects a bot reply URL with an extra query parameter: %s",
		async (query) => {
			let calls = 0;
			const adapter = sender(async () => {
				calls++;
				return Response.json({ errcode: 0 });
			});
			expect(
				await adapter.send({
					scope,
					replyHandle: await protect({
						...route,
						responseUrl: `https://qyapi.weixin.qq.com/cgi-bin/aibot/response${query}`,
					}),
					text: "reply",
				}),
			).toBe("failed");
			expect(calls).toBe(0);
		},
	);
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
	it("delegates File Authority result media after the text reply", async () => {
		const sendMedia = vi.fn(async () => "sent" as const);
		const adapter = sender(
			async () => Response.json({ errcode: 0 }),
			undefined,
			undefined,
			undefined,
			sendMedia,
		);
		const result = await adapter.send({
			scope,
			replyHandle: await protect(route),
			text: "reply",
			media: [
				{
					fileId: "file-1",
					name: "report.pdf",
					mediaType: "application/pdf",
					sizeBytes: 42,
				},
			],
		});
		expect(result).toBe("sent");
		expect(sendMedia).toHaveBeenCalledWith(
			expect.objectContaining({
				files: expect.arrayContaining([
					expect.objectContaining({ fileId: "file-1" }),
				]),
			}),
		);
	});
	it("rejects unsupported result media before sending text", async () => {
		let calls = 0;
		const adapter = sender(async () => {
			calls++;
			return Response.json({ errcode: 0 });
		});
		expect(
			await adapter.send({
				scope,
				replyHandle: await protect(route),
				text: "reply",
				media: [
					{
						fileId: "file-1",
						name: "report.pdf",
						mediaType: "application/pdf",
						sizeBytes: 42,
					},
				],
			}),
		).toBe("failed");
		expect(calls).toBe(0);
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
	it("sends a long application reply in ordered UTF-8-bounded parts", async () => {
		const content: string[] = [];
		const adapter = sender(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			expect(body.touser).toBe(applicationScope.senderId);
			expect(body.agentid).toBe(42);
			content.push(body.text.content);
			return Response.json({ errcode: 0 });
		});
		const text = `${"a".repeat(2047)}😀${"界".repeat(682)}`;
		expect(
			await adapter.send({
				scope: applicationScope,
				replyHandle: await protect(applicationRoute),
				text,
			}),
		).toBe("sent");
		expect(content.length).toBe(3);
		expect(content.join("")).toBe(text);
		expect(content.every((part) => Buffer.byteLength(part) <= 2048)).toBe(true);
	});
	it("keeps a 2048-byte application reply in one part", async () => {
		let calls = 0;
		const adapter = sender(async (_url, init) => {
			calls++;
			expect(JSON.parse(String(init?.body)).text.content).toBe(
				"x".repeat(2048),
			);
			return Response.json({ errcode: 0 });
		});
		expect(
			await adapter.send({
				scope: applicationScope,
				replyHandle: await protect(applicationRoute),
				text: "x".repeat(2048),
			}),
		).toBe("sent");
		expect(calls).toBe(1);
	});
	it("keeps every part within the provider limit at the Core byte ceiling", async () => {
		const parts: string[] = [];
		const adapter = sender(async (_url, init) => {
			parts.push(JSON.parse(String(init?.body)).text.content);
			return Response.json({ errcode: 0 });
		});
		const text = "界".repeat(6826);
		expect(Buffer.byteLength(text)).toBe(20_478);
		expect(
			await adapter.send({
				scope: applicationScope,
				replyHandle: await protect(applicationRoute),
				text,
			}),
		).toBe("sent");
		expect(parts).toHaveLength(11);
		expect(parts.join("")).toBe(text);
		expect(parts.every((part) => Buffer.byteLength(part) <= 2048)).toBe(true);
	});
	it.each([
		["first", 1, "failed"],
		["later", 2, "unknown"],
	] as const)(
		"stops after an explicit failure on the %s application part",
		async (_position, failureAt, expected) => {
			let calls = 0;
			const adapter = sender(async () => {
				calls++;
				return Response.json({ errcode: calls === failureAt ? 40014 : 0 });
			});
			expect(
				await adapter.send({
					scope: applicationScope,
					replyHandle: await protect(applicationRoute),
					text: "x".repeat(4097),
				}),
			).toBe(expected);
			expect(calls).toBe(failureAt);
		},
	);
	it("does not send another application part after a lost response", async () => {
		let calls = 0;
		const adapter = sender(async () => {
			calls++;
			if (calls === 2) throw new Error("response lost");
			return Response.json({ errcode: 0 });
		});
		expect(
			await adapter.send({
				scope: applicationScope,
				replyHandle: await protect(applicationRoute),
				text: "x".repeat(4097),
			}),
		).toBe("unknown");
		expect(calls).toBe(2);
	});
	it("stops a multipart application reply when its window expires after the first acknowledgment", async () => {
		let clock = Date.parse("2026-09-15T00:00:00Z");
		let calls = 0;
		const adapter = sender(
			async () => {
				calls++;
				clock += 1_000;
				return Response.json({ errcode: 0 });
			},
			() => new Date(clock),
		);
		expect(
			await adapter.send({
				scope: applicationScope,
				replyHandle: await protect({
					...applicationRoute,
					expiresAt: new Date(clock + 1_000).toISOString(),
				}),
				text: "x".repeat(4097),
			}),
		).toBe("unknown");
		expect(calls).toBe(1);
	});
	it("does not send an application reply that expires during access-token lookup", async () => {
		let clock = Date.parse("2026-09-15T00:00:00Z");
		let calls = 0;
		const adapter = sender(
			async () => {
				calls++;
				return Response.json({ errcode: 0 });
			},
			() => new Date(clock),
			undefined,
			async () => {
				clock += 1_000;
				return "fixture-token";
			},
		);
		expect(
			await adapter.send({
				scope: applicationScope,
				replyHandle: await protect({
					...applicationRoute,
					expiresAt: new Date(clock + 1_000).toISOString(),
				}),
				text: "fixture answer",
			}),
		).toBe("failed");
		expect(calls).toBe(0);
	});
	it("stops later application parts if token lookup consumes the reply window", async () => {
		let clock = Date.parse("2026-09-15T00:00:00Z");
		let calls = 0;
		let tokenCalls = 0;
		const adapter = sender(
			async () => {
				calls++;
				return Response.json({ errcode: 0 });
			},
			() => new Date(clock),
			undefined,
			async () => {
				tokenCalls++;
				if (tokenCalls === 2) clock += 1_000;
				return "fixture-token";
			},
		);
		expect(
			await adapter.send({
				scope: applicationScope,
				replyHandle: await protect({
					...applicationRoute,
					expiresAt: new Date(clock + 1_000).toISOString(),
				}),
				text: "x".repeat(4097),
			}),
		).toBe("unknown");
		expect(calls).toBe(1);
		expect(tokenCalls).toBe(2);
	});
	it("stops after the first application acknowledgment when Owner unbinds", async () => {
		let bound = true;
		let calls = 0;
		const adapter = sender(
			async () => {
				calls++;
				bound = false;
				return Response.json({ errcode: 0 });
			},
			undefined,
			async (s) =>
				bound
					? {
							bindingReference: s.bindingReference,
							agentId: s.agentId,
							kind: s.kind,
							credentialVersion: "v1",
							token: "fixture",
							encodingAesKey: "fixture",
							applicationId: "42",
						}
					: null,
		);
		expect(
			await adapter.send({
				scope: applicationScope,
				replyHandle: await protect(applicationRoute),
				text: "x".repeat(4097),
			}),
		).toBe("unknown");
		expect(calls).toBe(1);
	});
	it("stops after the first application acknowledgment when authorization is revoked", async () => {
		let allowed = true;
		let calls = 0;
		let tokenCalls = 0;
		const adapter = sender(
			async () => {
				calls++;
				allowed = false;
				return Response.json({ errcode: 0 });
			},
			undefined,
			undefined,
			async () => {
				tokenCalls++;
				return "fixture-token";
			},
		);
		expect(
			await adapter.send({
				scope: applicationScope,
				replyHandle: await protect(applicationRoute),
				text: "x".repeat(4097),
				revalidate: async () => allowed,
			}),
		).toBe("unknown");
		expect(calls).toBe(1);
		expect(tokenCalls).toBe(1);
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
