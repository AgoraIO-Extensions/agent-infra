import { describe, expect, it, vi } from "vitest";
import { FakeConversationExecutionV1 } from "./fake-conversation-execution.ts";
import {
	createWecomAuthorizationV1,
	createWecomChannelV1,
	type WecomAuthorizationPortV1,
	type WecomChannelStorePortV1,
	type WecomMediaRejectionV1,
	type WecomMediaResolverV1,
	type WecomMessageV1,
	type WecomReceiptV1,
	wecomChannelIdV1,
	wecomConversationKeyForRotationV1,
} from "./wecom-channel.ts";

const message: WecomMessageV1 = {
	providerId: "provider-1",
	agentId: "agent-1",
	bindingReference: "binding-1",
	kind: "wecom_bot",
	senderId: "sender-1",
	peerId: "group-1",
	conversationType: "group",
	threadId: null,
	eventId: "event-1",
	text: "hello",
	replyHandle: "encrypted",
	replyExpiresAt: "2026-09-15T01:00:00Z",
};
function fixture(
	now = () => new Date("2026-09-15T00:00:00Z"),
	media?: WecomMediaResolverV1,
) {
	let allowed = true;
	let nextId = 0;
	const receipts = new Map<
		string,
		{
			digest: string;
			receipt: WecomReceiptV1;
			mediaRejection?: WecomMediaRejectionV1;
		}
	>();
	const conversations = new Map<string, FakeConversationExecutionV1>();
	// 映射键 → 当前会话轮次；Postgres 在同一受理事务里串行化这一步（#3184）。
	const rotations = new Map<string, number>();
	const plans: Parameters<WecomChannelStorePortV1["accept"]>[0][] = [];
	const conversationFor = (
		plan: Parameters<WecomChannelStorePortV1["accept"]>[0],
	) => {
		const id = JSON.stringify([
			plan.authority.actor.actorId,
			plan.authority.actor.channelId,
		]);
		let conversation = conversations.get(id);
		if (!conversation) {
			conversation = new FakeConversationExecutionV1({
				authority: plan.authority.actor,
				newId: () => `channel_fixture_${++nextId}`,
			});
			conversations.set(id, conversation);
		}
		return conversation;
	};
	const store: WecomChannelStorePortV1 = {
		async reject() {},
		async accept(plan, execute) {
			plans.push(plan);
			const old = receipts.get(plan.eventKey);
			if (old)
				return old.digest === plan.requestDigest
					? { outcome: "replayed", receipt: old.receipt }
					: { outcome: "conflict" };
			const conversation = conversationFor(plan);
			const rotation = rotations.get(plan.conversationKey) ?? 0;
			const { mediaRejection, ...result } = await execute(conversation, {
				conversationKey: wecomConversationKeyForRotationV1(
					plan.conversationKey,
					rotation,
				),
				async startNewConversation() {
					rotations.set(plan.conversationKey, rotation + 1);
				},
			});
			const receipt = { ...result, receiptId: plan.eventKey };
			receipts.set(plan.eventKey, {
				digest: plan.requestDigest,
				receipt,
				...(mediaRejection ? { mediaRejection } : {}),
			});
			return { outcome: "accepted", receipt };
		},
		// #3227：与受理相同的映射与轮次，单独确定会话；已有回执时交给受理重放。
		async prepareConversation(plan, prepare) {
			plans.push(plan);
			if (receipts.has(plan.eventKey)) return { outcome: "received" };
			const rotation = rotations.get(plan.conversationKey) ?? 0;
			const prepared = await prepare(conversationFor(plan), {
				conversationKey: wecomConversationKeyForRotationV1(
					plan.conversationKey,
					rotation,
				),
				async startNewConversation() {
					throw new Error("Mapping rotates only during acceptance");
				},
			});
			return { outcome: "prepared", ...prepared };
		},
	};
	const useCase = createWecomChannelV1({
		now,
		store,
		...(media ? { media } : {}),
		authorization: {
			async authorize(scope) {
				return allowed
					? {
							outcome: "allowed",
							authority: {
								actor: {
									schemaVersion: 1,
									agentId: scope.agentId,
									actorId: scope.senderId,
									channelId: wecomChannelIdV1(scope),
									authorizationRevision: "v1",
									supportsSupplementaryInstruction: false,
									taskBoundary: {
										schemaVersion: 1,
										principal: { kind: "user", id: scope.senderId },
										agentId: scope.agentId,
										channelId: wecomChannelIdV1(scope),
										identityRevision: "identity-1",
										agentAuthorizationRevision: "v1",
										accessSources: [{ kind: "user", userId: scope.senderId }],
									},
								},
								managementRevision: 1,
								channelRevision: "v1",
							},
						}
					: { outcome: "denied" };
			},
		},
	});
	return {
		useCase,
		receipts,
		conversations,
		plans,
		rotations,
		revoke: () => {
			allowed = false;
		},
	};
}
describe("managed WeCom channel", () => {
	it.each([true, false])(
		"cancels preauthorization without late Store facts (already aborted: %s)",
		async (alreadyAborted) => {
			const controller = new AbortController();
			const addListener = vi.spyOn(controller.signal, "addEventListener");
			const removeListener = vi.spyOn(controller.signal, "removeEventListener");
			let finish!: (value: { readonly outcome: "denied" }) => void;
			let started!: () => void;
			const entered = new Promise<void>((resolve) => {
				started = resolve;
			});
			const authorize = vi.fn(
				() =>
					new Promise<{ readonly outcome: "denied" }>((resolve) => {
						finish = resolve;
						started();
					}),
			);
			const reject = vi.fn(async () => {});
			const accept = vi.fn(async () => ({ outcome: "unavailable" as const }));
			const channel = createWecomChannelV1({
				now: () => new Date("2026-09-15T00:00:00Z"),
				authorization: { authorize },
				store: { reject, accept },
			});
			if (alreadyAborted) controller.abort();
			const pending = channel.receive(message, undefined, controller.signal);
			if (!alreadyAborted) {
				await entered;
				controller.abort();
			}
			expect(await pending).toEqual({ outcome: "unavailable" });
			if (!alreadyAborted) {
				expect(addListener).toHaveBeenCalledTimes(1);
				expect(removeListener).toHaveBeenCalledWith(
					"abort",
					addListener.mock.calls[0]?.[1],
				);
				finish({ outcome: "denied" });
				await Promise.resolve();
			}
			expect(authorize).toHaveBeenCalledTimes(alreadyAborted ? 0 : 1);
			expect(reject).not.toHaveBeenCalled();
			expect(accept).not.toHaveBeenCalled();
		},
	);
	it.each(["allowed", "error"] as const)(
		"does not enter Store after cancelled authorization returns late %s",
		async (lateOutcome) => {
			const controller = new AbortController();
			let finish!: (
				value: Awaited<ReturnType<WecomAuthorizationPortV1["authorize"]>>,
			) => void;
			let fail!: (reason: Error) => void;
			let started!: () => void;
			const entered = new Promise<void>((resolve) => {
				started = resolve;
			});
			const authorization: WecomAuthorizationPortV1 = {
				authorize: () =>
					new Promise((resolve, reject) => {
						finish = resolve;
						fail = reject;
						started();
					}),
			};
			const reject = vi.fn(async () => {});
			const accept = vi.fn(async () => ({ outcome: "unavailable" as const }));
			const channel = createWecomChannelV1({
				now: () => new Date("2026-09-15T00:00:00Z"),
				authorization,
				store: { reject, accept },
			});
			const pending = channel.receive(message, undefined, controller.signal);
			await entered;
			controller.abort();
			expect(await pending).toEqual({ outcome: "unavailable" });
			if (lateOutcome === "error") fail(new Error("Late directory failure"));
			else
				finish({
					outcome: "allowed",
					authority: {
						actor: {
							schemaVersion: 1,
							agentId: message.agentId,
							actorId: message.senderId,
							channelId: wecomChannelIdV1(message),
							authorizationRevision: "v1",
							supportsSupplementaryInstruction: false,
							taskBoundary: {
								schemaVersion: 1,
								principal: { kind: "user", id: message.senderId },
								agentId: message.agentId,
								channelId: wecomChannelIdV1(message),
								identityRevision: "identity-1",
								agentAuthorizationRevision: "v1",
								accessSources: [{ kind: "user", userId: message.senderId }],
							},
						},
						managementRevision: 1,
						channelRevision: "v1",
					},
				});
			await Promise.resolve();
			await Promise.resolve();
			expect(reject).not.toHaveBeenCalled();
			expect(accept).not.toHaveBeenCalled();
		},
	);
	it("rejects an expired reply before creating a receipt or execution", async () => {
		const f = fixture();
		await expect(
			f.useCase.receive({ ...message, replyExpiresAt: "2026-09-15T00:00:00Z" }),
		).rejects.toThrow("Invalid WeCom message");
		expect(f.receipts.size).toBe(0);
		expect(f.conversations.size).toBe(0);
	});
	it("rechecks expiry after authorization before creating a conversation", async () => {
		let reads = 0;
		const f = fixture(
			() =>
				new Date(
					reads++ === 0 ? "2026-09-15T00:00:00Z" : message.replyExpiresAt,
				),
		);
		await expect(f.useCase.receive(message)).rejects.toThrow(
			"Invalid WeCom message",
		);
		expect(f.receipts.size).toBe(0);
		expect(
			[...f.conversations.values()][0]?.snapshot().executions,
		).toHaveLength(0);
	});
	it("replays the saved receipt without another execution and rejects changed content", async () => {
		const f = fixture();
		const first = await f.useCase.receive(message);
		expect(first.outcome).toBe("accepted");
		expect(
			await f.useCase.receive({
				...message,
				replyHandle: "refreshed encrypted handle",
			}),
		).toEqual({ ...first, outcome: "replayed" });
		expect(await f.useCase.receive({ ...message, text: "changed" })).toEqual({
			outcome: "conflict",
		});
		expect(
			[...f.conversations.values()][0]?.snapshot().executions,
		).toHaveLength(1);
	});
	it("isolates two senders in one group and preserves the original sender conversation", async () => {
		const f = fixture();
		const one = await f.useCase.receive(message);
		const two = await f.useCase.receive({
			...message,
			senderId: "sender-2",
			eventId: "event-2",
		});
		expect(one.outcome).toBe("accepted");
		expect(two.outcome).toBe("accepted");
		if (one.outcome !== "accepted" || two.outcome !== "accepted")
			throw new Error("Expected acceptance");
		expect(one.receipt.conversationId).not.toBe(two.receipt.conversationId);
		const busy = await f.useCase.receive({ ...message, eventId: "event-3" });
		expect(busy).toMatchObject({
			outcome: "accepted",
			receipt: {
				status: "busy",
				conversationId: one.receipt.conversationId,
				executionId: null,
			},
		});
	});
	it("rechecks authority even for duplicate callbacks and produces no work when revoked", async () => {
		const f = fixture();
		f.revoke();
		expect(await f.useCase.receive(message)).toEqual({ outcome: "denied" });
		expect(f.receipts.size).toBe(0);
		expect(f.conversations.size).toBe(0);
	});
});

describe("WeCom /new and unavailable conversations (#3184)", () => {
	const accepted = async (
		f: ReturnType<typeof fixture>,
		input: Partial<WecomMessageV1>,
	) => {
		const result = await f.useCase.receive({ ...message, ...input });
		if (result.outcome !== "accepted") throw new Error("Expected acceptance");
		return result.receipt;
	};
	const executions = (f: ReturnType<typeof fixture>) =>
		[...f.conversations.values()].flatMap(
			(conversation) => conversation.snapshot().executions,
		);

	it("starts a new conversation for this sender only, without calling the Agent", async () => {
		const f = fixture();
		const first = await accepted(f, { eventId: "event-1" });
		const other = await accepted(f, {
			eventId: "event-2",
			senderId: "sender-2",
		});
		const started = await accepted(f, { eventId: "event-3", text: "/new" });
		expect(started).toMatchObject({
			status: "new_conversation",
			conversationId: null,
			executionId: null,
		});
		expect(executions(f)).toHaveLength(2);
		const next = await accepted(f, { eventId: "event-4", text: "hello again" });
		expect(next.status).toBe("accepted");
		expect(next.conversationId).not.toBe(first.conversationId);
		// 群内其他发送者的会话不受影响：仍映射到原会话（处理中，所以是 busy）。
		const otherAgain = await accepted(f, {
			eventId: "event-5",
			senderId: "sender-2",
		});
		expect(otherAgain).toMatchObject({
			status: "busy",
			conversationId: other.conversationId,
		});
	});

	it.each(["/new", " /NEW ", "@Agent /new", "@Agent\u2005/new", "@a @b /New"])(
		"recognizes %j as the new-conversation command",
		async (text) => {
			const f = fixture();
			expect(await accepted(f, { text })).toMatchObject({
				status: "new_conversation",
			});
			expect(executions(f)).toHaveLength(0);
		},
	);

	it.each(["/new 你好", "/newer", "请 /new", "/ new"])(
		"treats %j as an ordinary message",
		async (text) => {
			const f = fixture();
			expect(await accepted(f, { text })).toMatchObject({ status: "accepted" });
			expect(executions(f)).toHaveLength(1);
		},
	);

	it("answers a message to an unavailable conversation with a receipt and recovers with /new", async () => {
		const f = fixture();
		const first = await accepted(f, { eventId: "event-1" });
		const conversation = [...f.conversations.values()][0];
		if (!conversation || !first.conversationId || !first.executionId)
			throw new Error("Expected a conversation");
		conversation.completeExecution(first.executionId);
		conversation.markConversationUnavailable(first.conversationId);
		const rejected = await accepted(f, { eventId: "event-2", text: "again" });
		expect(rejected).toEqual({
			receiptId: expect.any(String),
			status: "unavailable",
			conversationId: first.conversationId,
			executionId: null,
		});
		expect(executions(f)).toHaveLength(1);
		await accepted(f, { eventId: "event-3", text: "/new" });
		const recovered = await accepted(f, { eventId: "event-4", text: "again" });
		expect(recovered.status).toBe("accepted");
		expect(recovered.conversationId).not.toBe(first.conversationId);
	});
});

describe("WeCom inbound media (#3227)", () => {
	const download = (ordinal = 0) => ({
		url: `https://download.example.test/media-${ordinal}?token=SENTINEL-URL-3227`,
		aesKey: "SENTINEL-AESKEY-3227",
		expiresAt: "2026-09-15T00:05:00Z",
	});
	const image = (ordinal = 0) => ({
		kind: "image" as const,
		name: null,
		download: download(ordinal),
	});
	function mediaFixture(
		handler?: (
			input: Parameters<WecomMediaResolverV1["resolve"]>[0],
			seed: WecomMediaResolverV1["resolve"],
		) => ReturnType<WecomMediaResolverV1["resolve"]>,
	): ReturnType<typeof fixture> & {
		readonly calls: Parameters<WecomMediaResolverV1["resolve"]>[0][];
		readonly conversationOf: (actorId: string) => FakeConversationExecutionV1;
	} {
		const calls: Parameters<WecomMediaResolverV1["resolve"]>[0][] = [];
		let f: ReturnType<typeof fixture> | undefined;
		const conversationOf = (actorId: string) => {
			const conversation = [...(f?.conversations.entries() ?? [])].find(
				([key]) => JSON.parse(key)[0] === actorId,
			)?.[1];
			if (!conversation) throw new Error("Missing fixture conversation");
			return conversation;
		};
		// 默认替身把已确认的 attachment 写到发送者自己的会话，绑定服务端解析的主体与会话。
		const seed: WecomMediaResolverV1["resolve"] = async (input) => {
			const conversation = conversationOf(input.authority.actor.actorId);
			const attachments = (input.message.media ?? []).map((_, ordinal) => {
				const fileId = `${input.conversationId}:${input.message.eventId}:${ordinal}`;
				conversation.seedFile({
					actorId: input.authority.actor.actorId,
					agentId: input.authority.actor.agentId,
					channelId: input.authority.actor.channelId,
					conversationId: input.conversationId,
					fileId,
					objectRef: `object-${fileId}`,
					kind: "attachment",
					idempotencyKey: `wecom-${ordinal}`,
					descriptor: {
						name: `image-${ordinal + 1}.png`,
						mediaType: "image/png",
						sizeBytes: 8,
						sha256: "a".repeat(64),
					},
					status: "available",
					executionId: null,
					messageId: null,
					sessionGeneration: null,
					objectVersion: "version-1",
					etag: "etag-1",
					createdAt: "2026-09-15T00:00:00.000Z",
					expiresAt: "2026-09-16T00:00:00.000Z",
					updatedAt: "2026-09-15T00:00:00.000Z",
					revision: 0,
				});
				return fileId;
			});
			return { outcome: "resolved", attachments };
		};
		f = fixture(undefined, {
			async resolve(input) {
				calls.push(input);
				return handler ? handler(input, seed) : seed(input);
			},
		});
		return Object.assign(f, { calls, conversationOf });
	}

	it("binds confirmed attachments to the sender's Message and Execution", async () => {
		const f = mediaFixture();
		const result = await f.useCase.receive({
			...message,
			text: "看看这两张图",
			media: [image(0), image(1)],
		});
		if (result.outcome !== "accepted") throw new Error("Expected acceptance");
		expect(result.receipt).toMatchObject({ status: "accepted" });
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0]).toMatchObject({
			conversationId: result.receipt.conversationId,
			authority: { actor: { actorId: message.senderId } },
		});
		const conversation = f.conversationOf(message.senderId);
		const snapshot = conversation.snapshot();
		expect(snapshot.executions).toHaveLength(1);
		const [first, second] = f.calls[0]?.message.media ?? [];
		expect(first?.download).toBeDefined();
		expect(second?.download).toBeDefined();
		for (const ordinal of [0, 1]) {
			const file = conversation.readFile(
				`${result.receipt.conversationId}:${message.eventId}:${ordinal}`,
			);
			expect(file).toMatchObject({
				messageId: snapshot.messages[0]?.messageId,
				executionId: result.receipt.executionId,
				sessionGeneration: 1,
			});
		}
	});

	it("replays the same message ID without downloading or writing again", async () => {
		const f = mediaFixture();
		const first = await f.useCase.receive({ ...message, media: [image()] });
		// 重投的下载地址与 aeskey 不同也不影响摘要：它们不是请求事实。
		const replay = await f.useCase.receive({
			...message,
			media: [
				{
					...image(),
					download: {
						...download(),
						url: "https://download.example.test/other",
						aesKey: "OTHER-KEY",
					},
				},
			],
		});
		expect(replay).toEqual({ ...first, outcome: "replayed" });
		expect(f.calls).toHaveLength(1);
		expect(
			f.conversationOf(message.senderId).snapshot().executions,
		).toHaveLength(1);
	});

	it("keeps the download URL and aeskey out of digests and receipts", async () => {
		const f = mediaFixture();
		await f.useCase.receive({ ...message, media: [image()] });
		await f.useCase.receive({
			...message,
			eventId: "event-rejected",
			media: [image()],
		});
		const persisted = JSON.stringify({
			receipts: [...f.receipts.values()],
			plans: f.plans.map(({ message: _message, ...plan }) => plan),
		});
		expect(persisted).not.toContain("SENTINEL-URL-3227");
		expect(persisted).not.toContain("SENTINEL-AESKEY-3227");
		expect(persisted).not.toContain("download.example.test");
	});

	it.each([
		{ outcome: "rejected", reason: "too_large", maxBytes: 20_971_520 },
		{ outcome: "rejected", reason: "unsupported_type", maxBytes: null },
		{ outcome: "rejected", reason: "expired", maxBytes: null },
		{ outcome: "rejected", reason: "failed", maxBytes: null },
	] as const)(
		"writes a media_rejected receipt without calling the Agent: %j",
		async (resolution) => {
			const f = mediaFixture(async () => resolution);
			const result = await f.useCase.receive({ ...message, media: [image()] });
			expect(result).toEqual({
				outcome: "accepted",
				receipt: {
					receiptId: expect.any(String),
					status: "media_rejected",
					conversationId: null,
					executionId: null,
				},
			});
			expect([...f.receipts.values()][0]?.mediaRejection).toEqual({
				reason: resolution.reason,
				maxBytes: resolution.maxBytes,
			});
			expect(
				f.conversationOf(message.senderId).snapshot().executions,
			).toHaveLength(0);
		},
	);

	it("rejects media when the resolver fails unexpectedly", async () => {
		const f = mediaFixture(async () => {
			throw new Error("SENTINEL-URL-3227");
		});
		const result = await f.useCase.receive({ ...message, media: [image()] });
		if (result.outcome !== "accepted") throw new Error("Expected receipt");
		expect(result.receipt.status).toBe("media_rejected");
		expect([...f.receipts.values()][0]?.mediaRejection).toEqual({
			reason: "failed",
			maxBytes: null,
		});
	});

	it.each([
		["without a file surface", undefined, message.kind, true],
		["for a callback-mode reference", "resolver", "wecom_bot", false],
		["for a self-built application", "resolver", "wecom_app", false],
	] as const)(
		"replies unsupported %s",
		async (_name, resolver, kind, withDownload) => {
			const f = resolver ? mediaFixture() : fixture();
			const result = await f.useCase.receive({
				...message,
				kind,
				media: [withDownload ? image() : { kind: "file", name: "report.pdf" }],
			});
			if (result.outcome !== "accepted") throw new Error("Expected receipt");
			expect(result.receipt).toMatchObject({
				status: "media_rejected",
				conversationId: null,
				executionId: null,
			});
			expect([...f.receipts.values()][0]?.mediaRejection).toEqual({
				reason: "unsupported_channel",
				maxBytes: null,
			});
			if ("calls" in f) expect(f.calls).toHaveLength(0);
			// 不调用 Agent，也不为被拒绝的媒体创建会话。
			for (const conversation of f.conversations.values())
				expect(conversation.snapshot().conversations).toHaveLength(0);
		},
	);

	it("does not accept attachments into an unavailable conversation", async () => {
		const f = mediaFixture();
		const first = await f.useCase.receive({ ...message, text: "first" });
		if (first.outcome !== "accepted" || !first.receipt.conversationId)
			throw new Error("Expected acceptance");
		f.conversationOf(message.senderId).markConversationUnavailable(
			first.receipt.conversationId,
		);
		const result = await f.useCase.receive({
			...message,
			eventId: "event-media",
			media: [image()],
		});
		if (result.outcome !== "accepted") throw new Error("Expected receipt");
		expect(result.receipt).toMatchObject({
			status: "unavailable",
			conversationId: first.receipt.conversationId,
		});
		expect(f.calls).toHaveLength(0);
	});

	it("retries once when /new rotates the mapping after attachments were written", async () => {
		let rotate = true;
		let f: ReturnType<typeof mediaFixture> | undefined;
		f = mediaFixture(
			async (
				input: Parameters<WecomMediaResolverV1["resolve"]>[0],
				seed: WecomMediaResolverV1["resolve"],
			) => {
				if (rotate && f) {
					rotate = false;
					await f.useCase.receive({ ...message, eventId: "new", text: "/new" });
				}
				return seed(input);
			},
		);
		const result = await f.useCase.receive({ ...message, media: [image()] });
		const [before, after] = f.calls.map((call) => call.conversationId);
		expect(f.calls).toHaveLength(2);
		expect(before).not.toBe(after);
		// 附件只绑定到受理时映射到的新会话，旧会话里写入的附件保持未绑定。
		expect(result).toMatchObject({
			outcome: "accepted",
			receipt: { status: "accepted", conversationId: after },
		});
		const conversation = f.conversationOf(message.senderId);
		expect(
			conversation.readFile(`${before}:${message.eventId}:0`)?.messageId,
		).toBeNull();
		expect(
			conversation.readFile(`${after}:${message.eventId}:0`)?.messageId,
		).toEqual(expect.any(String));
	});

	it("keeps group senders in separate conversations with their own authority", async () => {
		const f = mediaFixture();
		const alice = await f.useCase.receive({ ...message, media: [image()] });
		const bob = await f.useCase.receive({
			...message,
			senderId: "sender-2",
			eventId: "event-bob",
			media: [image()],
		});
		if (alice.outcome !== "accepted" || bob.outcome !== "accepted")
			throw new Error("Expected acceptance");
		expect(alice.receipt.conversationId).not.toBe(bob.receipt.conversationId);
		expect(
			f.calls.map((call) => [
				call.authority.actor.actorId,
				call.conversationId,
			]),
		).toEqual([
			[message.senderId, alice.receipt.conversationId],
			["sender-2", bob.receipt.conversationId],
		]);
		// 另一发送者的会话里读不到这条附件。
		expect(
			f
				.conversationOf("sender-2")
				.readFile(`${alice.receipt.conversationId}:${message.eventId}:0`),
		).toBeNull();
	});

	it.each([
		[
			"plain HTTP download",
			{
				...image(),
				download: { ...download(), url: "http://download.example.test/x" },
			},
		],
		[
			"missing expiry",
			{ ...image(), download: { url: download().url, aesKey: "key" } },
		],
		["declared media type", { ...image(), mediaType: "image/png" }],
	])("rejects an invalid media reference: %s", async (_name, entry) => {
		const f = mediaFixture();
		await expect(
			f.useCase.receive({
				...message,
				media: [entry as never],
			}),
		).rejects.toThrow("Invalid WeCom message");
		expect(f.receipts.size).toBe(0);
	});
});

it("requires the current company identity, active Owner, binding and Agent availability", async () => {
	const management = {
		schemaVersion: 1 as const,
		applicationId: "app",
		agentId: "agent-1",
		applicantId: "owner",
		status: "available" as const,
		revision: 1,
		approvalRevision: 1,
		decisionReason: null,
		serviceAvailability: "ready" as const,
		desiredState: "running" as const,
		workloadRevision: 1,
		fence: 1,
		ownerIds: ["owner"],
		availability: [{ kind: "organization" as const, organizationId: "org-1" }],
		failureCode: null,
	};
	const configuration = {
		schemaVersion: 2 as const,
		agentId: "agent-1",
		revision: 1,
		source: {
			kind: "custom" as const,
			imageDigest: `sha256:${"a".repeat(64)}`,
			admissionRevision: "admitted",
			interactionMode: "platform-adapter" as const,
			connectionEnabled: false,
		},
		modelConfiguration: null,
		actions: [],
		actionSetRevision: "v1",
		environment: [],
		secrets: [],
		channels: [{ kind: "wecom_bot" as const, bindingReference: "binding-1" }],
		channelRevision: "v1",
	};
	let active = true;
	let organizations = ["org-1"];
	let owners = ["owner"];
	let channelEnabled = true;
	let directoryRevision = "snapshot-1";
	const auth = createWecomAuthorizationV1({
		identity: {
			async resolveSender() {
				return {
					schemaVersion: 1,
					userId: "company-user",
					accountStatus: active ? "active" : "disabled",
					organizationIds: organizations,
					authorizationRevision: "identity-1",
					directorySnapshotBinding: {
						schemaVersion: 1,
						source: "controlled-directory",
						revision: directoryRevision,
						fetchedAt: Date.now() - 1_000,
						validUntil: Date.now() + 60_000,
					},
				};
			},
			async activeUsers() {
				return owners;
			},
		},
		state: {
			async readAuthorityState() {
				return {
					management,
					configuration: channelEnabled
						? configuration
						: {
								...configuration,
								channels: configuration.channels.map((binding) => ({
									...binding,
									enabled: false,
								})),
							},
					authorizationRevision: "rev-1",
				};
			},
		},
	});
	const initial = await auth.authorize(message);
	expect(initial).toMatchObject({
		outcome: "allowed",
		authority: {
			actor: {
				actorId: "company-user",
				supportsSupplementaryInstruction: false,
			},
		},
	});
	if (initial.outcome !== "allowed") throw new Error("Expected authorization");
	directoryRevision = "snapshot-2";
	expect(
		await auth.authorize(message, "use", initial.authority.actor.taskBoundary),
	).toMatchObject({ outcome: "denied" });
	directoryRevision = "snapshot-1";
	channelEnabled = false;
	expect(await auth.authorize(message)).toMatchObject({ outcome: "denied" });
	channelEnabled = true;
	for (const patch of [
		{ channelId: "wecom_bot:replacement" },
		{ agentId: "agent-2" },
		{ agentAuthorizationRevision: "rev-0" },
	]) {
		expect(
			await auth.authorize(message, "use", {
				...initial.authority.actor.taskBoundary,
				...patch,
			}),
		).toMatchObject({ outcome: "denied" });
	}
	expect(
		await auth.authorize({ ...message, bindingReference: "other" }),
	).toMatchObject({ outcome: "denied" });
	organizations = [];
	expect(await auth.authorize(message)).toMatchObject({ outcome: "denied" });
	organizations = ["org-1"];
	active = false;
	expect(await auth.authorize(message)).toMatchObject({ outcome: "denied" });
	active = true;
	owners = [];
	expect(await auth.authorize(message)).toMatchObject({ outcome: "denied" });
});

it("rejects replay through a replacement binding without starting another execution", async () => {
	const f = fixture();
	expect((await f.useCase.receive(message)).outcome).toBe("accepted");
	expect(
		await f.useCase.receive({ ...message, bindingReference: "replacement" }),
	).toEqual({ outcome: "conflict" });
	expect(f.conversations.size).toBe(1);
});

it("requires a current sender-to-Connection fact when Connection is enabled", async () => {
	const fact = {
		schemaVersion: 1 as const,
		providerId: message.providerId,
		bindingReference: message.bindingReference,
		senderId: "company-user",
		authorizationReference: "opaque-grant-ref",
		authorizationRevision: "auth-r1",
		grantRevision: "grant-r1",
		revocationRevision: "revoke-r1",
		expiresAt: "2099-01-01T00:00:00.000Z",
	};
	const state = {
		management: {
			schemaVersion: 1 as const,
			agentId: message.agentId,
			applicationId: "app-1",
			applicantId: "owner",
			status: "available" as const,
			revision: 1,
			approvalRevision: 1,
			decisionReason: null,
			serviceAvailability: "ready" as const,
			desiredState: "running" as const,
			workloadRevision: 1,
			fence: 1,
			ownerIds: ["owner"],
			availability: [
				{ kind: "organization" as const, organizationId: "org-1" },
			],
			failureCode: null,
		},
		configuration: {
			schemaVersion: 2 as const,
			agentId: message.agentId,
			revision: 1,
			source: {
				kind: "custom" as const,
				imageDigest: `sha256:${"a".repeat(64)}`,
				admissionRevision: "admitted",
				interactionMode: "platform-adapter" as const,
				connectionEnabled: true,
			},
			modelConfiguration: null,
			actions: [],
			actionSetRevision: "v1",
			environment: [],
			secrets: [],
			channels: [
				{
					kind: "wecom_bot" as const,
					bindingReference: message.bindingReference,
				},
			],
			channelRevision: "v1",
		},
		authorizationRevision: "rev-1",
	};
	const identity = {
		resolveSender: async () => ({
			schemaVersion: 1 as const,
			userId: "company-user",
			accountStatus: "active" as const,
			organizationIds: ["org-1"],
			authorizationRevision: "identity-1",
		}),
		activeUsers: async () => ["owner"],
	};
	const statePort = { readAuthorityState: async () => state };
	const unavailable = createWecomAuthorizationV1({
		identity,
		state: statePort,
	});
	expect(
		await unavailable.authorize(message, "use", undefined, message.providerId),
	).toMatchObject({ outcome: "unavailable" });
	const auth = createWecomAuthorizationV1({
		identity,
		state: statePort,
		connectionAuthorization: { resolve: async () => fact },
	});
	const allowed = await auth.authorize(
		message,
		"use",
		undefined,
		message.providerId,
	);
	expect(allowed).toMatchObject({
		outcome: "allowed",
		authority: { connectionAuthorizationFact: fact },
	});
	const mismatch = await createWecomAuthorizationV1({
		identity,
		state: statePort,
		connectionAuthorization: {
			resolve: async () => ({ ...fact, senderId: "other-sender" }),
		},
	}).authorize(message, "use", undefined, message.providerId);
	expect(mismatch).toMatchObject({ outcome: "denied" });
	for (const candidate of [
		{ ...fact, expiresAt: "2000-01-01T00:00:00.000Z" },
		{ ...fact, bindingReference: "other-binding" },
		null,
	]) {
		const result = await createWecomAuthorizationV1({
			identity,
			state: statePort,
			connectionAuthorization: { resolve: async () => candidate },
		}).authorize(message, "use", undefined, message.providerId);
		expect(result).toMatchObject({ outcome: "denied" });
	}
	const unavailableFact = await createWecomAuthorizationV1({
		identity,
		state: statePort,
		connectionAuthorization: {
			resolve: async () => {
				throw new Error("provider unavailable");
			},
		},
	}).authorize(message, "use", undefined, message.providerId);
	expect(unavailableFact).toMatchObject({ outcome: "unavailable" });
});
