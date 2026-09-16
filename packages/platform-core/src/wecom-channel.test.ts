import { describe, expect, it } from "vitest";
import { FakeConversationExecutionV1 } from "./fake-conversation-execution.ts";
import {
	createWecomAuthorizationV1,
	createWecomChannelV1,
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
function fixture() {
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
				return { management, configuration, authorizationRevision: "rev-1" };
			},
		},
	});
	expect(await auth.authorize(message)).toMatchObject({
		outcome: "allowed",
		authority: {
			actor: {
				actorId: "company-user",
				supportsSupplementaryInstruction: false,
			},
		},
	});
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
