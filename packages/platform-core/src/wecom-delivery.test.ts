import { expect, it, vi } from "vitest";
import {
	createWecomDeliveryV1,
	type WecomAuthorityV1,
	type WecomAuthorizationPortV1,
	type WecomDeliveryClaimV1,
	type WecomDeliveryStorePortV1,
	type WecomResultFileReferenceV1,
	type WecomSendPortV1,
	wecomQueueTimeoutTextV1,
	wecomReplyTimeoutTextV1,
	wecomRevalidationBackoffMsV1,
} from "./wecom-channel.ts";
import type { WecomAnswerReferenceParserV1 } from "./wecom-reply-media.ts";

/**
 * Core 单元测试用的引用解析替身：识别 `[说明](sandbox:路径)`、`![说明](sandbox:路径)`、
 * `[说明][标签]` 与独占一行的 `[标签]: sandbox:路径` 定义，跳过行内代码。真实的 CommonMark
 * 解析在企微 Adapter 中测试。
 */
const answerReferences: WecomAnswerReferenceParserV1 = (markdown) => {
	const normalize = (path: string) => {
		const value = path.replace(/^\/+/, "");
		return value && !value.includes("..") ? value : null;
	};
	const definitions = new Map<string, string>();
	for (const match of markdown.matchAll(/^\[([^\]]+)\]: sandbox:(\S*)$/gmu))
		definitions.set(match[1] ?? "", match[2] ?? "");
	const found: ReturnType<WecomAnswerReferenceParserV1>[number][] = [];
	for (const match of markdown.matchAll(
		/`[^`]*`|(!?)\[([^\]]*)\](?:\(sandbox:([^)\s]*)\)|\[([^\]]+)\])|^\[[^\]]+\]: sandbox:(\S*)$/gmu,
	)) {
		if (match[0].startsWith("`")) continue;
		const definition = match[5];
		const label = match[4];
		const path =
			definition ?? match[3] ?? (label ? definitions.get(label) : undefined);
		if (path === undefined) continue;
		found.push({
			start: match.index,
			end: match.index + match[0].length,
			kind:
				definition !== undefined ? "definition" : match[1] ? "image" : "link",
			workspaceReference: normalize(path),
			label: match[2] ?? "",
		});
	}
	return found;
};

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
		prepare: vi.fn<WecomDeliveryStorePortV1["prepare"]>(async () => true),
		progressMedia: vi.fn<WecomDeliveryStorePortV1["progressMedia"]>(
			async () => true,
		),
		finish: vi.fn(async () => {}),
		defer: vi.fn<WecomDeliveryStorePortV1["defer"]>(async () => {}),
		prepareNotice: vi.fn<WecomDeliveryStorePortV1["prepareNotice"]>(
			async () => "prepared",
		),
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
		useCase: createWecomDeliveryV1({
			store,
			authorization,
			sender,
			answerReferences,
		}),
	};
}
const pdf: WecomResultFileReferenceV1 = {
	fileId: "result-file-1",
	name: "report.pdf",
	mediaType: "application/pdf",
	sizeBytes: 42,
	workspaceReference: "out/report.pdf",
};
it("checks the original boundary and persists sending before producing the external effect", async () => {
	const f = fixture();
	await f.useCase.dispatch();
	expect(f.authorization.authorize).toHaveBeenCalledWith(
		claim.scope,
		"use",
		boundary,
	);
	expect(f.store.prepare).toHaveBeenCalledWith(claim, authority, []);
	expect(f.store.prepare.mock.invocationCallOrder[0]).toBeLessThan(
		f.sender.send.mock.invocationCallOrder[0] ?? 0,
	);
	expect(f.sender.send).toHaveBeenCalledWith({
		scope: claim.scope,
		replyHandle: "encrypted",
		text: "final reply",
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
		expect.objectContaining({ receiptId: claim.receiptId }),
		"sent",
	);
});
it("strips result files for a reply method without media and still sends the text (#3229 AC-4)", async () => {
	const f = fixture();
	f.store.claim.mockResolvedValueOnce({
		...claim,
		conversationId: "conversation",
		executionId: "execution",
		textDeltas: ["报告见 [季度报告](sandbox:out/report.pdf)。"],
		media: [pdf],
	});
	await f.useCase.dispatch();
	expect(f.store.prepare).toHaveBeenCalledWith(
		expect.any(Object),
		authority,
		[],
	);
	expect(f.sender.send).toHaveBeenCalledWith({
		scope: claim.scope,
		replyHandle: claim.replyHandle,
		text: "报告见 report.pdf（当前渠道不支持发送文件）。",
		revalidate: expect.any(Function),
	});
	expect(JSON.stringify(f.sender.send.mock.calls)).not.toContain("sandbox:");
	expect(f.store.progressMedia).not.toHaveBeenCalled();
	expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "sent");
});
it("lists unreferenced result files when the answer itself is empty (#3229)", async () => {
	const f = fixture();
	f.store.claim.mockResolvedValueOnce({
		...claim,
		textDeltas: [],
		media: [{ ...pdf, workspaceReference: null }],
	});
	await f.useCase.dispatch();
	expect(f.sender.send).toHaveBeenCalledWith(
		expect.objectContaining({ text: "report.pdf（当前渠道不支持发送文件）" }),
	);
	expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "sent");
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
it("retries revalidation with bounded backoff while a dependency is temporarily unavailable (#3377)", async () => {
	const f = fixture();
	f.authorization.authorize.mockResolvedValueOnce({
		outcome: "unavailable",
		actorId: "actor",
	});
	expect(await f.useCase.dispatch()).toBe(true);
	expect(f.store.prepare).not.toHaveBeenCalled();
	expect(f.store.finish).not.toHaveBeenCalled();
	expect(f.sender.send).not.toHaveBeenCalled();
	// 首次退避 1 秒；回执仍由这次领取持有，不放弃也不推进状态。
	expect(f.store.defer).toHaveBeenCalledWith(claim, 1_000);

	expect(await f.useCase.dispatch()).toBe(true);
	expect(f.store.prepare).toHaveBeenCalledTimes(1);
	expect(f.sender.send).toHaveBeenCalledTimes(1);
	expect(f.store.finish).toHaveBeenCalledWith(claim, "sent");
});
it.each([
	[1, 1_000],
	[2, 2_000],
	[3, 4_000],
	[4, 8_000],
	[5, 15_000],
	[40, 15_000],
])(
	"backs off revalidation after claim %i by %i ms (#3377)",
	async (fence, delay) => {
		expect(wecomRevalidationBackoffMsV1(fence)).toBe(delay);
		const f = fixture();
		f.store.claim.mockResolvedValueOnce({ ...claim, fence });
		f.authorization.authorize.mockRejectedValueOnce(
			new Error("directory down"),
		);
		await f.useCase.dispatch();
		expect(f.store.defer).toHaveBeenCalledWith(
			expect.objectContaining({ fence }),
			delay,
		);
		expect(f.sender.send).not.toHaveBeenCalled();
	},
);
it("never defers past the last 30 seconds of the reply lifetime (#3377)", async () => {
	const now = new Date("2030-01-01T00:00:00Z");
	const f = fixture();
	const useCase = createWecomDeliveryV1({
		store: f.store,
		authorization: f.authorization,
		sender: f.sender,
		answerReferences,
		now: () => now,
	});
	f.store.claim.mockResolvedValueOnce({
		...claim,
		fence: 9,
		replyExpiresAt: "2030-01-01T00:00:32Z",
	});
	f.authorization.authorize.mockResolvedValueOnce({ outcome: "unavailable" });
	await useCase.dispatch();
	expect(f.store.defer).toHaveBeenCalledWith(expect.any(Object), 2_000);
});
it.each([
	["a failure notice", { executionStatus: "failed", textDeltas: [] }],
	["a completed answer", {}],
	["an unready answer", { answerReady: false, textDeltas: ["机密半成品"] }],
	["a busy notice", { acceptanceStatus: "busy" as const }],
])(
	"sends a fixed internal-error notice without business content when %s cannot be revalidated before the deadline (#3377 AC-2)",
	async (_name, changes: Partial<WecomDeliveryClaimV1>) => {
		const now = new Date("2030-01-01T00:00:00Z");
		const f = fixture();
		const useCase = createWecomDeliveryV1({
			store: f.store,
			authorization: f.authorization,
			sender: f.sender,
			answerReferences,
			now: () => now,
		});
		f.store.claim.mockResolvedValueOnce({
			...claim,
			...changes,
			fence: 7,
			traceId: "trace-7",
			replyExpiresAt: "2030-01-01T00:00:20Z",
			thinking: { parts: [raw("私密思考")], complete: true },
		});
		f.authorization.authorize.mockResolvedValue({ outcome: "unavailable" });
		expect(await useCase.dispatch()).toBe(true);
		expect(f.store.defer).not.toHaveBeenCalled();
		expect(f.store.prepare).not.toHaveBeenCalled();
		expect(f.store.prepareNotice).toHaveBeenCalledTimes(1);
		const input = f.sender.send.mock.calls[0]?.[0];
		expect(input).toEqual({
			scope: claim.scope,
			replyHandle: claim.replyHandle,
			text: "本次任务执行失败，平台内部错误，反馈时请提供追踪编号 trace-7",
			revalidate: expect.any(Function),
		});
		expect(JSON.stringify(input)).not.toMatch(/final|机密|私密/);
		// 复核仍不可用时照常发送；确认撤权或修订变化时不发送。
		expect(await input?.revalidate?.()).toBe(true);
		f.authorization.authorize.mockResolvedValueOnce({ outcome: "denied" });
		expect(await input?.revalidate?.()).toBe(false);
		f.authorization.authorize.mockResolvedValueOnce({
			outcome: "allowed",
			authority: { ...authority, channelRevision: "c2" },
		});
		expect(await input?.revalidate?.()).toBe(false);
		expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "sent");
	},
);
it("falls back to the receipt as trace and cancels the notice when revisions changed (#3377)", async () => {
	const now = new Date("2030-01-01T00:00:00Z");
	const f = fixture();
	const useCase = createWecomDeliveryV1({
		store: f.store,
		authorization: f.authorization,
		sender: f.sender,
		answerReferences,
		now: () => now,
	});
	const late = { ...claim, replyExpiresAt: "2030-01-01T00:00:10Z" };
	f.authorization.authorize.mockResolvedValue({ outcome: "unavailable" });
	f.store.claim.mockResolvedValueOnce(late);
	await useCase.dispatch();
	expect(f.sender.send).toHaveBeenCalledWith(
		expect.objectContaining({
			text: "本次任务执行失败，平台内部错误，反馈时请提供追踪编号 receipt",
		}),
	);
	f.store.claim.mockResolvedValueOnce(late);
	f.store.prepareNotice.mockResolvedValueOnce("changed");
	await useCase.dispatch();
	expect(f.store.finish).toHaveBeenLastCalledWith(late, "cancelled");
	expect(f.sender.send).toHaveBeenCalledTimes(1);
	f.store.claim.mockResolvedValueOnce(late);
	f.store.prepareNotice.mockResolvedValueOnce("stale");
	f.store.finish.mockClear();
	await useCase.dispatch();
	expect(f.store.finish).not.toHaveBeenCalled();
	expect(f.sender.send).toHaveBeenCalledTimes(1);
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
		const media = [pdf];
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

// #3077、#3377：回答在有效期内没有就绪时，Store 在最后 30 秒领取，Core 保留已有回答、附固定超时提示
// 并以 finish=true 定稿，不附思考过程与结果文件。
it("finalizes an unready reply with the answer so far and the timeout notice (#3377)", async () => {
	const media = [pdf];
	const { f, input } = await sentFor({
		answerReady: false,
		executionStatus: "processing",
		textDeltas: ["已经", "写好的部分 [报告](sandbox:out/report.pdf)"],
		media,
		thinking: { parts: [raw("思考")], complete: true },
	});
	expect(f.store.prepare).toHaveBeenCalledWith(
		expect.any(Object),
		authority,
		[],
	);
	expect(input).toEqual({
		scope: claim.scope,
		replyHandle: claim.replyHandle,
		text: `已经写好的部分 report.pdf（未发布）\n\n${wecomReplyTimeoutTextV1}`,
		revalidate: expect.any(Function),
	});
	expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "sent");
});
it("sends only the timeout notice when nothing has been answered yet (#3077)", async () => {
	const { input } = await sentFor({
		answerReady: false,
		executionStatus: "processing",
		textDeltas: [],
	});
	expect(input?.text).toBe(wecomReplyTimeoutTextV1);
});
it("cuts a long unready answer at a code point so the timeout notice always fits (#3377)", async () => {
	const { input } = await sentFor({
		answerReady: false,
		executionStatus: "processing",
		textDeltas: ["答".repeat(8000)],
		answerTooLong: true,
	});
	const text = input?.text ?? "";
	expect(Buffer.byteLength(text)).toBeLessThanOrEqual(20480);
	expect(
		text.endsWith(`（回答较长，已截断）\n\n${wecomReplyTimeoutTextV1}`),
	).toBe(true);
	expect(text.startsWith("答答")).toBe(true);
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
		"explains an unclassified failure as an internal error with its trace",
		{ executionStatus: "failed", textDeltas: [], traceId: "trace-1" },
		"本次任务执行失败，平台内部错误，反馈时请提供追踪编号 trace-1",
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

// #3227：入站媒体不调用 Agent 时按原因回复固定说明，不附带思考过程，也不带结果文件。
it.each([
	[
		{ reason: "too_large", maxBytes: 20 * 1024 * 1024 },
		"文件超过 20 MB，未发送给 Agent",
	],
	[
		{ reason: "too_large", maxBytes: 10_485_760 + 524_288 },
		"文件超过 10.5 MB，未发送给 Agent",
	],
	[{ reason: "too_large", maxBytes: 4096 }, "文件超过 4 KB，未发送给 Agent"],
	[
		{ reason: "unsupported_type", maxBytes: null },
		"不支持该文件类型，未发送给 Agent",
	],
	[
		{ reason: "expired", maxBytes: null },
		"文件下载地址已过期，未发送给 Agent，请重新发送",
	],
	[
		{ reason: "failed", maxBytes: null },
		"文件接收失败，未发送给 Agent，请重新发送",
	],
	[
		{ reason: "unsupported_channel", maxBytes: null },
		"当前渠道不支持接收图片、文件、语音或视频，未发送给 Agent",
	],
] as const)(
	"replies %j with its fixed media rejection text (#3227)",
	async (mediaRejection, text) => {
		const f = fixture();
		f.store.claim.mockResolvedValueOnce({
			...claim,
			acceptanceStatus: "media_rejected",
			executionStatus: null,
			textDeltas: [],
			mediaRejection,
			thinking: { parts: [{ kind: "raw", text: "never" }], complete: true },
		});
		await f.useCase.dispatch();
		expect(f.sender.send).toHaveBeenCalledWith({
			scope: claim.scope,
			replyHandle: "encrypted",
			text,
			revalidate: expect.any(Function),
		});
		expect(f.store.finish).toHaveBeenCalledWith(
			expect.objectContaining({ receiptId: claim.receiptId }),
			"sent",
		);
	},
);

// #3229：长连接出站媒体（工程 Spec §14.2.3「长连接出站」）。
const mebibyte = 1024 * 1024;
const png: WecomResultFileReferenceV1 = {
	fileId: "file-png",
	name: "chart.png",
	mediaType: "image/png",
	sizeBytes: 2048,
	workspaceReference: "out/chart.png",
};
const mp4: WecomResultFileReferenceV1 = {
	fileId: "file-mp4",
	name: "demo.mp4",
	mediaType: "video/mp4",
	sizeBytes: 4 * mebibyte,
	workspaceReference: "out/demo.mp4",
};
const acpImage: WecomResultFileReferenceV1 = {
	fileId: "file-acp",
	name: "image-1.gif",
	mediaType: "image/gif",
	sizeBytes: 64,
	workspaceReference: null,
};
function mediaFixture(
	plan: NonNullable<WecomSendPortV1["planMedia"]> = async ({ files }) =>
		files.map(() => "send"),
) {
	const f = fixture();
	const sender = {
		send: f.sender.send,
		planMedia: vi.fn<NonNullable<WecomSendPortV1["planMedia"]>>(plan),
		sendMedia: vi.fn<NonNullable<WecomSendPortV1["sendMedia"]>>(
			async () => "sent",
		),
	};
	return {
		...f,
		sender,
		useCase: createWecomDeliveryV1({
			store: f.store,
			authorization: f.authorization,
			sender,
			answerReferences,
		}),
	};
}
const mediaClaim = (
	answer: string,
	media: readonly WecomResultFileReferenceV1[],
): WecomDeliveryClaimV1 => ({
	...claim,
	conversationId: "conversation-1",
	executionId: "execution-1",
	textDeltas: [answer],
	media,
});

it("AC-1: sends PNG, PDF and MP4 after the text in reference order (#3229)", async () => {
	const f = mediaFixture();
	// 事件顺序与引用顺序不同；ACP image 没有引用顺序，排在后面。
	f.store.claim.mockResolvedValueOnce({
		...mediaClaim(
			"视频 [演示](sandbox:out/demo.mp4)，图表 ![趋势](sandbox:/out/chart.png)，报告 [季度报告](sandbox:out/report.pdf)。",
			[acpImage, pdf, png, mp4],
		),
		thinking: { parts: [raw("想一想")], complete: true },
	});
	await f.useCase.dispatch();
	const kinds = [
		{ ...mp4, kind: "video" },
		{ ...png, kind: "image" },
		{ ...pdf, kind: "file" },
		{ ...acpImage, kind: "image" },
	];
	expect(f.sender.planMedia).toHaveBeenCalledWith({
		scope: claim.scope,
		replyHandle: claim.replyHandle,
		files: kinds,
	});
	expect(f.store.prepare).toHaveBeenCalledWith(
		expect.any(Object),
		authority,
		kinds,
	);
	const text =
		"视频 demo.mp4（见下方文件），图表 chart.png（见下方文件），报告 report.pdf（见下方文件）。\n\nimage-1.gif（见下方文件）";
	expect(f.sender.send).toHaveBeenCalledWith({
		scope: claim.scope,
		replyHandle: claim.replyHandle,
		text,
		textWithThinking: `<think>想一想</think>\n\n${text}`,
		revalidate: expect.any(Function),
	});
	expect(f.sender.sendMedia.mock.calls.map(([input]) => input.file)).toEqual(
		kinds,
	);
	expect(f.sender.sendMedia).toHaveBeenCalledWith({
		scope: claim.scope,
		replyHandle: claim.replyHandle,
		file: kinds[0],
		source: {
			actorId: claim.actorId,
			conversationId: "conversation-1",
			executionId: "execution-1",
		},
		revalidate: expect.any(Function),
	});
	// 文本先于媒体；每个媒体先记录发送意图，再发送，再记录结果。
	const textOrder = f.sender.send.mock.invocationCallOrder[0] ?? 0;
	expect(textOrder).toBeLessThan(
		f.sender.sendMedia.mock.invocationCallOrder[0] ?? 0,
	);
	expect(f.store.progressMedia.mock.calls.map(([, i, s]) => [i, s])).toEqual([
		[0, "sending"],
		[0, "sent"],
		[1, "sending"],
		[1, "sent"],
		[2, "sending"],
		[2, "sent"],
		[3, "sending"],
		[3, "sent"],
	]);
	expect(f.store.progressMedia.mock.invocationCallOrder[0]).toBeLessThan(
		f.sender.sendMedia.mock.invocationCallOrder[0] ?? 0,
	);
	expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "sent");
});

it("AC-2: does not send files beyond WeCom limits and names the reason without sandbox: (#3229)", async () => {
	const f = mediaFixture(async ({ files }) =>
		files.map((file) =>
			file.fileId === "file-type"
				? "unsupported_type"
				: file.fileId === "file-rate"
					? "rate_limited"
					: "send",
		),
	);
	const big = {
		...pdf,
		fileId: "file-big",
		name: "big.pdf",
		sizeBytes: 20 * mebibyte + 1,
		workspaceReference: "out/big.pdf",
	};
	const tiny = {
		...pdf,
		fileId: "file-tiny",
		name: "tiny.txt",
		mediaType: "text/plain",
		sizeBytes: 4,
		workspaceReference: "out/tiny.txt",
	};
	const typed = {
		...pdf,
		fileId: "file-type",
		name: "app.exe",
		mediaType: "application/x-msdownload",
		workspaceReference: "out/app.exe",
	};
	const limited = {
		...pdf,
		fileId: "file-rate",
		name: "late.pdf",
		workspaceReference: "out/late.pdf",
	};
	// 超过 10MB 的 PNG 不能作为图片，按不超过 20MB 的普通文件发送。
	const largeImage = {
		...png,
		fileId: "file-large-image",
		name: "large.png",
		sizeBytes: 12 * mebibyte,
		workspaceReference: "out/large.png",
	};
	f.store.claim.mockResolvedValueOnce(
		mediaClaim(
			[
				"[大](sandbox:out/big.pdf) [小](sandbox:out/tiny.txt) [类型](sandbox:out/app.exe)",
				"[频率](sandbox:out/late.pdf) [大图](sandbox:out/large.png) [缺失](sandbox:out/missing.csv)",
				"[越界](sandbox:../secret) 再看 [引用][r] 和 `[代码](sandbox:out/code.txt)`",
				"",
				"[r]: sandbox:out/report.pdf",
				"",
			].join("\n"),
			[big, tiny, typed, limited, largeImage, pdf],
		),
	);
	await f.useCase.dispatch();
	expect(
		f.sender.planMedia.mock.calls[0]?.[0].files.map((file) => [
			file.fileId,
			file.kind,
		]),
	).toEqual([
		["file-type", "file"],
		["file-rate", "file"],
		["file-large-image", "file"],
		["result-file-1", "file"],
	]);
	const text = f.sender.send.mock.calls[0]?.[0].text ?? "";
	expect(text).toBe(
		[
			"big.pdf（超出企微限制，未发送） tiny.txt（超出企微限制，未发送） app.exe（类型不支持，未发送）",
			"late.pdf（超出企微发送频率限制，未发送） large.png（见下方文件） missing.csv（未发布）",
			"越界（未发布） 再看 report.pdf（见下方文件） 和 `[代码](sandbox:out/code.txt)`",
			"",
			"",
		].join("\n"),
	);
	// 代码中的内容不是引用，保持原样；其余回答不再出现 sandbox:。
	expect(text.replace("`[代码](sandbox:out/code.txt)`", "")).not.toContain(
		"sandbox:",
	);
	expect(
		f.sender.sendMedia.mock.calls.map(([input]) => input.file.fileId),
	).toEqual(["file-large-image", "result-file-1"]);
	expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "sent");
});

it("AC-2: sends at most ten files per reply (#3229)", async () => {
	const f = mediaFixture();
	const files = Array.from({ length: 11 }, (_, index) => ({
		...pdf,
		fileId: `file-${index}`,
		name: `f${index}.pdf`,
		workspaceReference: null,
	}));
	f.store.claim.mockResolvedValueOnce(mediaClaim("见附件", files));
	await f.useCase.dispatch();
	expect(f.sender.planMedia.mock.calls[0]?.[0].files).toHaveLength(10);
	expect(f.sender.send.mock.calls[0]?.[0].text).toContain(
		"f10.pdf（超出企微限制，未发送）",
	);
	expect(f.sender.sendMedia).toHaveBeenCalledTimes(10);
});

it("AC-2: counts only sendable files toward the ten-file limit (#3229)", async () => {
	const f = mediaFixture();
	const oversized = {
		...pdf,
		fileId: "file-big",
		name: "big.pdf",
		sizeBytes: 20 * mebibyte + 1,
		workspaceReference: null,
	};
	const files = Array.from({ length: 10 }, (_, index) => ({
		...pdf,
		fileId: `file-${index}`,
		name: `f${index}.pdf`,
		workspaceReference: null,
	}));
	f.store.claim.mockResolvedValueOnce(
		mediaClaim("见附件", [oversized, ...files]),
	);
	await f.useCase.dispatch();
	expect(f.sender.planMedia.mock.calls[0]?.[0].files).toHaveLength(10);
	expect(f.sender.sendMedia).toHaveBeenCalledTimes(10);
	expect(f.sender.send.mock.calls[0]?.[0].text).toContain(
		"big.pdf（超出企微限制，未发送）",
	);
});

it.each([
	["fails", "failed" as const],
	["loses the ACK", "unknown" as const],
])(
	"AC-3: records unknown when a media reply %s after the text was accepted (#3229)",
	async (_name, outcome) => {
		const f = mediaFixture();
		f.sender.sendMedia
			.mockResolvedValueOnce("sent")
			.mockResolvedValueOnce(outcome);
		f.store.claim.mockResolvedValueOnce(
			mediaClaim("[a](sandbox:out/chart.png) [b](sandbox:out/report.pdf)", [
				png,
				pdf,
			]),
		);
		await f.useCase.dispatch();
		expect(f.store.progressMedia.mock.calls.map(([, i, s]) => [i, s])).toEqual([
			[0, "sending"],
			[0, "sent"],
			[1, "sending"],
			[1, outcome],
		]);
		expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "unknown");
	},
);

it("AC-3: treats a thrown media send as unknown and keeps going (#3229)", async () => {
	const f = mediaFixture();
	f.sender.sendMedia.mockRejectedValueOnce(new Error("lost"));
	f.store.claim.mockResolvedValueOnce(
		mediaClaim("[a](sandbox:out/chart.png) [b](sandbox:out/report.pdf)", [
			png,
			pdf,
		]),
	);
	await f.useCase.dispatch();
	expect(f.sender.sendMedia).toHaveBeenCalledTimes(2);
	expect(f.store.progressMedia).toHaveBeenCalledWith(
		expect.any(Object),
		0,
		"unknown",
	);
	expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "unknown");
});

it.each([
	["failed", "failed"],
	["unknown", "unknown"],
] as const)(
	"AC-3: does not send media when the text is %s (#3229)",
	async (textStatus, finalStatus) => {
		const f = mediaFixture();
		f.sender.send.mockResolvedValueOnce(textStatus);
		f.store.claim.mockResolvedValueOnce(
			mediaClaim("[a](sandbox:out/chart.png)", [png]),
		);
		await f.useCase.dispatch();
		expect(f.sender.sendMedia).not.toHaveBeenCalled();
		expect(f.store.progressMedia).not.toHaveBeenCalled();
		expect(f.store.finish).toHaveBeenCalledWith(
			expect.any(Object),
			finalStatus,
		);
	},
);

it("AC-3: never starts a media send the Store no longer allows (#3229)", async () => {
	const f = mediaFixture();
	f.store.progressMedia
		.mockResolvedValueOnce(true)
		.mockResolvedValueOnce(true)
		.mockResolvedValueOnce(false);
	f.store.claim.mockResolvedValueOnce(
		mediaClaim("[a](sandbox:out/chart.png) [b](sandbox:out/report.pdf)", [
			png,
			pdf,
		]),
	);
	await f.useCase.dispatch();
	expect(f.sender.sendMedia).toHaveBeenCalledTimes(1);
	expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "unknown");
});

it("AC-5: stops sending media after authorization is revoked (#3229)", async () => {
	const f = mediaFixture();
	f.sender.sendMedia.mockImplementationOnce(async () => {
		f.authorization.authorize.mockResolvedValue({
			outcome: "denied",
			actorId: "actor",
		});
		return "sent";
	});
	f.store.claim.mockResolvedValueOnce(
		mediaClaim("[a](sandbox:out/chart.png) [b](sandbox:out/report.pdf)", [
			png,
			pdf,
		]),
	);
	await f.useCase.dispatch();
	expect(f.sender.sendMedia).toHaveBeenCalledTimes(1);
	expect(f.store.progressMedia.mock.calls.map(([, i, s]) => [i, s])).toEqual([
		[0, "sending"],
		[0, "sent"],
	]);
	expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "unknown");
});

it("leaves the reply claimable when media planning is temporarily unavailable (#3229)", async () => {
	const f = mediaFixture(async () => {
		throw new Error("limits unavailable");
	});
	f.store.claim.mockResolvedValueOnce(
		mediaClaim("[a](sandbox:out/chart.png)", [png]),
	);
	expect(await f.useCase.dispatch()).toBe(true);
	expect(f.store.prepare).not.toHaveBeenCalled();
	expect(f.store.finish).not.toHaveBeenCalled();
	expect(f.sender.send).not.toHaveBeenCalled();
});

it.each([
	["a planner without a sender", { planMedia: true, sendMedia: false }],
	["a claim without its execution", { planMedia: true, sendMedia: true }],
])("declares media unsupported for %s (#3229)", async (name, capabilities) => {
	const f = mediaFixture();
	const sender = {
		send: f.sender.send,
		...(capabilities.planMedia ? { planMedia: f.sender.planMedia } : {}),
		...(capabilities.sendMedia ? { sendMedia: f.sender.sendMedia } : {}),
	};
	const useCase = createWecomDeliveryV1({
		store: f.store,
		authorization: f.authorization,
		sender,
		answerReferences,
	});
	f.store.claim.mockResolvedValueOnce(
		name.includes("execution")
			? {
					...mediaClaim("[a](sandbox:out/chart.png)", [png]),
					executionId: null,
				}
			: mediaClaim("[a](sandbox:out/chart.png)", [png]),
	);
	await useCase.dispatch();
	expect(f.sender.planMedia).not.toHaveBeenCalled();
	expect(f.sender.send).toHaveBeenCalledWith(
		expect.objectContaining({ text: "chart.png（当前渠道不支持发送文件）" }),
	);
	expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "sent");
});

it.each([
	[
		"throws",
		() => {
			throw new Error("parser");
		},
	],
	[
		"returns an out-of-range span",
		() => [
			{ start: 0, end: 999, kind: "link", workspaceReference: "x", label: "" },
		],
	],
] as const)(
	"fails the reply when the reference parser %s (#3229)",
	async (_name, parse) => {
		const f = fixture();
		const useCase = createWecomDeliveryV1({
			store: f.store,
			authorization: f.authorization,
			sender: f.sender,
			answerReferences: parse as WecomAnswerReferenceParserV1,
		});
		await useCase.dispatch();
		expect(f.sender.send).not.toHaveBeenCalled();
		expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "failed");
	},
);

it("still fails an answer the Store marked beyond the bound even with result files (#3229)", async () => {
	const f = mediaFixture();
	f.store.claim.mockResolvedValueOnce({
		...mediaClaim("", [png]),
		textDeltas: [],
		answerTooLong: true,
	});
	await f.useCase.dispatch();
	expect(f.sender.planMedia).not.toHaveBeenCalled();
	expect(f.sender.send).not.toHaveBeenCalled();
	expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "failed");
});

it("summarizes unreferenced files in one line when listing them would exceed the bound (#3229)", async () => {
	const f = mediaFixture();
	const answer = "x".repeat(20_480 - 100);
	const files = Array.from({ length: 3 }, (_, index) => ({
		...acpImage,
		fileId: `file-acp-${index}`,
		name: `image-${index}.gif`,
	}));
	f.store.claim.mockResolvedValueOnce(
		mediaClaim(answer, [
			...files,
			{ ...pdf, sizeBytes: 21 * mebibyte, workspaceReference: null },
		]),
	);
	await f.useCase.dispatch();
	const text = f.sender.send.mock.calls[0]?.[0].text ?? "";
	expect(text).toBe(`${answer}\n\n另有 3 个文件见下方，1 个文件未发送`);
	expect(Buffer.byteLength(text)).toBeLessThanOrEqual(20_480);
	expect(f.sender.sendMedia).toHaveBeenCalledTimes(3);
});

it("rewrites sandbox: references inside the thinking with the same plan (#3229)", async () => {
	const f = mediaFixture();
	f.store.claim.mockResolvedValueOnce({
		...mediaClaim("见 [图](sandbox:out/chart.png)", [png]),
		thinking: {
			parts: [
				raw("先画 ![草图](sandbox:out/chart.png) 再写 [x](sandbox:out/x.md)"),
			],
			complete: true,
		},
	});
	await f.useCase.dispatch();
	const input = f.sender.send.mock.calls[0]?.[0];
	expect(input?.textWithThinking).toBe(
		"<think>先画 chart.png（见下方文件） 再写 x.md（未发布）</think>\n\n见 chart.png（见下方文件）",
	);
	expect(input?.textWithThinking).not.toContain("sandbox:");
});

it("AC-5: stops sending media when the channel revision changes between files (#3229)", async () => {
	const f = mediaFixture();
	f.sender.sendMedia.mockImplementationOnce(async () => {
		f.authorization.authorize.mockResolvedValue({
			outcome: "allowed",
			authority: { ...authority, channelRevision: "c2" },
		});
		return "sent";
	});
	f.store.claim.mockResolvedValueOnce(
		mediaClaim("[a](sandbox:out/chart.png) [b](sandbox:out/report.pdf)", [
			png,
			pdf,
		]),
	);
	await f.useCase.dispatch();
	expect(f.sender.sendMedia).toHaveBeenCalledTimes(1);
	expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "unknown");
});

// #3376：排队消息的最终结果与排队已满的繁忙提示（工程 Spec §12.5，企微部署固定文案）。
it.each([
	[
		"still waiting at the reply deadline",
		{
			executionStatus: "waiting",
			answerReady: false,
			queue: { failureCode: null },
		},
		wecomQueueTimeoutTextV1,
	],
	[
		"timed out in the queue",
		{
			executionStatus: "failed",
			answerReady: true,
			queue: { failureCode: "TASK_WAIT_TIMEOUT" },
		},
		wecomQueueTimeoutTextV1,
	],
	[
		"cancelled because the Agent stopped",
		{
			executionStatus: "failed",
			answerReady: true,
			queue: { failureCode: "AGENT_UNAVAILABLE" },
		},
		"已取消：Agent 当前不可用，本条消息未处理",
	],
	[
		"cancelled because the conversation became unavailable",
		{
			executionStatus: "failed",
			answerReady: true,
			queue: { failureCode: "CONVERSATION_UNAVAILABLE" },
		},
		"当前会话不可用，发送 /new 开始新会话",
	],
	[
		"cancelled because authorization was revoked",
		{
			executionStatus: "cancelled",
			answerReady: true,
			queue: { failureCode: "AUTHORIZATION_REVOKED" },
		},
		"已取消：权限已失效，本条消息未处理",
	],
	[
		"a started queued message that completed",
		{ executionStatus: "completed", queue: { failureCode: null } },
		"final reply",
	],
	[
		"a started queued message that ran past the reply deadline",
		{
			executionStatus: "processing",
			answerReady: false,
			queue: { failureCode: null },
		},
		// #3377：已开始处理的排队消息按普通回复超时定稿，保留已有回答。
		`final reply\n\n${wecomReplyTimeoutTextV1}`,
	],
	[
		"a busy receipt with a full queue",
		{ acceptanceStatus: "busy" as const, queuedCount: 3 },
		"当前会话已有 3 条消息在排队，请等前面的消息处理后再发送",
	],
	[
		"a busy receipt without queued messages",
		{ acceptanceStatus: "busy" as const, queuedCount: 0 },
		"Agent 正忙，请稍后重试",
	],
])(
	"replies to %s with the fixed queue text (#3376)",
	async (_name, changes: Partial<WecomDeliveryClaimV1>, expected) => {
		const { f, input } = await sentFor({
			thinking: { parts: [raw("私密思考")], complete: true },
			...changes,
		});
		expect(input?.text).toBe(expected);
		if (expected !== "final reply")
			expect(input && "textWithThinking" in input).toBe(false);
		expect(f.store.finish).toHaveBeenCalledWith(expect.any(Object), "sent");
	},
);

// #3377：失败说明按已持久的受限原因归入工程 Spec §16.1.1 的分类，内部错误附追踪编号。
it.each([
	[
		{ modelFailureCode: "dependency_unavailable" },
		"本次任务执行失败，模型服务暂时繁忙或超时，请稍后重试",
	],
	[
		{ taskReason: "AGENT_UNAVAILABLE" },
		"本次任务执行失败，Agent 正在更新，请在更新完成后重试",
	],
	[
		{ dispatchCode: "RUNTIME_SESSION_PREPARATION_FAILED" },
		"本次任务执行失败，会话准备失败，请重试，仍失败时新建会话",
	],
	[
		{ dispatchCode: "RUNTIME_FILE_INPUT_UNAVAILABLE" },
		"本次任务执行失败，附件无法读取，请重新发送附件",
	],
	[
		{ dispatchCode: "AUTHORIZATION_REVOKED" },
		"本次任务执行失败，当前没有使用该 Agent 的权限，请联系 Agent Owner 或管理员",
	],
	[
		{ runtimeCode: "RELAY_KEY_UNAVAILABLE" },
		"本次任务执行失败，个人 Relay Key 不可用，请到个人设置处理",
	],
	[
		{ taskReason: "TASK_WAIT_TIMEOUT" },
		"排队超时，等待超过时限仍未开始，本条消息未处理，请稍后重新发送",
	],
	[
		{ dispatchCode: "RUNTIME_SESSION_BLOCKED" },
		"本次任务执行失败，当前会话不可用，发送 /new 开始新会话",
	],
	[
		{ dispatchCode: "RUNTIME_RECOVERY_TIMEOUT" },
		"本次任务执行失败，平台内部错误，反馈时请提供追踪编号 trace-9",
	],
	[{}, "本次任务执行失败，平台内部错误，反馈时请提供追踪编号 trace-9"],
] as const)(
	"explains failure %j with its §16.1.1 category text (#3377 AC-2)",
	async (failure, text) => {
		const { input } = await sentFor({
			executionStatus: "failed",
			textDeltas: ["不应出现的半成品"],
			failure,
			traceId: "trace-9",
			thinking: { parts: [raw("私密思考")], complete: true },
		});
		expect(input).toEqual({
			scope: claim.scope,
			replyHandle: claim.replyHandle,
			text,
			revalidate: expect.any(Function),
		});
	},
);
