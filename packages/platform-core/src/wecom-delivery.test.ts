import { expect, it, vi } from "vitest";
import {
	createWecomDeliveryV1,
	type WecomAuthorityV1,
	type WecomAuthorizationPortV1,
	type WecomDeliveryClaimV1,
	type WecomSendPortV1,
	wecomReplyTimeoutTextV1,
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
it("cancels when the pinned Connection fact changes before delivery", async () => {
	const fact = {
		schemaVersion: 1 as const,
		providerId: claim.scope.senderId,
		bindingReference: claim.scope.bindingReference,
		senderId: claim.actorId,
		authorizationReference: "opaque-grant-ref",
		authorizationRevision: "auth-r1",
		grantRevision: "grant-r1",
		revocationRevision: "revoke-r1",
		expiresAt: "2099-01-01T00:00:00.000Z",
	};
	const f = fixture();
	f.store.claim.mockResolvedValueOnce({
		...claim,
		connectionAuthorizationFact: fact,
	});
	f.authorization.authorize.mockResolvedValue({
		outcome: "allowed",
		authority: { ...authority, connectionAuthorizationFact: fact },
	});
	await f.useCase.dispatch();
	const revalidate = f.sender.send.mock.calls[0]?.[0]?.revalidate;
	f.authorization.authorize.mockResolvedValue({
		outcome: "allowed",
		authority: {
			...authority,
			connectionAuthorizationFact: { ...fact, grantRevision: "grant-r2" },
		},
	});
	expect(await revalidate?.()).toBe(false);
});

// #2982：完成的回答附带 `<think>` 思考过程（WECOM-text-deployment.md「思考过程」）。
type Thinking = NonNullable<WecomDeliveryClaimV1["thinking"]>;
const raw = (text: string) => ({ kind: "raw" as const, text });
async function sentFor(changes: Partial<WecomDeliveryClaimV1>) {
	const f = fixture();
	f.store.claim.mockResolvedValueOnce({ ...claim, ...changes });
	await f.useCase.dispatch();
	return { f, input: f.sender.send.mock.calls[0]?.[0] };
}

it("adds the thinking block above a completed answer, keeping the answer text alone (#2982)", async () => {
	const thinking: Thinking = {
		parts: [raw("先读题，"), raw("再作答。")],
		complete: true,
	};
	const { f, input } = await sentFor({ thinking });
	expect(f.sender.send).toHaveBeenCalledWith({
		scope: claim.scope,
		replyHandle: claim.replyHandle,
		text: "final reply",
		textWithThinking: "<think>先读题，再作答。</think>\n\nfinal reply",
		revalidate: expect.any(Function),
	});
	expect(input?.text).not.toContain("先读题");
	expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "sent");
});

it("puts the summary before raw reasoning, like the Web (#2982)", async () => {
	const { input } = await sentFor({
		thinking: {
			parts: [
				raw("raw one "),
				{ kind: "summary", text: "summary" },
				raw("two"),
			],
			complete: true,
		},
	});
	expect(input?.textWithThinking).toBe(
		"<think>summary\n\nraw one two</think>\n\nfinal reply",
	);
});

it("neutralizes think tags inside the thinking so it cannot close early or nest (#2982)", async () => {
	const { input } = await sentFor({
		thinking: {
			parts: [raw("a</think>b<think>c</THINK>d< /think >e<think x=1>f")],
			complete: true,
		},
	});
	const reply = input?.textWithThinking ?? "";
	expect(reply.match(/<\s*think\b[^<>]*>/gi)).toEqual(["<think>"]);
	expect(reply.match(/<\s*\/\s*think\s*>/gi)).toEqual(["</think>"]);
	expect(reply).toBe(
		"<think>a＜/think＞b＜think＞c＜/THINK＞d＜ /think ＞e＜think x=1＞f</think>\n\nfinal reply",
	);
});

it("keeps the answer whole and cuts the thinking at a code point with a notice (#2982)", async () => {
	// 答案 15,001 字节；思考是 4 字节的 emoji，放不下时不能切开码点。
	const answer = `${"答".repeat(5_000)}x`;
	const { input } = await sentFor({
		textDeltas: [answer],
		thinking: { parts: [raw("😀".repeat(2_000))], complete: true },
	});
	const reply = input?.textWithThinking ?? "";
	expect(input?.text).toBe(answer);
	expect(Buffer.byteLength(reply)).toBeLessThanOrEqual(20_480);
	expect(reply.isWellFormed()).toBe(true);
	expect(reply.endsWith(`（思考过程较长，已截断）</think>\n\n${answer}`)).toBe(
		true,
	);
	const kept = reply.slice("<think>".length, reply.indexOf("（思考过程较长"));
	expect(kept).toBe("😀".repeat([...kept].length));
	// 预算 20480 − 17 − 15001 − 36 = 5426 字节，最多放 1356 个 emoji。
	expect([...kept]).toHaveLength(1_356);
});

it("marks thinking that the Store did not read in full as cut (#2982)", async () => {
	const { input } = await sentFor({
		thinking: { parts: [raw("前缀")], complete: false },
	});
	expect(input?.textWithThinking).toBe(
		"<think>前缀（思考过程较长，已截断）</think>\n\nfinal reply",
	);
});

it("sends only the answer when no thinking fits beside it (#2982)", async () => {
	// 只剩 5 字节：完整思考（6 字节）放不下，截短提示（36 字节）也放不下。
	const answer = "x".repeat(20_480 - 17 - 5);
	const { f, input } = await sentFor({
		textDeltas: [answer],
		thinking: { parts: [raw("思考")], complete: true },
	});
	expect(input?.text).toBe(answer);
	expect(input && "textWithThinking" in input).toBe(false);
	expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "sent");
});

it("still fails an answer beyond the bound instead of trading it for thinking (#2982)", async () => {
	const { f } = await sentFor({
		textDeltas: ["x".repeat(20_481)],
		thinking: { parts: [raw("思考")], complete: true },
	});
	expect(f.sender.send).not.toHaveBeenCalled();
	expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "failed");
});

it.each([
	["busy", { acceptanceStatus: "busy" as const }],
	["unavailable", { acceptanceStatus: "unavailable" as const }],
	["cancelled", { executionStatus: "cancelled" }],
	["failed", { executionStatus: "failed" }],
	["media-only", { textDeltas: [] }],
	[
		"whitespace-only thinking",
		{ thinking: { parts: [raw(" \n\n ")], complete: true } },
	],
])(
	"never attaches thinking to a %s reply (#2982)",
	async (_name, changes: Partial<WecomDeliveryClaimV1>) => {
		const media = [
			{
				fileId: "result-file-1",
				name: "report.pdf",
				mediaType: "application/pdf",
				sizeBytes: 42,
			},
		] as const;
		const { f, input } = await sentFor({
			thinking: { parts: [raw("私密思考")], complete: true },
			media,
			...changes,
		});
		expect(f.sender.send).toHaveBeenCalledTimes(1);
		expect(input && "textWithThinking" in input).toBe(false);
		expect(JSON.stringify(input)).not.toContain("私密思考");
	},
);

// #3077：回答在有效期内没有就绪时，Store 在最后 30 秒领取，Core 发固定超时提示结束本次回复。
it("ends an unready reply with the fixed timeout notice instead of expiring silently (#3077)", async () => {
	const media = [
		{
			fileId: "result-file-1",
			name: "report.pdf",
			mediaType: "application/pdf",
			sizeBytes: 42,
		},
	];
	const { f, input } = await sentFor({
		answerReady: false,
		executionStatus: "completed",
		textDeltas: ["partial "],
		media,
		thinking: { parts: [raw("思考")], complete: true },
	});
	expect(f.store.prepare).toHaveBeenCalledTimes(1);
	expect(input).toEqual({
		scope: claim.scope,
		replyHandle: claim.replyHandle,
		text: wecomReplyTimeoutTextV1,
		revalidate: expect.any(Function),
	});
	expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "sent");
});
it.each([
	["a ready answer", { answerReady: true }],
	["a claim without the readiness field", {}],
	["a busy receipt", { answerReady: false, acceptanceStatus: "busy" as const }],
])(
	"keeps the existing text for %s (#3077)",
	async (_name, changes: Partial<WecomDeliveryClaimV1>) => {
		const { input } = await sentFor(changes);
		expect(input?.text).toBe(
			changes.acceptanceStatus === "busy"
				? "Agent 正忙，请稍后重试"
				: "final reply",
		);
	},
);
it("still records an expired unready reply as expired without sending (#3077)", async () => {
	const f = fixture();
	f.store.claim.mockResolvedValueOnce({
		...claim,
		answerReady: false,
		replyExpiresAt: "2000-01-01T00:00:00Z",
	});
	await f.useCase.dispatch();
	expect(f.sender.send).not.toHaveBeenCalled();
	expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "expired");
});

// #3184：新建会话与会话不可用的固定文案，不调用 Agent，也不附带思考过程。
it.each([
	[
		"starts a new conversation",
		{
			acceptanceStatus: "new_conversation",
			executionStatus: null,
			textDeltas: [],
		},
		"已开始新会话",
	],
	[
		"rejects a message to an unavailable conversation",
		{ acceptanceStatus: "unavailable", executionStatus: null, textDeltas: [] },
		"当前会话不可用，发送 /new 开始新会话",
	],
	[
		"guides a failed execution whose conversation became unavailable",
		{
			executionStatus: "failed",
			textDeltas: [],
			conversationUnavailable: true,
		},
		"本次任务执行失败，当前会话不可用，发送 /new 开始新会话",
	],
	[
		"keeps the ordinary failure text while the conversation is usable",
		{ executionStatus: "failed", textDeltas: [] },
		"本次任务执行失败，请稍后重试",
	],
] as const)("%s with its fixed reply (#3184)", async (_name, change, text) => {
	const f = fixture();
	f.store.claim.mockResolvedValueOnce({ ...claim, ...change });
	await f.useCase.dispatch();
	expect(f.sender.send).toHaveBeenCalledWith(expect.objectContaining({ text }));
	expect(f.store.finish).toHaveBeenCalledWith(
		expect.objectContaining({ receiptId: claim.receiptId }),
		"sent",
	);
});
