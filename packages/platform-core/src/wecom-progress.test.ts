import { describe, expect, it, vi } from "vitest";
import type {
	WecomAuthorityV1,
	WecomAuthorizationPortV1,
	WecomSendPortV1,
} from "./wecom-channel.ts";
import {
	composeWecomProgressTextV1,
	createWecomProgressV1,
	type WecomProgressCandidateV1,
	type WecomProgressSnapshotV1,
	type WecomProgressStorePortV1,
	wecomProgressPhaseTextV1,
} from "./wecom-progress.ts";
import type { WecomAnswerReferenceParserV1 } from "./wecom-reply-media.ts";

/** 只识别 `[说明](sandbox:路径)` 的引用解析替身。 */
const answerReferences: WecomAnswerReferenceParserV1 = (markdown) =>
	[...markdown.matchAll(/\[([^\]]*)\]\(sandbox:([^)\s]*)\)/gu)].map(
		(match) => ({
			start: match.index,
			end: match.index + match[0].length,
			kind: "link" as const,
			workspaceReference: match[2] ?? null,
			label: match[1] ?? "",
		}),
	);

const boundary = {
	schemaVersion: 1 as const,
	principal: { kind: "user" as const, id: "actor" },
	agentId: "agent",
	channelId: "wecom_bot:channel",
	identityRevision: "i1",
	agentAuthorizationRevision: "a1",
	accessSources: [{ kind: "user" as const, userId: "actor" }],
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
const candidate: WecomProgressCandidateV1 = {
	receiptId: "receipt",
	executionId: "execution",
	scope: {
		agentId: "agent",
		bindingReference: "binding",
		kind: "wecom_bot",
		senderId: "provider-user",
		peerId: "provider-user",
		conversationType: "single",
		threadId: null,
	},
	actorId: "actor",
	channelRevision: "c1",
	taskBoundary: boundary,
	replyHandle: "encrypted",
	acceptedAt: "2030-01-01T00:00:00.000Z",
	revision: "processing:3",
};
const snapshot: WecomProgressSnapshotV1 = {
	phase: { kind: "running" },
	textDeltas: ["正在", "回答"],
	answerComplete: true,
};

function fixture(options: { now?: () => Date } = {}) {
	let instant = new Date("2030-01-01T00:00:05.000Z").getTime();
	const store = {
		progressCandidates: vi.fn<WecomProgressStorePortV1["progressCandidates"]>(
			async () => [candidate],
		),
		progressSnapshot: vi.fn<WecomProgressStorePortV1["progressSnapshot"]>(
			async () => snapshot,
		),
		reserveStreamFrame: vi.fn<WecomProgressStorePortV1["reserveStreamFrame"]>(
			async () => 1,
		),
	};
	const authorization = {
		authorize: vi.fn<WecomAuthorizationPortV1["authorize"]>(async () => ({
			outcome: "allowed",
			authority,
		})),
	};
	const update = vi.fn<NonNullable<WecomSendPortV1["update"]>>(
		async () => "queued",
	);
	const progress = createWecomProgressV1({
		store,
		authorization,
		sender: { update },
		answerReferences,
		now: options.now ?? (() => new Date(instant)),
	});
	return {
		store,
		authorization,
		update,
		progress,
		advance(ms: number) {
			instant += ms;
		},
	};
}

describe("wecomProgressPhaseTextV1", () => {
	it("names each phase like the WeCom deployment table", () => {
		expect(wecomProgressPhaseTextV1({ kind: "queued", position: 2 })).toBe(
			"排队中（第 2 位）",
		);
		expect(wecomProgressPhaseTextV1({ kind: "queued" })).toBe("排队中");
		expect(wecomProgressPhaseTextV1({ kind: "queued", position: 0 })).toBe(
			"排队中",
		);
		expect(wecomProgressPhaseTextV1({ kind: "preparing" })).toBe("准备会话");
		expect(wecomProgressPhaseTextV1({ kind: "running" })).toBe("执行中");
		expect(
			wecomProgressPhaseTextV1({ kind: "tool", toolName: "打开页面" }),
		).toBe("调用工具：打开页面");
		expect(wecomProgressPhaseTextV1({ kind: "model_retry" })).toBe("模型重试");
	});
});

describe("composeWecomProgressTextV1", () => {
	it("puts the phase line with elapsed seconds above the answer so far", () => {
		expect(
			composeWecomProgressTextV1({
				snapshot,
				elapsedSeconds: 12.9,
				answerReferences,
			}),
		).toBe("执行中 · 已用 12 秒\n\n正在回答");
		expect(
			composeWecomProgressTextV1({
				snapshot: { phase: null, textDeltas: [], answerComplete: true },
				elapsedSeconds: -3,
				answerReferences,
			}),
		).toBe("已用 0 秒");
	});

	it("shows thinking first and never raw sandbox links", () => {
		const text = composeWecomProgressTextV1({
			snapshot: {
				phase: { kind: "tool", toolName: "shell" },
				textDeltas: ["见 [报告](sandbox:out/report.pdf)"],
				answerComplete: true,
				thinking: {
					parts: [{ kind: "summary", text: "先想一想" }],
					complete: true,
				},
			},
			elapsedSeconds: 3,
			answerReferences,
		});
		expect(text).toBe(
			"<think>先想一想</think>\n\n调用工具：shell · 已用 3 秒\n\n见 report.pdf（未发布）",
		);
	});

	it("keeps a long answer within one WeCom reply", () => {
		const text = composeWecomProgressTextV1({
			snapshot: {
				phase: { kind: "running" },
				textDeltas: ["答".repeat(9000)],
				answerComplete: false,
			},
			elapsedSeconds: 30,
			answerReferences,
		});
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(20480);
		expect(text.startsWith("执行中 · 已用 30 秒\n\n答")).toBe(true);
		expect(text.endsWith("（回答较长，已截断）")).toBe(true);
	});
});

describe("createWecomProgressV1", () => {
	it("sends new content at once and only refreshes the elapsed time every 15 seconds (#3377 AC-1)", async () => {
		const f = fixture();
		expect(await f.progress.tick()).toBe(1);
		expect(f.update).toHaveBeenLastCalledWith({
			scope: candidate.scope,
			replyHandle: candidate.replyHandle,
			text: "执行中 · 已用 5 秒\n\n正在回答",
			prepare: expect.any(Function),
		});
		f.advance(14_000);
		expect(await f.progress.tick()).toBe(0);
		// 同一修订不重读快照。
		expect(f.store.progressSnapshot).toHaveBeenCalledTimes(1);
		f.advance(1_000);
		expect(await f.progress.tick()).toBe(1);
		expect(f.update).toHaveBeenLastCalledWith(
			expect.objectContaining({ text: "执行中 · 已用 20 秒\n\n正在回答" }),
		);
	});

	it("rereads the snapshot when the revision changes and sends changed content immediately", async () => {
		const f = fixture();
		await f.progress.tick();
		f.advance(1_000);
		f.store.progressCandidates.mockResolvedValue([
			{ ...candidate, revision: "processing:4" },
		]);
		f.store.progressSnapshot.mockResolvedValueOnce({
			...snapshot,
			phase: { kind: "tool", toolName: "打开页面" },
		});
		expect(await f.progress.tick()).toBe(1);
		expect(f.update).toHaveBeenLastCalledWith(
			expect.objectContaining({
				text: "调用工具：打开页面 · 已用 6 秒\n\n正在回答",
			}),
		);
		// 新修订但内容没变（例如不展示的事件）：不额外发帧。
		f.advance(1_000);
		f.store.progressCandidates.mockResolvedValue([
			{ ...candidate, revision: "processing:5" },
		]);
		f.store.progressSnapshot.mockResolvedValueOnce({
			...snapshot,
			phase: { kind: "tool", toolName: "打开页面" },
		});
		expect(await f.progress.tick()).toBe(0);
	});

	it("revalidates and persists the frame sequence right before each frame", async () => {
		const f = fixture();
		await f.progress.tick();
		const prepare = f.update.mock.calls[0]?.[0]?.prepare;
		expect(await prepare?.()).toBe(true);
		expect(f.authorization.authorize).toHaveBeenCalledWith(
			candidate.scope,
			"use",
			boundary,
		);
		expect(f.store.reserveStreamFrame).toHaveBeenCalledWith(candidate);
		// 回执已进入终态回复或持有者已切换：不发送该帧。
		f.store.reserveStreamFrame.mockResolvedValueOnce(null);
		expect(await prepare?.()).toBe(false);
		f.store.reserveStreamFrame.mockRejectedValueOnce(new Error("db"));
		expect(await prepare?.()).toBe(false);
	});

	it("passes the pinned Connection provider to revalidation", async () => {
		const fact = {
			schemaVersion: 1 as const,
			providerId: "provider-1",
			bindingReference: "binding",
			senderId: "actor",
			authorizationReference: "ref",
			authorizationRevision: "r1",
			grantRevision: "g1",
			revocationRevision: "v1",
			expiresAt: "2099-01-01T00:00:00.000Z",
		};
		const f = fixture();
		f.store.progressCandidates.mockResolvedValue([
			{ ...candidate, connectionAuthorizationFact: fact },
		]);
		f.authorization.authorize.mockResolvedValue({
			outcome: "allowed",
			authority: { ...authority, connectionAuthorizationFact: fact },
		});
		await f.progress.tick();
		expect(await f.update.mock.calls[0]?.[0]?.prepare()).toBe(true);
		expect(f.authorization.authorize).toHaveBeenCalledWith(
			candidate.scope,
			"use",
			boundary,
			"provider-1",
		);
	});

	it("stops updating a stream once revalidation confirms revocation (#3377)", async () => {
		const f = fixture();
		await f.progress.tick();
		f.authorization.authorize.mockResolvedValueOnce({
			outcome: "allowed",
			authority: {
				...authority,
				actor: { ...authority.actor, actorId: "someone-else" },
			},
		});
		expect(await f.update.mock.calls[0]?.[0]?.prepare()).toBe(false);
		expect(f.store.reserveStreamFrame).not.toHaveBeenCalled();
		f.advance(60_000);
		expect(await f.progress.tick()).toBe(0);
		expect(f.update).toHaveBeenCalledTimes(1);
	});

	it("skips a frame without stopping while a dependency is temporarily unavailable", async () => {
		const f = fixture();
		await f.progress.tick();
		f.authorization.authorize.mockResolvedValueOnce({ outcome: "unavailable" });
		expect(await f.update.mock.calls[0]?.[0]?.prepare()).toBe(false);
		f.authorization.authorize.mockRejectedValueOnce(new Error("down"));
		expect(await f.update.mock.calls[0]?.[0]?.prepare()).toBe(false);
		expect(f.store.reserveStreamFrame).not.toHaveBeenCalled();
		f.advance(15_000);
		expect(await f.progress.tick()).toBe(1);
	});

	it("retries a frame the sender could not queue on the next tick", async () => {
		const f = fixture();
		f.update.mockResolvedValueOnce("failed");
		expect(await f.progress.tick()).toBe(0);
		f.advance(1_000);
		expect(await f.progress.tick()).toBe(1);
	});

	it("isolates per-stream failures and forgets finished receipts", async () => {
		const other = { ...candidate, receiptId: "other", replyHandle: "other" };
		const f = fixture();
		f.store.progressCandidates.mockResolvedValue([candidate, other]);
		f.store.progressSnapshot
			.mockRejectedValueOnce(new Error("read"))
			.mockResolvedValue(snapshot);
		expect(await f.progress.tick()).toBe(1);
		expect(f.update).toHaveBeenCalledWith(
			expect.objectContaining({ replyHandle: "other" }),
		);
		f.store.progressCandidates.mockResolvedValue([]);
		await f.progress.tick();
		f.store.progressCandidates.mockResolvedValue([other]);
		f.store.progressSnapshot.mockClear();
		await f.progress.tick();
		expect(f.store.progressSnapshot).toHaveBeenCalledTimes(1);
	});

	it("does nothing for reply methods that cannot update a sent reply", async () => {
		const store = {
			progressCandidates: vi.fn(async () => [candidate]),
			progressSnapshot: vi.fn(async () => snapshot),
			reserveStreamFrame: vi.fn(async () => 1),
		};
		const progress = createWecomProgressV1({
			store,
			authorization: { authorize: vi.fn() },
			sender: {},
			answerReferences,
		});
		expect(await progress.tick()).toBe(0);
		expect(store.progressCandidates).not.toHaveBeenCalled();
	});
});
