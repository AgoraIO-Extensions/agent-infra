import { describe, expect, it, vi } from "vitest";
import { FakeConversationExecutionV1 } from "./fake-conversation-execution.ts";
import {
	createWecomAuthorizationV1,
	createWecomChannelV1,
	type WecomAuthorizationPortV1,
	type WecomChannelStorePortV1,
	type WecomMessageV1,
	type WecomReceiptV1,
	wecomChannelIdV1,
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
function fixture(now = () => new Date("2026-09-15T00:00:00Z")) {
	let allowed = true;
	let nextId = 0;
	const receipts = new Map<
		string,
		{ digest: string; receipt: WecomReceiptV1 }
	>();
	const conversations = new Map<string, FakeConversationExecutionV1>();
	const store: WecomChannelStorePortV1 = {
		async reject() {},
		async accept(plan, execute) {
			const old = receipts.get(plan.eventKey);
			if (old)
				return old.digest === plan.requestDigest
					? { outcome: "replayed", receipt: old.receipt }
					: { outcome: "conflict" };
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
			const receipt = {
				...(await execute(conversation)),
				receiptId: plan.eventKey,
			};
			receipts.set(plan.eventKey, { digest: plan.requestDigest, receipt });
			return { outcome: "accepted", receipt };
		},
	};
	const useCase = createWecomChannelV1({
		now,
		store,
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
	const auth = createWecomAuthorizationV1({
		identity: {
			async resolveSender() {
				return {
					schemaVersion: 1,
					userId: "company-user",
					accountStatus: active ? "active" : "disabled",
					organizationIds: organizations,
					authorizationRevision: "identity-1",
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
