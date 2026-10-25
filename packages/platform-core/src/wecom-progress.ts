import type { TaskAuthorizationBoundaryV1 } from "./task-authorization.js";
import {
	sameWecomConnectionAuthorizationFactV1,
	type WecomAuthorizationPortV1,
	type WecomConnectionAuthorizationFactV1,
	type WecomScopeV1,
	type WecomSendPortV1,
} from "./wecom-channel.js";
import type { WecomAnswerReferenceParserV1 } from "./wecom-reply-media.js";
import {
	composeWecomBoundedTextV1,
	composeWecomThinkingReplyV1,
	partialWecomAnswerV1,
} from "./wecom-reply-text.js";

/**
 * #3377：处理期间的阶段（工程 Spec §14.2.4）。Store 按 Contract 的阶段推导从已持久的平台状态
 * 事件与实际模型/工具事实得出，Web 使用同一推导；工具只给展示名，不含参数或结果。排队位次由
 * 排队实现（#3376）给出，没有时只显示“排队中”。
 */
export type WecomProgressPhaseV1 =
	| { readonly kind: "queued"; readonly position?: number | null }
	| { readonly kind: "preparing" }
	| { readonly kind: "running" }
	| { readonly kind: "tool"; readonly toolName: string }
	| { readonly kind: "model_retry" };

/** 当前连接持有者仍在处理、尚未进入终态回复的长连接回执。 */
export interface WecomProgressCandidateV1 {
	readonly receiptId: string;
	/** 回执所属的执行；Store 据此读取阶段事实与已有正文。 */
	readonly executionId: string;
	readonly scope: WecomScopeV1;
	readonly actorId: string;
	readonly channelRevision: string;
	readonly taskBoundary: TaskAuthorizationBoundaryV1;
	readonly connectionAuthorizationFact?: WecomConnectionAuthorizationFactV1;
	readonly replyHandle: string;
	/** 受理时间；已用秒数从这里起算（合并后的任务按文字消息）。 */
	readonly acceptedAt: string;
	/** 不透明的变化标记（执行状态与最新事件序号）；不变时沿用上次读取的内容。 */
	readonly revision: string;
}
/** 一帧需要的已持久内容：阶段、回答正文前缀与思考过程前缀，都是有界读取。 */
export interface WecomProgressSnapshotV1 {
	readonly phase: WecomProgressPhaseV1 | null;
	readonly textDeltas: readonly string[];
	/** false 表示正文超过有界读取，只读到了前缀。 */
	readonly answerComplete: boolean;
	readonly thinking?: {
		readonly parts: readonly {
			readonly kind: "raw" | "summary";
			readonly text: string;
		}[];
		readonly complete: boolean;
	};
}
export interface WecomProgressStorePortV1 {
	/** 当前连接持有者的、仍在处理且距回复有效期结束超过 30 秒的长连接回执（有界）。 */
	progressCandidates(): Promise<readonly WecomProgressCandidateV1[]>;
	progressSnapshot(
		candidate: WecomProgressCandidateV1,
	): Promise<WecomProgressSnapshotV1 | null>;
	/**
	 * 发送一帧之前持久化下一个 `streamFrameSeq`。只有回执仍未进入终态回复、未过期、回复路由仍是
	 * 这一个且长连接持有者租约与隔离令牌仍属于当前 Worker 时才成功；否则返回 null，不发送该帧。
	 */
	reserveStreamFrame(
		candidate: WecomProgressCandidateV1,
	): Promise<number | null>;
}

/** 阶段行中的阶段名（WECOM-text-deployment.md「共用执行与回复」）。 */
export function wecomProgressPhaseTextV1(phase: WecomProgressPhaseV1): string {
	switch (phase.kind) {
		case "queued":
			return Number.isSafeInteger(phase.position) && (phase.position ?? 0) > 0
				? `排队中（第 ${phase.position} 位）`
				: "排队中";
		case "preparing":
			return "准备会话";
		case "running":
			return "执行中";
		case "tool":
			return `调用工具：${phase.toolName}`;
		case "model_retry":
			return "模型重试";
	}
}

/**
 * 进度帧的全量内容：首行是“{阶段} · 已用 {秒} 秒”（没有阶段事实时只显示已用秒数），其后是已有
 * 回答，思考过程按企微样式放在最前、答案优先并截短提示。整帧不超过单条回复上限。
 */
export function composeWecomProgressTextV1(input: {
	readonly snapshot: WecomProgressSnapshotV1;
	readonly elapsedSeconds: number;
	readonly answerReferences: WecomAnswerReferenceParserV1;
}): string {
	const seconds = Math.max(0, Math.floor(input.elapsedSeconds));
	const phase = input.snapshot.phase;
	const head = phase
		? `${wecomProgressPhaseTextV1(phase)} · 已用 ${seconds} 秒`
		: `已用 ${seconds} 秒`;
	const body = composeWecomBoundedTextV1({
		head,
		answer: partialWecomAnswerV1(
			input.snapshot.textDeltas.join(""),
			input.answerReferences,
		),
		answerComplete: input.snapshot.answerComplete,
	});
	return input.snapshot.thinking
		? (composeWecomThinkingReplyV1(body, input.snapshot.thinking) ?? body)
		: body;
}

/** 没有新内容时刷新已用时长的间隔（工程 Spec §14.2.4）。 */
export const wecomProgressRefreshMsV1 = 15_000;

/**
 * #3377：企微长连接的流式进度（工程 Spec §14.2.4、ADR-0033 决策 6）。每次 `tick` 读取当前连接
 * 持有者仍在处理的回执，内容变化时立即、否则每 15 秒交给该 stream 的单一发送者覆盖更新；节流、
 * ACK 往返与合并由发送者负责。每帧发送前复核发送者授权与绑定并持久化帧序号；复核确认撤权或
 * 修订变化后不再更新，由终态回复按撤权规则结束。进度帧不经回执状态机，失败不重发、不影响终态。
 */
export function createWecomProgressV1(dependencies: {
	readonly store: WecomProgressStorePortV1;
	readonly authorization: WecomAuthorizationPortV1;
	readonly sender: Pick<WecomSendPortV1, "update">;
	readonly answerReferences: WecomAnswerReferenceParserV1;
	readonly now?: () => Date;
	readonly refreshMs?: number;
}) {
	const clock = () => (dependencies.now?.() ?? new Date()).getTime();
	const refreshMs = dependencies.refreshMs ?? wecomProgressRefreshMsV1;
	const streams = new Map<
		string,
		{
			revision: string;
			snapshot: WecomProgressSnapshotV1;
			pushedKey: string | null;
			pushedAt: number;
			stopped: boolean;
		}
	>();
	async function authorized(
		candidate: WecomProgressCandidateV1,
	): Promise<"allowed" | "denied" | "unavailable"> {
		let current: Awaited<ReturnType<WecomAuthorizationPortV1["authorize"]>>;
		try {
			current = await dependencies.authorization.authorize(
				candidate.scope,
				"use",
				candidate.taskBoundary,
				...(candidate.connectionAuthorizationFact
					? [candidate.connectionAuthorizationFact.providerId]
					: []),
			);
		} catch {
			return "unavailable";
		}
		if (current.outcome === "unavailable") return "unavailable";
		return current.outcome === "allowed" &&
			current.authority.actor.actorId === candidate.actorId &&
			current.authority.channelRevision === candidate.channelRevision &&
			sameWecomConnectionAuthorizationFactV1(
				current.authority.connectionAuthorizationFact,
				candidate.connectionAuthorizationFact,
			)
			? "allowed"
			: "denied";
	}
	return {
		/** 返回本轮交给发送者的帧数。 */
		async tick(): Promise<number> {
			const update = dependencies.sender.update;
			if (!update) return 0;
			const candidates = await dependencies.store.progressCandidates();
			const seen = new Set<string>();
			let queued = 0;
			for (const candidate of candidates) {
				seen.add(candidate.receiptId);
				try {
					let stream = streams.get(candidate.receiptId);
					if (stream?.stopped) continue;
					if (!stream || stream.revision !== candidate.revision) {
						const snapshot =
							await dependencies.store.progressSnapshot(candidate);
						if (!snapshot) continue;
						stream = {
							revision: candidate.revision,
							snapshot,
							pushedKey: stream?.pushedKey ?? null,
							pushedAt: stream?.pushedAt ?? 0,
							stopped: false,
						};
						streams.set(candidate.receiptId, stream);
					}
					const compose = (elapsedSeconds: number) =>
						composeWecomProgressTextV1({
							snapshot: (stream as NonNullable<typeof stream>).snapshot,
							elapsedSeconds,
							answerReferences: dependencies.answerReferences,
						});
					// 只刷新耗时不算新内容：用固定的已用秒数比较内容是否变化。
					const key = compose(0);
					const instant = clock();
					if (key === stream.pushedKey && instant - stream.pushedAt < refreshMs)
						continue;
					const current = stream;
					const outcome = await update({
						scope: candidate.scope,
						replyHandle: candidate.replyHandle,
						text: compose((instant - Date.parse(candidate.acceptedAt)) / 1000),
						prepare: async () => {
							if (current.stopped) return false;
							const decision = await authorized(candidate);
							if (decision === "denied") current.stopped = true;
							if (decision !== "allowed") return false;
							try {
								return (
									(await dependencies.store.reserveStreamFrame(candidate)) !==
									null
								);
							} catch {
								return false;
							}
						},
					});
					if (outcome === "queued") {
						current.pushedKey = key;
						current.pushedAt = instant;
						queued++;
					}
				} catch {
					// 单个回执的读取或路由失败不影响其他 stream，下一轮重试。
				}
			}
			for (const receiptId of streams.keys())
				if (!seen.has(receiptId)) streams.delete(receiptId);
			return queued;
		},
	};
}
