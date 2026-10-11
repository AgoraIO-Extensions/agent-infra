import { expect, it, vi } from "vitest";
import {
	createWecomDeliveryV1,
	type WecomAuthorityV1,
	type WecomAuthorizationPortV1,
	type WecomDeliveryClaimV1,
	type WecomSendPortV1,
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
		authorize: vi.fn<WecomAuthorizationPortV1["authorize"]>(async () => ({
			outcome: "allowed",
			authority,
		})),
	};
	const sender = { send: vi.fn<WecomSendPortV1["send"]>(async () => "sent") };
	return {
		store,
		authorization,
		sender,
		useCase: createWecomDeliveryV1({ store, authorization, sender }),
	};
}
it("checks the original boundary and persists sending before producing the external effect", async () => {
	const f = fixture();
	const media = [
		{
			fileId: "result-file-1",
			name: "report.pdf",
			mediaType: "application/pdf",
			sizeBytes: 42,
		},
	] as const;
	f.store.claim.mockResolvedValueOnce({ ...claim, media });
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
		media,
		revalidate: expect.any(Function),
	});
	const revalidate = f.sender.send.mock.calls[0]?.[0]?.revalidate;
	expect(await revalidate?.()).toBe(true);
	f.authorization.authorize.mockResolvedValue({
		outcome: "denied",
		actorId: "actor",
	});
	expect(await revalidate?.()).toBe(false);
	expect(f.store.finish).toHaveBeenCalledWith(
		expect.objectContaining({ receiptId: claim.receiptId, media }),
		"sent",
	);
});
it("passes confirmed result files and allows a media-only reply", async () => {
	const f = fixture();
	const media = [
		{
			fileId: "result-file-1",
			name: "report.pdf",
			mediaType: "application/pdf",
			sizeBytes: 42,
		},
	] as const;
	f.store.claim.mockResolvedValueOnce({
		...claim,
		textDeltas: [],
		media,
	});
	await f.useCase.dispatch();
	expect(f.sender.send).toHaveBeenCalledWith({
		scope: claim.scope,
		replyHandle: claim.replyHandle,
		text: "",
		media,
		revalidate: expect.any(Function),
	});
	expect(f.store.finish).toHaveBeenCalledWith(
		expect.objectContaining({ media }),
		"sent",
	);
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
it("leaves a reply retryable while the Agent is temporarily unavailable", async () => {
	const f = fixture();
	f.authorization.authorize.mockResolvedValueOnce({
		outcome: "unavailable",
		actorId: "actor",
	});
	expect(await f.useCase.dispatch()).toBe(true);
	expect(f.store.prepare).not.toHaveBeenCalled();
	expect(f.store.finish).not.toHaveBeenCalled();
	expect(f.sender.send).not.toHaveBeenCalled();

	expect(await f.useCase.dispatch()).toBe(true);
	expect(f.store.prepare).toHaveBeenCalledTimes(1);
	expect(f.sender.send).toHaveBeenCalledTimes(1);
	expect(f.store.finish).toHaveBeenCalledWith(claim, "sent");
});
it("cancels a reply when authorization is denied", async () => {
	const f = fixture();
	f.authorization.authorize.mockResolvedValueOnce({
		outcome: "denied",
		actorId: "actor",
	});
	expect(await f.useCase.dispatch()).toBe(true);
	expect(f.store.prepare).not.toHaveBeenCalled();
	expect(f.sender.send).not.toHaveBeenCalled();
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
