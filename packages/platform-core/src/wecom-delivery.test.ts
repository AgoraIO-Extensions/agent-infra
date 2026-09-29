import { expect, it, vi } from "vitest";
import {
	createWecomDeliveryV1,
	type WecomAuthorityV1,
	type WecomDeliveryClaimV1,
} from "./wecom-channel.ts";

const boundary = {
	schemaVersion: 1 as const,
	principal: { kind: "user" as const, id: "actor" },
	agentId: "agent",
	channelId: "wecom_bot:channel",
	identityRevision: "i1",
	agentAuthorizationRevision: "a1",
	accessSources: [{ kind: "user" as const, userId: "actor" }],
};
const claim: WecomDeliveryClaimV1 = {
	receiptId: "receipt",
	fence: 1,
	scope: {
		agentId: "agent",
		bindingReference: "binding",
		kind: "wecom_bot",
		senderId: "provider-user",
		peerId: "group",
		conversationType: "group",
		threadId: null,
	},
	actorId: "actor",
	channelRevision: "c1",
	replyHandle: "encrypted",
	replyExpiresAt: "2099-01-01T00:00:00Z",
	taskBoundary: boundary,
	acceptanceStatus: "accepted",
	executionStatus: "completed",
	textDeltas: ["final ", "reply"],
};
const authority: WecomAuthorityV1 = {
	actor: {
		schemaVersion: 1,
		actorId: "actor",
		agentId: "agent",
		channelId: boundary.channelId,
		authorizationRevision: "a1",
		supportsSupplementaryInstruction: false,
		taskBoundary: boundary,
	},
	channelRevision: "c1",
	managementRevision: 1,
};
function fixture() {
	const store = {
		claim: vi.fn(async () => claim),
		prepare: vi.fn(async () => true),
		finish: vi.fn(async () => {}),
	};
	const authorization = {
		authorize: vi.fn(async () => ({ outcome: "allowed" as const, authority })),
	};
	const sender = { send: vi.fn(async () => "sent" as const) };
	return {
		store,
		authorization,
		sender,
		useCase: createWecomDeliveryV1({ store, authorization, sender }),
	};
}
it("checks the original boundary and persists sending before producing the external effect", async () => {
	const f = fixture();
	await f.useCase.dispatch();
	expect(f.authorization.authorize).toHaveBeenCalledWith(
		claim.scope,
		"use",
		boundary,
	);
	expect(f.store.prepare.mock.invocationCallOrder[0]).toBeLessThan(
		f.sender.send.mock.invocationCallOrder[0] ?? 0,
	);
	expect(f.sender.send).toHaveBeenCalledWith({
		scope: claim.scope,
		replyHandle: "encrypted",
		text: "final reply",
	});
	expect(f.store.finish).toHaveBeenCalledWith(claim, "sent");
});
it("cancels before sending when identity mapping or binding changes", async () => {
	const f = fixture();
	f.authorization.authorize.mockResolvedValue({
		outcome: "allowed",
		authority: {
			...authority,
			actor: { ...authority.actor, actorId: "other" },
		},
	});
	await f.useCase.dispatch();
	expect(f.sender.send).not.toHaveBeenCalled();
	expect(f.store.prepare).not.toHaveBeenCalled();
	expect(f.store.finish).toHaveBeenCalledWith(claim, "cancelled");
});
it("does not send with a lost lease and records response loss as unknown without retry", async () => {
	const f = fixture();
	f.store.prepare.mockResolvedValueOnce(false);
	await f.useCase.dispatch();
	expect(f.sender.send).not.toHaveBeenCalled();
	f.sender.send.mockRejectedValue(new Error("response lost"));
	await f.useCase.dispatch();
	expect(f.sender.send).toHaveBeenCalledTimes(1);
	expect(f.store.finish).toHaveBeenCalledWith(claim, "unknown");
});
it("does not send expired or oversized replies", async () => {
	const f = fixture();
	f.store.claim
		.mockResolvedValueOnce({ ...claim, replyExpiresAt: "2000-01-01T00:00:00Z" })
		.mockResolvedValueOnce({ ...claim, textDeltas: ["x".repeat(20481)] });
	await f.useCase.dispatch();
	await f.useCase.dispatch();
	expect(f.sender.send).not.toHaveBeenCalled();
	expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "expired");
	expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "failed");
});
