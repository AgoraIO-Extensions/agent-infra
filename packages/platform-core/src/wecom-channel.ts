import { createHash } from "node:crypto";
import {
	isAgentManagementText,
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
} from "./agent-management-input.js";
import type {
	ConversationExecutionAuthorityV1,
	ConversationExecutionUseCaseV1,
} from "./conversation-execution.js";
import {
	type CurrentTaskUserV1,
	captureTaskAuthorizationBoundaryV1,
	isTaskAuthorizationCurrentV1,
	parseCurrentTaskUserV1,
	type TaskAuthorizationBoundaryV1,
} from "./task-authorization.js";

export interface WecomScopeV1 {
	readonly agentId: string;
	readonly bindingReference: string;
	readonly kind: "wecom_bot" | "wecom_app";
	readonly senderId: string;
	readonly peerId: string;
	readonly conversationType: "single" | "group";
	readonly threadId: string | null;
}
/** Provider media metadata carried only across the trusted WeCom ingress seam.
 *
 * The media bytes are never exposed to Runtime or persisted in the receipt. A
 * deployment supplied resolver turns this opaque provider reference into file
 * authority ids inside the existing conversation admission transaction.
 */
export interface WecomMediaReferenceV1 {
	readonly kind: "image" | "file" | "voice" | "video";
	readonly mediaId: string;
	readonly name: string | null;
	readonly mediaType: string;
}
export interface WecomMessageV1 extends WecomScopeV1 {
	/** Stable provider receiver identity, independent of a replacement binding reference. */
	readonly providerId: string;
	readonly eventId: string;
	readonly text: string;
	readonly media?: readonly WecomMediaReferenceV1[];
	/** Opaque encrypted route; never exposed to the Runtime or browser. */
	readonly replyHandle: string;
	readonly replyExpiresAt: string;
}
export interface WecomConnectionAuthorizationRequestV1 {
	readonly agentId: string;
	readonly providerId: string;
	readonly bindingReference: string;
	readonly senderId: string;
}
/** Deployment-provided, non-secret fact; its reference is opaque to Platform. */
export interface WecomConnectionAuthorizationFactV1 {
	readonly schemaVersion: 1;
	readonly providerId: string;
	readonly bindingReference: string;
	readonly senderId: string;
	readonly authorizationReference: string;
	readonly authorizationRevision: string;
	readonly grantRevision: string;
	readonly revocationRevision: string;
	readonly expiresAt: string;
}
export interface WecomConnectionAuthorizationPortV1 {
	/** Return null for revoked, disabled, stale or cross-sender authority. */
	resolve(
		request: WecomConnectionAuthorizationRequestV1,
		signal?: AbortSignal,
	): Promise<WecomConnectionAuthorizationFactV1 | null>;
}
export function sameWecomConnectionAuthorizationFactV1(
	left: WecomConnectionAuthorizationFactV1 | undefined,
	right: WecomConnectionAuthorizationFactV1 | undefined,
): boolean {
	if (!left || !right) return left === right;
	return (
		left.schemaVersion === right.schemaVersion &&
		left.providerId === right.providerId &&
		left.bindingReference === right.bindingReference &&
		left.senderId === right.senderId &&
		left.authorizationReference === right.authorizationReference &&
		left.authorizationRevision === right.authorizationRevision &&
		left.grantRevision === right.grantRevision &&
		left.revocationRevision === right.revocationRevision &&
		left.expiresAt === right.expiresAt
	);
}
export interface WecomMediaResolverV1 {
	/**
	 * Resolve provider media through the existing File Authority and return the
	 * already confirmed attachment ids. Implementations must be idempotent by
	 * event/media id and must not create an object outside the caller's
	 * transaction boundary.
	 */
	resolve(input: {
		readonly message: WecomMessageV1;
		readonly conversationId: string;
		readonly signal?: AbortSignal;
	}): Promise<readonly string[]>;
}
export interface WecomResultFileReferenceV1 {
	readonly fileId: string;
	readonly name: string;
	readonly mediaType: string;
	readonly sizeBytes: number;
}
export interface WecomAuthorityV1 {
	readonly actor: ConversationExecutionAuthorityV1 & {
		readonly taskBoundary: TaskAuthorizationBoundaryV1;
	};
	readonly channelRevision: string;
	readonly managementRevision: number;
	readonly connectionAuthorizationFact?: WecomConnectionAuthorizationFactV1;
}
export interface WecomAuthorizationPortV1 {
	authorize(
		scope: WecomScopeV1,
		operation?: "use" | "read",
		originalBoundary?: TaskAuthorizationBoundaryV1,
		providerId?: string,
	): Promise<
		| { readonly outcome: "allowed"; readonly authority: WecomAuthorityV1 }
		| { readonly outcome: "denied" | "unavailable"; readonly actorId?: string }
	>;
}
export type WecomReceiptStatusV1 =
	| "accepted"
	| "busy"
	| "unavailable"
	| "new_conversation";
export interface WecomReceiptV1 {
	readonly receiptId: string;
	readonly status: WecomReceiptStatusV1;
	readonly conversationId: string | null;
	readonly executionId: string | null;
}
export type WecomAcceptanceV1 =
	| {
			readonly outcome: "accepted" | "replayed";
			readonly receipt: WecomReceiptV1;
	  }
	| { readonly outcome: "denied" | "unavailable" | "conflict" };
export interface WecomConnectionFenceV1 {
	readonly botId: string;
	readonly holderId: string;
	readonly fence: number;
}
export interface WecomAcceptancePlanV1 {
	readonly connectionFence?: WecomConnectionFenceV1;
	readonly message: WecomMessageV1;
	readonly authority: WecomAuthorityV1;
	readonly eventKey: string;
	/** 稳定映射键（Agent、绑定、类型、群/线程、发送者）；当前会话由它和轮次共同决定（#3184）。 */
	readonly conversationKey: string;
	readonly requestDigest: string;
}
/** Store 在受理事务内按映射键串行化后给出的当前会话映射（#3184）。 */
export interface WecomConversationMappingV1 {
	/** 当前轮次对应的 Conversation 创建幂等键。 */
	readonly conversationKey: string;
	/** `/new`：把该映射的轮次加一，之后的消息进入新的 Conversation。 */
	startNewConversation(): Promise<void>;
}
/** 轮次 0 沿用原映射键，存量映射不变；之后每一轮派生新的创建幂等键。 */
export function wecomConversationKeyForRotationV1(
	mappingKey: string,
	rotation: number,
): string {
	if (!Number.isSafeInteger(rotation) || rotation < 0)
		throw new Error("Invalid WeCom conversation rotation");
	return rotation === 0
		? mappingKey
		: digest([mappingKey, "conversation-rotation", rotation]);
}
/**
 * 去掉开头对机器人的 @ 提及和首尾空白后正好是 `/new`（ASCII 不区分大小写）且没有附件时，
 * 表示发送者要开始新会话；其他文本照常作为消息（#3184）。
 */
function isWecomNewConversationCommandV1(
	message: Pick<WecomMessageV1, "text" | "media">,
): boolean {
	if (message.media?.length) return false;
	return /^(?:@\S+\s+)*\/new$/iu.test(message.text.trim());
}
export interface WecomChannelStorePortV1 {
	reject(
		eventKey: string,
		outcome: "denied" | "unavailable" | "conflict",
		metadata: { readonly agentId: string; readonly actorId?: string },
	): Promise<void>;
	/** Receipt, conversation/message, Runtime outbox and reply intent commit atomically. */
	accept(
		plan: WecomAcceptancePlanV1,
		execute: (
			conversation: ConversationExecutionUseCaseV1,
			mapping: WecomConversationMappingV1,
		) => Promise<Omit<WecomReceiptV1, "receiptId">>,
		signal?: AbortSignal,
	): Promise<WecomAcceptanceV1>;
}
async function authorizeAdmission(
	authorization: WecomAuthorizationPortV1,
	message: WecomMessageV1,
	signal: AbortSignal | undefined,
): ReturnType<WecomAuthorizationPortV1["authorize"]> {
	if (!signal)
		return authorization.authorize(
			message,
			undefined,
			undefined,
			message.providerId,
		);
	if (signal.aborted) return { outcome: "unavailable" };
	let abort: (() => void) | undefined;
	try {
		const cancelled = new Promise<{ readonly outcome: "unavailable" }>(
			(resolve) => {
				abort = () => resolve({ outcome: "unavailable" });
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
			},
		);
		return await Promise.race([
			authorization.authorize(
				message,
				undefined,
				undefined,
				message.providerId,
			),
			cancelled,
		]);
	} finally {
		if (abort) signal.removeEventListener("abort", abort);
	}
}
function digest(values: readonly unknown[]) {
	return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
export function wecomChannelIdV1(
	scope: Pick<WecomScopeV1, "kind" | "bindingReference">,
): string {
	return `${scope.kind}:${digest([scope.bindingReference])}`;
}
export function createWecomChannelV1(dependencies: {
	readonly authorization: WecomAuthorizationPortV1;
	readonly store: WecomChannelStorePortV1;
	readonly media?: WecomMediaResolverV1;
	readonly now?: () => Date;
}) {
	const now = dependencies.now ?? (() => new Date());
	return {
		async receive(
			input: WecomMessageV1,
			connectionFence?: WecomConnectionFenceV1,
			signal?: AbortSignal,
		): Promise<WecomAcceptanceV1> {
			if (signal?.aborted) return { outcome: "unavailable" };
			const value = snapshotAgentManagementDataObject(input);
			const hasMedia = Object.hasOwn(value, "media");
			requireAgentManagementExactKeys(value, [
				"agentId",
				"bindingReference",
				"kind",
				"senderId",
				"peerId",
				"conversationType",
				"threadId",
				"eventId",
				"providerId",
				"text",
				"replyHandle",
				"replyExpiresAt",
				...(hasMedia ? ["media"] : []),
			]);
			if (
				[
					"agentId",
					"bindingReference",
					"senderId",
					"peerId",
					"eventId",
					"providerId",
				].some((k) => !isAgentManagementText(value[k])) ||
				(!(hasMedia && value.text === "") &&
					!isAgentManagementText(value.text, 32768)) ||
				!isAgentManagementText(value.replyHandle, 12000) ||
				!isAgentManagementText(value.replyExpiresAt) ||
				!Number.isFinite(Date.parse(value.replyExpiresAt as string)) ||
				Date.parse(value.replyExpiresAt as string) <= now().getTime() ||
				(hasMedia &&
					(!Array.isArray(value.media) ||
						value.media.length === 0 ||
						value.media.length > 32 ||
						value.media.some((entry) => {
							if (!entry || typeof entry !== "object" || Array.isArray(entry))
								return true;
							const media = entry as Record<string, unknown>;
							return (
								Object.keys(media).sort().join(",") !==
									"kind,mediaId,mediaType,name" ||
								!isAgentManagementText(media.mediaId, 4096) ||
								!isAgentManagementText(media.mediaType, 127) ||
								(media.name !== null &&
									!isAgentManagementText(media.name, 255)) ||
								!["image", "file", "voice", "video"].includes(
									media.kind as string,
								)
							);
						}) ||
						new Set(
							(value.media as readonly { mediaId: string }[]).map(
								(entry) => entry.mediaId,
							),
						).size !== (value.media as readonly unknown[]).length)) ||
				(value.threadId !== null && !isAgentManagementText(value.threadId)) ||
				!["wecom_bot", "wecom_app"].includes(value.kind as string) ||
				!["single", "group"].includes(value.conversationType as string)
			)
				throw new Error("Invalid WeCom message");
			const message = { ...value } as unknown as WecomMessageV1;
			const identity = await authorizeAdmission(
				dependencies.authorization,
				message,
				signal,
			);
			if (signal?.aborted) return { outcome: "unavailable" };
			if (identity.outcome !== "allowed") {
				await dependencies.store.reject(
					digest([message.kind, message.providerId, message.eventId]),
					identity.outcome,
					{
						agentId: message.agentId,
						...(identity.actorId ? { actorId: identity.actorId } : {}),
					},
				);
				return { outcome: identity.outcome };
			}
			const authority = identity.authority;
			if (
				authority.actor.agentId !== message.agentId ||
				authority.actor.channelId !== wecomChannelIdV1(message)
			) {
				await dependencies.store.reject(
					digest([message.kind, message.providerId, message.eventId]),
					"denied",
					{
						agentId: message.agentId,
						actorId: authority.actor.actorId,
					},
				);
				return { outcome: "denied" };
			}
			const eventKey = digest([
				message.kind,
				message.providerId,
				message.eventId,
			]);
			const conversationKey = digest([
				message.agentId,
				message.kind,
				message.bindingReference,
				message.conversationType,
				message.peerId,
				message.threadId,
				authority.actor.actorId,
				message.senderId,
			]);
			const requestDigest = digest([
				message.agentId,
				message.kind,
				message.bindingReference,
				message.senderId,
				message.peerId,
				message.conversationType,
				message.threadId,
				message.eventId,
				message.text,
				message.media ?? null,
				authority.actor.actorId,
			]);
			return dependencies.store.accept(
				{
					message,
					authority,
					eventKey,
					conversationKey,
					requestDigest,
					...(connectionFence ? { connectionFence } : {}),
				},
				async (conversation, mapping) => {
					if (Date.parse(message.replyExpiresAt) <= now().getTime())
						throw new Error("Invalid WeCom message");
					// `/new` 不调用 Agent：只轮换本发送者的映射，之后的消息进入新会话（#3184）。
					if (isWecomNewConversationCommandV1(message)) {
						await mapping.startNewConversation();
						return {
							status: "new_conversation",
							conversationId: null,
							executionId: null,
						};
					}
					const created = await conversation.createConversation({
						schemaVersion: 1,
						agentId: message.agentId,
						idempotencyKey: mapping.conversationKey,
						requestId: eventKey,
						traceId: eventKey,
					});
					if (created.outcome !== "accepted" && created.outcome !== "replayed")
						throw new Error("WeCom acceptance authorization changed");
					const conversationId = created.result.conversationId;
					// 会话不可用（恢复失败、受理不明阻塞或代次隔离中）时不受理，回执给出 /new 指引。
					const unavailableConversation = async () => {
						const current = await conversation.readConversation({
							schemaVersion: 1,
							conversationId,
						});
						return (
							current.outcome === "found" &&
							(current.result.conversation.status === "unavailable" ||
								current.result.conversation.isolationPending === true)
						);
					};
					const unavailable = {
						status: "unavailable",
						conversationId,
						executionId: null,
					} as const;
					// 附件先于受理落到文件面；不可用的会话不再接收附件。
					if (message.media?.length && (await unavailableConversation()))
						return unavailable;
					const attachments = message.media?.length
						? await dependencies.media?.resolve({
								message,
								conversationId,
								signal,
							})
						: undefined;
					if (message.media?.length && !attachments)
						throw new Error("WeCom media resolver unavailable");
					if (
						attachments &&
						(attachments.length !== (message.media?.length ?? 0) ||
							attachments.length > 32 ||
							attachments.some((id) => !isAgentManagementText(id, 1024)) ||
							new Set(attachments).size !== attachments.length)
					)
						throw new Error("Invalid WeCom media resolution");
					const decision = await conversation.accept({
						schemaVersion: 1,
						command: "message",
						conversationId,
						text: message.text,
						idempotencyKey: eventKey,
						requestId: eventKey,
						traceId: eventKey,
						...(attachments ? { attachments } : {}),
					});
					if (decision.outcome === "busy")
						return {
							status: "busy",
							conversationId,
							executionId: null,
						};
					if (
						decision.outcome === "denied" &&
						(await unavailableConversation())
					)
						return unavailable;
					if (
						decision.outcome !== "accepted" &&
						decision.outcome !== "replayed"
					)
						throw new Error("WeCom acceptance authorization changed");
					return {
						status: "accepted",
						conversationId,
						executionId: decision.result.executionId,
					};
				},
				signal,
			);
		},
	};
}

export type WecomDeliveryStatusV1 =
	| "pending"
	| "claimed"
	| "sending"
	| "sent"
	| "failed"
	| "unknown"
	| "cancelled"
	| "expired"
	| "abandoned";
export interface WecomDeliveryClaimV1 {
	readonly receiptId: string;
	readonly fence: number;
	readonly scope: WecomScopeV1;
	readonly actorId: string;
	readonly channelRevision: string;
	readonly replyHandle: string;
	readonly replyExpiresAt: string;
	readonly taskBoundary: TaskAuthorizationBoundaryV1;
	readonly connectionAuthorizationFact?: WecomConnectionAuthorizationFactV1;
	readonly acceptanceStatus: WecomReceiptStatusV1;
	readonly executionStatus: string | null;
	/**
	 * #3077：已受理执行的回复内容是否就绪（失败、停止，或完成且答案已完整落库）。为 false 时，Store
	 * 只在回复有效期最后 {@link wecomReplyTimeoutNoticeLeadMsV1} 内领取，Core 发送固定超时提示。
	 */
	readonly answerReady?: boolean;
	/** 回执所属的 Conversation 已不可用；失败文案据此附带 /new 指引（#3184）。 */
	readonly conversationUnavailable?: boolean;
	readonly textDeltas: readonly string[];
	/** Result files already confirmed by File Authority for this execution. */
	readonly media?: readonly WecomResultFileReferenceV1[];
	/**
	 * #2982：执行完成时按顺序读取的思考过程有界前缀；`complete` 为 false 表示还有没读到的思考内容。
	 * 只有完成的回答会带上它，回答正文仍只来自 `textDeltas`。
	 */
	readonly thinking?: {
		readonly parts: readonly {
			readonly kind: "raw" | "summary";
			readonly text: string;
		}[];
		readonly complete: boolean;
	};
}
export interface WecomDeliveryStorePortV1 {
	claim(): Promise<WecomDeliveryClaimV1 | null>;
	prepare(
		claim: WecomDeliveryClaimV1,
		authority: WecomAuthorityV1,
	): Promise<boolean>;
	finish(
		claim: WecomDeliveryClaimV1,
		status: "sent" | "failed" | "unknown" | "cancelled" | "expired",
	): Promise<void>;
}
export interface WecomSendPortV1 {
	send(input: {
		readonly scope: WecomScopeV1;
		readonly replyHandle: string;
		readonly text: string;
		/**
		 * #2982：`<think>思考过程</think>`、空行加答案的完整回复，不超过 20480 字节。只有能按企微
		 * 思考过程样式渲染的回复方式（智能机器人长连接 stream）使用它；其他方式只发送 `text`。
		 */
		readonly textWithThinking?: string;
		/** Result files already confirmed by File Authority for this execution. */
		readonly media?: readonly WecomResultFileReferenceV1[];
		/** Rechecks the original actor, channel revision and task boundary before an external effect. */
		readonly revalidate?: () => Promise<boolean>;
	}): Promise<"sent" | "failed" | "unknown">;
}
/** #2982：企微单条回复的字节上限，答案与思考过程共用。 */
const wecomReplyMaximumBytes = 20_480;
const wecomThinkingTruncatedNotice = "（思考过程较长，已截断）";

/**
 * #2982：按企微被动回复的思考过程样式组合 `<think>思考过程</think>`、空行与答案
 * （WECOM-text-deployment.md「思考过程」）。摘要与原始推理各自按顺序拼接，先摘要后原始推理，
 * 与 Web 一致。思考内容里的 `<think>`、`</think>` 字面量先换成全角尖括号，不能提前闭合或另起
 * 思考块。答案优先：思考过程只用答案之外的预算，放不下或没有读完时在码点边界截短并附提示；
 * 连提示都放不下时只发答案。
 */
function composeWecomThinkingReplyV1(
	answer: string,
	thinking: NonNullable<WecomDeliveryClaimV1["thinking"]>,
) {
	const joined = (kind: "raw" | "summary") =>
		thinking.parts
			.filter((part) => part.kind === kind)
			.map((part) => part.text)
			.join("");
	const content = [joined("summary"), joined("raw")]
		.filter(Boolean)
		.join("\n\n")
		.replace(/<(\s*\/?\s*think\b[^<>]*)>/gi, "＜$1＞");
	if (!content.trim()) return undefined;
	const budget =
		wecomReplyMaximumBytes - Buffer.byteLength(`<think></think>\n\n${answer}`);
	if (thinking.complete && Buffer.byteLength(content) <= budget)
		return `<think>${content}</think>\n\n${answer}`;
	const room = budget - Buffer.byteLength(wecomThinkingTruncatedNotice);
	let bytes = 0;
	let end = 0;
	for (const point of content) {
		const size = Buffer.byteLength(point);
		if (bytes + size > room) break;
		bytes += size;
		end += point.length;
	}
	if (!content.slice(0, end).trim()) return undefined;
	return `<think>${content.slice(0, end)}${wecomThinkingTruncatedNotice}</think>\n\n${answer}`;
}

/** #3077：长连接受理后立即发送的固定处理中提示，最终回复在同一 stream 上覆盖它。 */
export const wecomProcessingTextV1 = "已收到，正在处理…";
/** #3077：回复有效期内回答仍未就绪时发送的固定超时提示。 */
export const wecomReplyTimeoutTextV1 =
	"回复超时，Agent 未能在企微回复时限内完成，请稍后重试";
/** 回复有效期结束前多久领取仍未就绪的回执，用来发送超时提示（#3077）。 */
export const wecomReplyTimeoutNoticeLeadMsV1 = 30_000;
/** 映射到的会话不可用时的固定提示（#3184）。 */
const wecomConversationUnavailableTextV1 =
	"当前会话不可用，发送 /new 开始新会话";
/** 发送者用 `/new` 开始新会话后的固定回复（#3184）。 */
const wecomNewConversationTextV1 = "已开始新会话";
export function createWecomDeliveryV1(dependencies: {
	readonly store: WecomDeliveryStorePortV1;
	readonly authorization: WecomAuthorizationPortV1;
	readonly sender: WecomSendPortV1;
	readonly now?: () => Date;
}) {
	return {
		async dispatch(): Promise<boolean> {
			const claim = await dependencies.store.claim();
			if (!claim) return false;
			if (
				Date.parse(claim.replyExpiresAt) <=
				(dependencies.now?.() ?? new Date()).getTime()
			) {
				await dependencies.store.finish(claim, "expired");
				return true;
			}
			const current = claim.connectionAuthorizationFact
				? await dependencies.authorization.authorize(
						claim.scope,
						"use",
						claim.taskBoundary,
						claim.connectionAuthorizationFact.providerId,
					)
				: await dependencies.authorization.authorize(
						claim.scope,
						"use",
						claim.taskBoundary,
					);
			if (current.outcome === "unavailable") return true;
			if (
				current.outcome !== "allowed" ||
				current.authority.actor.actorId !== claim.actorId ||
				current.authority.channelRevision !== claim.channelRevision ||
				!sameWecomConnectionAuthorizationFactV1(
					current.authority.connectionAuthorizationFact,
					claim.connectionAuthorizationFact,
				)
			) {
				await dependencies.store.finish(claim, "cancelled");
				return true;
			}
			// #3077：回答在有效期内没有就绪时，结束本次回复并明确提示超时，不静默过期。
			const timedOut =
				claim.acceptanceStatus === "accepted" && claim.answerReady === false;
			const text =
				claim.acceptanceStatus === "busy"
					? "Agent 正忙，请稍后重试"
					: claim.acceptanceStatus === "unavailable"
						? wecomConversationUnavailableTextV1
						: claim.acceptanceStatus === "new_conversation"
							? wecomNewConversationTextV1
							: timedOut
								? wecomReplyTimeoutTextV1
								: claim.executionStatus === "completed"
									? claim.textDeltas.join("")
									: claim.executionStatus === "cancelled"
										? "本次任务已停止"
										: claim.conversationUnavailable
											? `本次任务执行失败，${wecomConversationUnavailableTextV1}`
											: "本次任务执行失败，请稍后重试";
			const media = timedOut ? [] : (claim.media ?? []);
			if (
				(!text && media.length === 0) ||
				Buffer.byteLength(text) > wecomReplyMaximumBytes
			) {
				await dependencies.store.finish(claim, "failed");
				return true;
			}
			// #2982：只有完成且有答案的回复组合思考过程；固定文案与只有文件的回复不附带。
			const textWithThinking =
				claim.acceptanceStatus === "accepted" &&
				!timedOut &&
				claim.executionStatus === "completed" &&
				text &&
				claim.thinking
					? composeWecomThinkingReplyV1(text, claim.thinking)
					: undefined;
			if (!(await dependencies.store.prepare(claim, current.authority)))
				return true;
			let status: "sent" | "failed" | "unknown";
			try {
				status = await dependencies.sender.send({
					scope: claim.scope,
					replyHandle: claim.replyHandle,
					text,
					...(textWithThinking ? { textWithThinking } : {}),
					...(media.length ? { media } : {}),
					revalidate: async () => {
						const latest = claim.connectionAuthorizationFact
							? await dependencies.authorization.authorize(
									claim.scope,
									"use",
									claim.taskBoundary,
									claim.connectionAuthorizationFact.providerId,
								)
							: await dependencies.authorization.authorize(
									claim.scope,
									"use",
									claim.taskBoundary,
								);
						return (
							latest.outcome === "allowed" &&
							latest.authority.actor.actorId === claim.actorId &&
							latest.authority.channelRevision === claim.channelRevision &&
							sameWecomConnectionAuthorizationFactV1(
								latest.authority.connectionAuthorizationFact,
								claim.connectionAuthorizationFact,
							)
						);
					},
				});
			} catch {
				status = "unknown";
			}
			await dependencies.store.finish(claim, status);
			return true;
		},
	};
}

export interface WecomIdentityPortV1 {
	/** Deployment maps the scoped provider ID to a company identity; browser fields are not accepted. */
	resolveSender(scope: WecomScopeV1): Promise<CurrentTaskUserV1 | null>;
	activeUsers(userIds: readonly string[]): Promise<readonly string[]>;
}
export interface WecomAuthorityStateV1 {
	readonly management: import("./agent-management.js").AgentManagementStateV1;
	readonly configuration: import("./agent-configuration.js").AgentConfigurationRecord;
	readonly authorizationRevision: string;
}
export interface WecomAuthorityStatePortV1 {
	readAuthorityState(agentId: string): Promise<WecomAuthorityStateV1 | null>;
}
function parseWecomConnectionAuthorizationFactV1(
	value: unknown,
	request: WecomConnectionAuthorizationRequestV1,
	now: number,
): WecomConnectionAuthorizationFactV1 | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).sort().join(",") !==
			"authorizationReference,authorizationRevision,bindingReference,expiresAt,grantRevision,providerId,revocationRevision,schemaVersion,senderId" ||
		record.schemaVersion !== 1 ||
		record.providerId !== request.providerId ||
		record.bindingReference !== request.bindingReference ||
		record.senderId !== request.senderId
	)
		return undefined;
	const strings = [
		record.authorizationReference,
		record.authorizationRevision,
		record.grantRevision,
		record.revocationRevision,
		record.expiresAt,
	];
	if (strings.some((entry) => !isAgentManagementText(entry, 512)))
		return undefined;
	const expiresAt = Date.parse(record.expiresAt as string);
	if (!Number.isFinite(expiresAt) || expiresAt <= now) return undefined;
	return {
		schemaVersion: 1,
		providerId: request.providerId,
		bindingReference: request.bindingReference,
		senderId: request.senderId,
		authorizationReference: record.authorizationReference as string,
		authorizationRevision: record.authorizationRevision as string,
		grantRevision: record.grantRevision as string,
		revocationRevision: record.revocationRevision as string,
		expiresAt: record.expiresAt as string,
	};
}
export function createWecomAuthorizationV1(dependencies: {
	readonly identity: WecomIdentityPortV1;
	readonly state: WecomAuthorityStatePortV1;
	readonly connectionAuthorization?: WecomConnectionAuthorizationPortV1;
	readonly now?: () => number;
}): WecomAuthorizationPortV1 {
	return {
		async authorize(scope, operation, originalBoundary, providerId) {
			const resolved = await dependencies.identity.resolveSender(scope);
			const actor = resolved ? parseCurrentTaskUserV1(resolved) : null;
			if (actor?.accountStatus !== "active")
				return {
					outcome: "denied",
					...(actor ? { actorId: actor.userId } : {}),
				};
			const state = await dependencies.state.readAuthorityState(scope.agentId);
			if (!state) return { outcome: "denied", actorId: actor.userId };
			const { management, configuration } = state;
			if (
				management.agentId !== scope.agentId ||
				configuration.agentId !== scope.agentId ||
				!configuration.channels.some(
					(b) =>
						b.kind === scope.kind &&
						b.bindingReference === scope.bindingReference &&
						!("enabled" in b && b.enabled === false),
				) ||
				(configuration.source.kind === "custom" &&
					configuration.source.interactionMode !== "platform-adapter")
			)
				return { outcome: "denied", actorId: actor.userId };
			let connectionAuthorizationFact:
				| WecomConnectionAuthorizationFactV1
				| undefined;
			if (
				(operation ?? "use") === "use" &&
				configuration.source.connectionEnabled
			) {
				if (!providerId || !dependencies.connectionAuthorization)
					return { outcome: "unavailable", actorId: actor.userId };
				let raw: WecomConnectionAuthorizationFactV1 | null;
				try {
					raw = await dependencies.connectionAuthorization.resolve({
						agentId: scope.agentId,
						providerId,
						bindingReference: scope.bindingReference,
						senderId: actor.userId,
					});
				} catch {
					return { outcome: "unavailable", actorId: actor.userId };
				}
				connectionAuthorizationFact = parseWecomConnectionAuthorizationFactV1(
					raw,
					{
						agentId: scope.agentId,
						providerId,
						bindingReference: scope.bindingReference,
						senderId: actor.userId,
					},
					(dependencies.now ?? Date.now)(),
				);
				if (!connectionAuthorizationFact)
					return { outcome: "denied", actorId: actor.userId };
			}
			const boundary = captureTaskAuthorizationBoundaryV1({
				principal: { kind: "user", id: actor.userId },
				user: actor,
				agent: management,
				channelId: wecomChannelIdV1(scope),
				agentAuthorizationRevision: state.authorizationRevision,
			});
			if (
				!boundary ||
				(originalBoundary !== undefined &&
					(originalBoundary.channelId !== wecomChannelIdV1(scope) ||
						originalBoundary.agentId !== scope.agentId ||
						originalBoundary.agentAuthorizationRevision !==
							state.authorizationRevision ||
						!isTaskAuthorizationCurrentV1({
							boundary: originalBoundary,
							user: actor,
							agent: management,
						}))) ||
				!(await dependencies.identity.activeUsers(management.ownerIds)).some(
					(id) => management.ownerIds.includes(id),
				)
			)
				return { outcome: "denied", actorId: actor.userId };
			if (
				(operation ?? "use") === "use" &&
				(management.status !== "available" ||
					management.serviceAvailability !== "ready")
			)
				return { outcome: "unavailable", actorId: actor.userId };
			return {
				outcome: "allowed",
				authority: {
					channelRevision: configuration.channelRevision,
					managementRevision: management.revision,
					...(connectionAuthorizationFact
						? { connectionAuthorizationFact }
						: {}),
					actor: {
						schemaVersion: 1,
						actorId: actor.userId,
						agentId: scope.agentId,
						channelId: wecomChannelIdV1(scope),
						authorizationRevision: state.authorizationRevision,
						supportsSupplementaryInstruction: false,
						taskBoundary: boundary,
					},
				},
			};
		},
	};
}

export interface WecomReceiptQueryPortV1 {
	list(
		actorId: string,
		cursor: string | undefined,
	): Promise<{ receiptIds: string[]; nextCursor: string | null }>;
	read(
		receiptId: string,
		actorId: string,
	): Promise<
		| (WecomReceiptV1 & {
				readonly deliveryStatus: WecomDeliveryStatusV1;
				readonly scope: WecomScopeV1;
		  })
		| null
	>;
	abandon(receiptId: string, actorId: string): Promise<boolean>;
}
export function createWecomReceiptAccessV1(dependencies: {
	readonly store: WecomReceiptQueryPortV1;
	readonly authorization: WecomAuthorizationPortV1;
}) {
	const read = async (receiptId: string, actorId: string) => {
		const record = await dependencies.store.read(receiptId, actorId);
		if (!record) return null;
		const current = await dependencies.authorization.authorize(
			record.scope,
			"read",
		);
		if (
			current.outcome !== "allowed" ||
			current.authority.actor.actorId !== actorId
		)
			return null;
		const { scope: _scope, ...result } = record;
		return result;
	};
	return {
		read,
		async list(actorId: string, cursor?: string) {
			const page = await dependencies.store.list(actorId, cursor);
			const items = await Promise.all(
				page.receiptIds.map((id) => read(id, actorId)),
			);
			return {
				items: items.filter((item) => item !== null),
				nextCursor: page.nextCursor,
			};
		},
		async abandon(receiptId: string, actorId: string) {
			if (!(await read(receiptId, actorId))) return false;
			return dependencies.store.abandon(receiptId, actorId);
		},
	};
}
