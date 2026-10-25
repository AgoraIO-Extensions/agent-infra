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
import { conversationQueueDeadlineLimitV1 } from "./conversation-queue.js";
import {
	classifyExecutionFailureV1,
	type ExecutionFailureFactsV1,
} from "./execution-failure.js";
import {
	type CurrentTaskUserV1,
	captureTaskAuthorizationBoundaryV1,
	isTaskAuthorizationCurrentV1,
	parseCurrentTaskUserV1,
	type TaskAuthorizationBoundaryV1,
} from "./task-authorization.js";
import {
	orderWecomResultFilesV1,
	parseWecomAnswerReferencesV1,
	rewriteWecomAnswerV1,
	type WecomAnswerReferenceParserV1,
	type WecomMediaProgressStatusV1,
	type WecomOutboundMediaPlanV1,
	type WecomOutboundMediaSkipReasonV1,
	type WecomOutboundMediaV1,
	wecomOutboundMediaKindV1,
	wecomReplyMediaMaxCountV1,
} from "./wecom-reply-media.js";
import {
	composeWecomBoundedTextV1,
	composeWecomThinkingReplyV1,
	partialWecomAnswerV1,
	wecomConversationUnavailableTextV1,
	wecomExecutionFailureTextV1,
	wecomReplyMaximumBytesV1,
	wecomReplyTimeoutTextV1,
} from "./wecom-reply-text.js";

export interface WecomScopeV1 {
	readonly agentId: string;
	readonly bindingReference: string;
	readonly kind: "wecom_bot" | "wecom_app";
	readonly senderId: string;
	readonly peerId: string;
	readonly conversationType: "single" | "group";
	readonly threadId: string | null;
}
/**
 * 智能机器人长连接的加密下载材料（#3227）：下载地址按官方说明 5 分钟内有效，每个地址有独立的
 * aeskey。它们只在 Worker 内存中短暂存在，不进入请求摘要、回执、日志、审计或事件。
 */
export interface WecomMediaDownloadV1 {
	readonly url: string;
	readonly aesKey: string;
	/** 下载地址的有效期；过期后不再下载，按地址过期回复。 */
	readonly expiresAt: string;
}
/**
 * 入站媒体引用，只跨受信的企微入站接缝传递（工程 Spec §14.2.3）。
 *
 * 字节不经过 Core，也不交给 Runtime。只有智能机器人长连接带 `download`；其他模式声明为
 * 不支持媒体，Core 不调用 Agent 并回复固定说明。媒体类型一律按实际字节识别，不取协议声明。
 */
export interface WecomMediaReferenceV1 {
	readonly kind: "image" | "file" | "voice" | "video";
	/** 协议给出的原始文件名；长连接的文件名来自下载响应，这里为 null。 */
	readonly name: string | null;
	readonly download?: WecomMediaDownloadV1;
}
/** 入站媒体不调用 Agent 的原因（#3227），决定回执里的固定说明。 */
export type WecomMediaRejectionReasonV1 =
	/** 当前渠道或部署不支持接收媒体（自建应用、显式回调、未装配文件面或未声明 FileLimits）。 */
	| "unsupported_channel"
	/** 按实际字节识别的类型不在 FileLimits 内，或无法确认格式。 */
	| "unsupported_type"
	/** 超过 FileLimits 交集与单文件上限中较小的一个。 */
	| "too_large"
	/** 下载地址已过有效期。 */
	| "expired"
	/** 下载、解密或写入文件面失败。 */
	| "failed";
export interface WecomMediaRejectionV1 {
	readonly reason: WecomMediaRejectionReasonV1;
	/** 仅 `too_large` 给出生效的字节上限，用于回复说明。 */
	readonly maxBytes: number | null;
}
export type WecomMediaResolutionV1 =
	| { readonly outcome: "resolved"; readonly attachments: readonly string[] }
	| ({ readonly outcome: "rejected" } & WecomMediaRejectionV1);
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
	 * 在受理事务之外解析入站媒体（工程 Spec §14.2.3）：有界下载并解密，按实际字节识别类型，
	 * 校验该企微 Channel 的 FileLimits 交集，再经 File Authority 写入 `conversationId` 下绑定
	 * 服务端解析的发送者、Agent 与 Channel 的 attachment，按 `message.media` 的顺序返回已确认的
	 * fileId。必须按绑定、稳定消息 ID 与序号幂等；不符合限制时返回 rejected，不写受理事实。
	 */
	resolve(input: {
		readonly message: WecomMessageV1;
		readonly authority: WecomAuthorityV1;
		readonly conversationId: string;
		readonly signal?: AbortSignal;
	}): Promise<WecomMediaResolutionV1>;
	/**
	 * #3374：受理被拒（繁忙、无权限、会话不可用等）或会话变化后不再使用的附件，交给 §15.4.3 的
	 * 对账有界清理（工程 Spec §14.2.4）。只处理该会话中仍未绑定任何 Message 的附件，已绑定的保持
	 * 不变；失败不改变受理结论。
	 */
	discard?(input: {
		readonly authority: WecomAuthorityV1;
		readonly conversationId: string;
		readonly attachments: readonly string[];
	}): Promise<void>;
}
export interface WecomResultFileReferenceV1 {
	readonly fileId: string;
	readonly name: string;
	readonly mediaType: string;
	readonly sizeBytes: number;
	/**
	 * #3229：`result.file` V2 的规范化工作区引用，用来把回答中的 `sandbox:` 引用对应到文件；
	 * V1 事件与 ACP image 块发布的文件为 null。
	 */
	readonly workspaceReference: string | null;
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
	| "new_conversation"
	/** 入站媒体不符合限制或当前模式不支持媒体：不调用 Agent，回复固定说明（#3227）。 */
	| "media_rejected";
export interface WecomReceiptV1 {
	readonly receiptId: string;
	readonly status: WecomReceiptStatusV1;
	readonly conversationId: string | null;
	readonly executionId: string | null;
	/**
	 * 受理为排队消息时的入队位次（工程 Spec §12.5）。只在本次受理的响应中出现、不持久化；
	 * 之后的位次从持久等待顺序派生。长连接据此发送排队提示而不是处理中提示。
	 */
	readonly queuePosition?: number;
}
/** 受理回调交给 Store 持久化的回执内容；`media_rejected` 必须同时给出拒绝原因（#3227）。 */
export type WecomAcceptanceResultV1 = Omit<WecomReceiptV1, "receiptId"> & {
	readonly mediaRejection?: WecomMediaRejectionV1;
};
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
function isWecomMediaReferenceV1(entry: unknown): boolean {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
	const media = entry as Record<string, unknown>;
	const keys = Object.keys(media).sort().join(",");
	if (
		(keys !== "kind,name" && keys !== "download,kind,name") ||
		!["image", "file", "voice", "video"].includes(media.kind as string) ||
		(media.name !== null && !isAgentManagementText(media.name, 255))
	)
		return false;
	if (keys === "kind,name") return true;
	const download = media.download;
	if (!download || typeof download !== "object" || Array.isArray(download))
		return false;
	const value = download as Record<string, unknown>;
	return (
		Object.keys(value).sort().join(",") === "aesKey,expiresAt,url" &&
		isAgentManagementText(value.url, 4096) &&
		value.url.startsWith("https://") &&
		isAgentManagementText(value.aesKey, 256) &&
		isAgentManagementText(value.expiresAt) &&
		Number.isFinite(Date.parse(value.expiresAt))
	);
}
const wecomMediaRejectionReasonsV1: readonly WecomMediaRejectionReasonV1[] = [
	"unsupported_channel",
	"unsupported_type",
	"too_large",
	"expired",
	"failed",
];
/** 只有 `too_large` 带正的字节上限，其余原因不带。 */
export function isWecomMediaRejectionV1(
	value: unknown,
): value is WecomMediaRejectionV1 {
	if (!value || typeof value !== "object") return false;
	const { reason, maxBytes } = value as Record<string, unknown>;
	return (
		wecomMediaRejectionReasonsV1.includes(
			reason as WecomMediaRejectionReasonV1,
		) &&
		(reason === "too_large"
			? Number.isSafeInteger(maxBytes) && (maxBytes as number) > 0
			: maxBytes === null)
	);
}
function wecomMegabytesV1(bytes: number) {
	const megabytes = Math.floor((bytes / 1_048_576) * 10) / 10;
	return megabytes >= 0.1
		? `${megabytes} MB`
		: `${Math.max(1, Math.floor(bytes / 1024))} KB`;
}
/** #3227：入站媒体不调用 Agent 时的固定说明，由同一回复通道发送。 */
export function wecomMediaRejectionTextV1(
	rejection: WecomMediaRejectionV1 | undefined,
): string {
	switch (rejection?.reason) {
		case "too_large":
			return `文件超过 ${wecomMegabytesV1(rejection.maxBytes ?? 0)}，未发送给 Agent`;
		case "unsupported_type":
			return "不支持该文件类型，未发送给 Agent";
		case "expired":
			return "文件下载地址已过期，未发送给 Agent，请重新发送";
		case "failed":
			return "文件接收失败，未发送给 Agent，请重新发送";
		default:
			return "当前渠道不支持接收图片、文件、语音或视频，未发送给 Agent";
	}
}
/**
 * 受理事务之外为入站媒体确定当前映射的 Conversation 的结果（#3227）。`received` 表示同一事件
 * 已有回执，调用方直接走受理重放，不再下载。
 */
export type WecomConversationPreparationV1 =
	| {
			readonly outcome: "prepared";
			readonly conversationId: string;
			/** 映射到的会话不可用或处于代次隔离中，不再接收附件。 */
			readonly unavailable: boolean;
	  }
	| { readonly outcome: "received" }
	| { readonly outcome: "denied" | "unavailable" | "conflict" };
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
		) => Promise<WecomAcceptanceResultV1>,
		signal?: AbortSignal,
	): Promise<WecomAcceptanceV1>;
	/**
	 * #3227：在受理事务之外、按与受理相同的授权复核、映射锁与当前轮次，经同一幂等
	 * `createConversation` 路径确定并单独提交当前 Conversation，供入站媒体在受理前写入附件。
	 * 不写回执；`/new` 在这里不可用。未实现时 Core 按不支持媒体处理。
	 */
	prepareConversation?(
		plan: WecomAcceptancePlanV1,
		prepare: (
			conversation: ConversationExecutionUseCaseV1,
			mapping: WecomConversationMappingV1,
		) => Promise<{
			readonly conversationId: string;
			readonly unavailable: boolean;
		}>,
		signal?: AbortSignal,
	): Promise<WecomConversationPreparationV1>;
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
						value.media.some((entry) => !isWecomMediaReferenceV1(entry)))) ||
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
				// #3227：只取序号、类型与协议文件名等稳定字段；下载地址与 aeskey 不进入摘要。
				message.media?.map((media, ordinal) => [
					ordinal,
					media.kind,
					media.name,
				]) ?? null,
				authority.actor.actorId,
			]);
			const plan: WecomAcceptancePlanV1 = {
				message,
				authority,
				eventKey,
				conversationKey,
				requestDigest,
				...(connectionFence ? { connectionFence } : {}),
			};
			const replyOpen = () => {
				if (Date.parse(message.replyExpiresAt) <= now().getTime())
					throw new Error("Invalid WeCom message");
			};
			/**
			 * 受理回调。带媒体时 `prepared` 是受理前写入附件的会话：映射在此期间被 `/new` 轮换、
			 * 或附件尚未写入时都不受理，标记后失败，由调用方重新确定会话（#3227）。
			 */
			const admit =
				(prepared?: {
					readonly conversationId: string;
					readonly attachments?: readonly string[];
					readonly retry: () => void;
				}): Parameters<WecomChannelStorePortV1["accept"]>[1] =>
				async (conversation, mapping) => {
					replyOpen();
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
					if (
						message.media?.length &&
						conversationId !== prepared?.conversationId
					) {
						prepared?.retry();
						throw new Error("WeCom conversation changed");
					}
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
					// 不可用的会话不再接收附件；附件还没写入时绝不受理不带媒体的消息。
					if (message.media?.length) {
						if (await unavailableConversation()) return unavailable;
						if (!prepared?.attachments) {
							prepared?.retry();
							throw new Error("WeCom conversation changed");
						}
					}
					const attachments = message.media?.length
						? prepared?.attachments
						: undefined;
					const decision = await conversation.accept({
						schemaVersion: 1,
						command: "message",
						conversationId,
						text: message.text,
						idempotencyKey: eventKey,
						requestId: eventKey,
						traceId: eventKey,
						...(attachments ? { attachments } : {}),
						// 排队期限不晚于该消息回复有效期结束前 30 秒（§14.2.4）。
						queueDeadlineLimit: conversationQueueDeadlineLimitV1(
							message.replyExpiresAt,
						),
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
						...(decision.outcome === "accepted" &&
						decision.result.queuePosition !== undefined
							? { queuePosition: decision.result.queuePosition }
							: {}),
					};
				};
			if (!message.media?.length)
				return dependencies.store.accept(plan, admit(), signal);
			/** 入站媒体不调用 Agent：写回执与审计，由回复通道发送固定说明（工程 Spec §14.2.3）。 */
			const rejectMedia = (mediaRejection: WecomMediaRejectionV1) =>
				dependencies.store.accept(
					plan,
					async () => {
						replyOpen();
						return {
							status: "media_rejected",
							conversationId: null,
							executionId: null,
							mediaRejection,
						};
					},
					signal,
				);
			const media = dependencies.media;
			const store = dependencies.store;
			// 只有智能机器人长连接带下载材料；其他模式、未装配文件面或 Store 不支持时如实拒绝。
			if (
				message.kind !== "wecom_bot" ||
				!media ||
				!store.prepareConversation ||
				message.media.some((entry) => !entry.download)
			)
				return rejectMedia({ reason: "unsupported_channel", maxBytes: null });
			// #3374：本次写入的附件按会话记录；没有绑定到 Message 的（受理被拒、会话变化或出错），
			// 在同一处理流程结束时交给文件对账清理，不留下长期无归属的附件。
			const written: {
				conversationId: string;
				attachments: readonly string[];
			}[] = [];
			let boundConversationId: string | null = null;
			try {
				for (let attempt = 1; ; attempt++) {
					// 下载和写入在受理事务之外：先按当前映射确定会话，附件绑定到它，受理时只绑定已确认的附件。
					const prepared = await store.prepareConversation(
						plan,
						async (conversation, mapping) => {
							replyOpen();
							const created = await conversation.createConversation({
								schemaVersion: 1,
								agentId: message.agentId,
								idempotencyKey: mapping.conversationKey,
								requestId: eventKey,
								traceId: eventKey,
							});
							if (
								created.outcome !== "accepted" &&
								created.outcome !== "replayed"
							)
								throw new Error("WeCom acceptance authorization changed");
							const conversationId = created.result.conversationId;
							const current = await conversation.readConversation({
								schemaVersion: 1,
								conversationId,
							});
							return {
								conversationId,
								unavailable:
									current.outcome === "found" &&
									(current.result.conversation.status === "unavailable" ||
										current.result.conversation.isolationPending === true),
							};
						},
						signal,
					);
					// 同一事件已有回执：直接走受理重放，不再下载，也不会重复写入附件。
					if (prepared.outcome === "received")
						return await store.accept(
							plan,
							async () => {
								throw new Error("WeCom receipt changed");
							},
							signal,
						);
					if (prepared.outcome !== "prepared")
						return { outcome: prepared.outcome };
					let attachments: readonly string[] | undefined;
					if (!prepared.unavailable) {
						let resolution: WecomMediaResolutionV1;
						try {
							resolution = await media.resolve({
								message,
								authority,
								conversationId: prepared.conversationId,
								...(signal ? { signal } : {}),
							});
						} catch {
							if (signal?.aborted) return { outcome: "unavailable" };
							return await rejectMedia({ reason: "failed", maxBytes: null });
						}
						if (signal?.aborted) return { outcome: "unavailable" };
						if (resolution.outcome === "rejected") {
							if (!isWecomMediaRejectionV1(resolution))
								throw new Error("Invalid WeCom media resolution");
							return await rejectMedia({
								reason: resolution.reason,
								maxBytes: resolution.maxBytes,
							});
						}
						if (
							resolution.outcome !== "resolved" ||
							!Array.isArray(resolution.attachments) ||
							resolution.attachments.length !== message.media.length ||
							resolution.attachments.some(
								(id) => !isAgentManagementText(id, 1024),
							) ||
							new Set(resolution.attachments).size !==
								resolution.attachments.length
						)
							throw new Error("Invalid WeCom media resolution");
						attachments = [...resolution.attachments];
						written.push({
							conversationId: prepared.conversationId,
							attachments,
						});
					}
					let changed = false;
					try {
						const result = await store.accept(
							plan,
							admit({
								conversationId: prepared.conversationId,
								...(attachments ? { attachments } : {}),
								retry: () => {
									changed = true;
								},
							}),
							signal,
						);
						if (
							(result.outcome === "accepted" ||
								result.outcome === "replayed") &&
							result.receipt.status === "accepted" &&
							result.receipt.conversationId === prepared.conversationId
						)
							boundConversationId = prepared.conversationId;
						return result;
					} catch (error) {
						if (!changed) throw error;
						// 再次变化时不再重试，明确告知用户重新发送，而不是静默丢弃。
						if (attempt >= 2)
							return await rejectMedia({ reason: "failed", maxBytes: null });
					}
				}
			} finally {
				const discard = media.discard;
				for (const entry of written)
					if (discard && entry.conversationId !== boundConversationId)
						await discard
							.call(media, {
								authority,
								conversationId: entry.conversationId,
								attachments: entry.attachments,
							})
							.catch(() => {});
			}
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
	 * 经排队受理的执行（工程 Spec §12.5）。`failureCode` 是排队消息未开始即结束时的原因
	 * （例如 `TASK_WAIT_TIMEOUT`）；仍在排队或已开始处理时为 null。
	 */
	readonly queue?: { readonly failureCode: string | null };
	/** `busy` 回执所在会话当前的排队条数，决定“排队已满”提示（§12.5）。 */
	readonly queuedCount?: number;
	/**
	 * #3077：已受理执行的回复内容是否就绪（失败、停止，或完成且答案已完整落库）。为 false 时，Store
	 * 只在回复有效期最后 {@link wecomReplyTimeoutNoticeLeadMsV1} 内领取，Core 发送固定超时提示。
	 */
	readonly answerReady?: boolean;
	/**
	 * #3374：该回执所属的只含附件的消息已与随后的消息合并为同一个任务（同一 Execution 有更晚受理的
	 * 回执）。它不等待答案，以 {@link wecomAttachmentMergedTextV1} 结束 stream，回复由最后一条承担。
	 */
	readonly merged?: boolean;
	/** 回执所属的 Conversation 已不可用；失败文案据此附带 /new 指引（#3184）。 */
	readonly conversationUnavailable?: boolean;
	/** `media_rejected` 回执的拒绝原因，决定固定说明（#3227）。 */
	readonly mediaRejection?: WecomMediaRejectionV1;
	readonly textDeltas: readonly string[];
	/**
	 * #3229：回答正文超过企微单条回复上限（约 20480 字节或 10000 条增量），Store 没有读取 `textDeltas`。
	 * 此时回复按原规则明确失败，不能只发结果文件而丢掉答案。
	 */
	readonly answerTooLong?: boolean;
	/** Result files already confirmed by File Authority for this execution. */
	readonly media?: readonly WecomResultFileReferenceV1[];
	/** #3229：回执所属的会话与执行；Worker 据此读取已确认结果文件的固定版本。 */
	readonly conversationId?: string | null;
	readonly executionId?: string | null;
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
	/**
	 * #3377：失败执行已持久的受限原因（任务原因、Dispatch 失败码、Runtime error 码、模型调用
	 * failureCode），Core 据此给出工程 Spec §16.1.1 的分类说明。不含错误正文或供应商消息。
	 */
	readonly failure?: Omit<ExecutionFailureFactsV1, "conversationUnavailable">;
	/** #3377：执行的追踪编号，内部错误说明附带；没有时用回执 ID。 */
	readonly traceId?: string | null;
}
export interface WecomDeliveryStorePortV1 {
	claim(): Promise<WecomDeliveryClaimV1 | null>;
	/**
	 * 领取后、外部发送前把回执推进到 `sending`。#3229：同一事务按发送顺序记录本次回复要发送的
	 * 媒体（进度为待发送），之后的进度经 {@link progressMedia} 逐个记录。
	 */
	prepare(
		claim: WecomDeliveryClaimV1,
		authority: WecomAuthorityV1,
		media: readonly WecomOutboundMediaV1[],
	): Promise<boolean>;
	/**
	 * #3229：按文件记录发送进度。`sending` 是发送前的意图：只有回执仍由本次领取持有、仍在发送中
	 * 且该文件尚未开始时才成功，并延长发送租约；返回 false 时不得发出该媒体。`sent`、`failed`、
	 * `unknown` 只能跟在 `sending` 之后，已受理或未确认的媒体不会再次开始，恢复时不重发。
	 */
	progressMedia(
		claim: WecomDeliveryClaimV1,
		ordinal: number,
		status: WecomMediaProgressStatusV1,
	): Promise<boolean>;
	finish(
		claim: WecomDeliveryClaimV1,
		status: "sent" | "failed" | "unknown" | "cancelled" | "expired",
	): Promise<void>;
	/**
	 * #3377：投递前复核遇到依赖暂时不可用时，不放弃也不推进回执，只把这次领取留到 `delayMs`
	 * 之后再被领取。只有回执仍由本次领取持有（fence、claimed）时生效。
	 */
	defer(claim: WecomDeliveryClaimV1, delayMs: number): Promise<void>;
	/**
	 * #3377：有效期将尽仍不能完成复核时，为不含业务内容的固定失败说明把回执推进到 `sending`。
	 * 只按已持久的事实核对：回执仍由本次领取持有且未过期、长连接持有者未变，Agent 授权修订与
	 * 渠道修订仍是受理时的值；不要求 Agent 服务就绪。修订已变化时返回 `changed`（调用方取消），
	 * 回执不再由本次领取持有时返回 `stale`。
	 */
	prepareNotice(
		claim: WecomDeliveryClaimV1,
	): Promise<"prepared" | "changed" | "stale">;
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
		/** Rechecks the original actor, channel revision and task boundary before an external effect. */
		readonly revalidate?: () => Promise<boolean>;
	}): Promise<"sent" | "failed" | "unknown">;
	/**
	 * #3377：覆盖式更新同一条回复（`finish=false`，工程 Spec §14.2.4）。每个 stream 只有一个发送者：
	 * 上一帧收到 ACK 后才发送下一帧，相邻两帧至少间隔 1 秒，等待期间只保留最新的全量内容。
	 * `prepare` 在每帧实际发送前调用（复核授权、持久化帧序号），返回 false 时丢弃该帧。
	 * 终态回复开始后不再发送任何更新。进度帧、排队提示（#3376）与补充指令提示共用这一入口。
	 * 返回 `queued` 表示已交给该 stream 的发送者；`failed` 表示回复方式不支持覆盖更新或路由已失效。
	 * 没有实现时（自建应用、显式机器人回调）只发送终态回复。
	 */
	update?(input: {
		readonly scope: WecomScopeV1;
		readonly replyHandle: string;
		readonly text: string;
		readonly prepare: () => Promise<boolean>;
	}): Promise<"queued" | "failed">;
	/**
	 * #3229：发送文本之前规划本次回复的媒体，按 `files` 的顺序逐个给出处理；返回 null 表示该回复
	 * 方式不支持媒体（自建应用、显式机器人回调或部署未装配）。规划为 `send` 的文件占用频率额度。
	 * 只有同时实现 {@link sendMedia} 时才会调用。
	 */
	planMedia?(input: {
		readonly scope: WecomScopeV1;
		readonly replyHandle: string;
		readonly files: readonly WecomOutboundMediaV1[];
	}): Promise<readonly WecomOutboundMediaPlanV1[] | null>;
	/**
	 * #3229：文本已受理后发送一个结果文件：重新核对授权与回复路由，读取已确认结果文件的固定版本，
	 * 上传临时素材并被动回复。`failed` 表示没有产生外部可见的消息，`unknown` 表示回复 ACK 丢失。
	 */
	sendMedia?(input: {
		readonly scope: WecomScopeV1;
		readonly replyHandle: string;
		readonly file: WecomOutboundMediaV1;
		/** 结果文件所属的发送者、会话与执行，供 Worker 核对文件仍是该执行已确认的结果。 */
		readonly source: {
			readonly actorId: string;
			readonly conversationId: string;
			readonly executionId: string;
		};
		readonly revalidate: () => Promise<boolean>;
	}): Promise<"sent" | "failed" | "unknown">;
}
/** #3077：长连接受理后立即发送的固定处理中提示，最终回复在同一 stream 上覆盖它。 */
export const wecomProcessingTextV1 = "已收到，正在处理…";
/** 同一会话已有任务在执行、无法受理新消息时的固定提示。 */
export const wecomBusyTextV1 = "Agent 正忙，请稍后重试";
/** #3374：附件消息并入下一条消息的任务后，以这条固定说明结束它的 stream（企微部署固定文案）。 */
export const wecomAttachmentMergedTextV1 =
	"已与下一条消息合并处理，回复见下一条";
/** #3077：回复有效期内回答仍未就绪时附在已有回答之后的固定超时提示。 */
export { wecomReplyTimeoutTextV1 } from "./wecom-reply-text.js";
/** 回复有效期结束前多久领取仍未就绪的回执，用来发送超时提示（#3077）。 */
export const wecomReplyTimeoutNoticeLeadMsV1 = 30_000;
/**
 * #3377：投递前复核遇到依赖暂时不可用时的有界指数退避（工程 Spec §14.2.4）：首次 1 秒、上限
 * 15 秒。回执每次领取都会推进 fence，因此按 fence 计算，进程重启也不会重新从头密集重试。
 */
export function wecomRevalidationBackoffMsV1(fence: number): number {
	const attempt = Number.isSafeInteger(fence) && fence > 1 ? fence - 1 : 0;
	return Math.min(15_000, 1_000 * 2 ** Math.min(attempt, 4));
}
/** 发送者用 `/new` 开始新会话后的固定回复（#3184）。 */
const wecomNewConversationTextV1 = "已开始新会话";
/** 入队与位次变化时同一 stream 上的排队提示（企微部署固定文案，§12.5）。 */
export function wecomQueuedTextV1(position: number): string {
	if (!Number.isSafeInteger(position) || position < 1)
		throw new TypeError("Queue position is invalid");
	return `已排队：第 ${position} 位，前面还有 ${position - 1} 条消息，当前回复结束后按顺序处理`;
}
/** 排队消息出队时的提示，随后按进度更新。 */
export const wecomQueueStartedTextV1 = "开始处理";
export const wecomQueueTimeoutTextV1 =
	"排队超时，等待超过时限仍未开始，本条消息未处理，请稍后重新发送";
/** 排队已满时的繁忙提示；排队条数为 0 时沿用原有繁忙提示。 */
export function wecomQueueFullTextV1(queuedCount: number): string {
	return queuedCount > 0
		? `当前会话已有 ${queuedCount} 条消息在排队，请等前面的消息处理后再发送`
		: "Agent 正忙，请稍后重试";
}
/**
 * 排队消息未开始即结束时的固定说明。会话不可用时附 `/new` 指引；仍在排队却已到回复时限的
 * 消息按排队超时处理（企微排队期限不晚于回复有效期结束前 30 秒）。
 */
function wecomQueueOutcomeTextV1(
	claim: WecomDeliveryClaimV1,
): string | undefined {
	if (!claim.queue || claim.acceptanceStatus !== "accepted") return undefined;
	if (
		claim.executionStatus === "waiting" ||
		claim.queue.failureCode === "TASK_WAIT_TIMEOUT"
	)
		return wecomQueueTimeoutTextV1;
	switch (claim.queue.failureCode) {
		case "CONVERSATION_UNAVAILABLE":
			return wecomConversationUnavailableTextV1;
		case "AGENT_UNAVAILABLE":
			return "已取消：Agent 当前不可用，本条消息未处理";
		case "AUTHORIZATION_REVOKED":
			return "已取消：权限已失效，本条消息未处理";
		default:
			return undefined;
	}
}
/**
 * 长连接排队消息在本连接持有者上仍待最终回复的回执（工程 Spec §12.5、§14.2.4）。`position`
 * 从持久等待顺序派生；已开始处理（曾被认领准入）的为 null。
 */
export interface WecomQueueNoticeV1 {
	readonly receiptId: string;
	readonly scope: WecomScopeV1;
	readonly replyHandle: string;
	readonly position: number | null;
}
export interface WecomQueueNoticeStorePortV1 {
	listQueueNotices(): Promise<readonly WecomQueueNoticeV1[]>;
}
/** 在该消息自己的 stream 上发送一帧 `finish=false` 的覆盖更新；最终回复开始后不再发送。 */
export interface WecomStreamUpdatePortV1 {
	update(input: {
		readonly scope: WecomScopeV1;
		readonly replyHandle: string;
		readonly text: string;
	}): Promise<"sent" | "failed" | "unknown">;
}

/**
 * 排队提示：入队时由受理方发送首帧并记录（{@link noted}），之后位次变化时更新同一条回复，
 * 出队时改为“开始处理”。提示帧与处理中提示一样不经回执状态机、发送失败不重发，由后续帧
 * 覆盖；回执已进入最终回复后由传输拒绝。已提示开始处理的回执不再回到排队提示（例如未提交的
 * 执行退回等待时保留原顺序，#3393）。企微流式进度（#3377）接管开始处理之后的更新。
 */
export function createWecomQueueNoticeV1(dependencies: {
	readonly store: WecomQueueNoticeStorePortV1;
	readonly sender: WecomStreamUpdatePortV1;
}) {
	const shown = new Map<string, string>();
	return {
		noted(receiptId: string, position: number) {
			shown.set(receiptId, `queued:${position}`);
		},
		async tick(): Promise<boolean> {
			const notices = await dependencies.store.listQueueNotices();
			const current = new Set<string>();
			let updated = false;
			for (const notice of notices) {
				current.add(notice.receiptId);
				const key =
					notice.position === null ? "started" : `queued:${notice.position}`;
				const last = shown.get(notice.receiptId);
				if (last === key || last === "started") continue;
				// 本进程没有提示过排队的回执不补发“开始处理”：重连后旧回复路由已失效。
				if (notice.position === null && last === undefined) {
					shown.set(notice.receiptId, key);
					continue;
				}
				updated = true;
				let result: "sent" | "failed" | "unknown" = "failed";
				try {
					result = await dependencies.sender.update({
						scope: notice.scope,
						replyHandle: notice.replyHandle,
						text:
							notice.position === null
								? wecomQueueStartedTextV1
								: wecomQueuedTextV1(notice.position),
					});
				} catch {
					/* 提示帧失败不影响执行与最终回复。 */
				}
				// 只有确认送达才记下已提示的状态；失败或无法确认时下一轮按当前状态重发同一 stream
				// （覆盖式更新，重发不会产生重复消息）。
				if (result === "sent") shown.set(notice.receiptId, key);
			}
			for (const receiptId of shown.keys())
				if (!current.has(receiptId)) shown.delete(receiptId);
			return updated;
		},
	};
}

export function createWecomDeliveryV1(dependencies: {
	readonly store: WecomDeliveryStorePortV1;
	readonly authorization: WecomAuthorizationPortV1;
	readonly sender: WecomSendPortV1;
	/**
	 * #3229：按 CommonMark 找出回答中的 `sandbox:` 引用，由企微 Adapter 提供（Core 不依赖 Markdown
	 * 解析库，解析规则与 Runtime 一致）。
	 */
	readonly answerReferences: WecomAnswerReferenceParserV1;
	readonly now?: () => Date;
}) {
	const clock = () => (dependencies.now?.() ?? new Date()).getTime();
	/** 复核领取时绑定的发送者与修订；依赖异常与暂时不可用一样不作结论。 */
	async function authorizeClaim(
		claim: WecomDeliveryClaimV1,
	): ReturnType<WecomAuthorizationPortV1["authorize"]> {
		try {
			return claim.connectionAuthorizationFact
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
		} catch {
			return { outcome: "unavailable" };
		}
	}
	/** 当前授权仍是领取时绑定的发送者、渠道修订与 Connection 事实。 */
	function sameAuthority(
		claim: WecomDeliveryClaimV1,
		current: Awaited<ReturnType<WecomAuthorizationPortV1["authorize"]>>,
	): current is Extract<typeof current, { readonly outcome: "allowed" }> {
		return (
			current.outcome === "allowed" &&
			current.authority.actor.actorId === claim.actorId &&
			current.authority.channelRevision === claim.channelRevision &&
			sameWecomConnectionAuthorizationFactV1(
				current.authority.connectionAuthorizationFact,
				claim.connectionAuthorizationFact,
			)
		);
	}
	/** 回执的固定文案或答案；答案与超时定稿只取已落库的正文。 */
	function replyText(claim: WecomDeliveryClaimV1, timedOut: boolean): string {
		switch (claim.acceptanceStatus) {
			case "media_rejected":
				return wecomMediaRejectionTextV1(claim.mediaRejection);
			case "busy":
				// #3376：排队已满时说明当前排队条数。
				return wecomQueueFullTextV1(claim.queuedCount ?? 0);
			case "unavailable":
				return wecomConversationUnavailableTextV1;
			case "new_conversation":
				return wecomNewConversationTextV1;
		}
		// #3377：有效期结束前 30 秒仍未到终态时，在当前 stream 定稿：保留已有回答，附固定超时提示。
		if (timedOut)
			return composeWecomBoundedTextV1({
				answer: partialWecomAnswerV1(
					claim.textDeltas.join(""),
					dependencies.answerReferences,
				),
				answerComplete: !claim.answerTooLong,
				tail: wecomReplyTimeoutTextV1,
			});
		if (claim.executionStatus === "completed") return claim.textDeltas.join("");
		if (claim.executionStatus === "cancelled") return "本次任务已停止";
		// #3377：失败说明按已持久的受限原因归入 §16.1.1 的分类。
		return wecomExecutionFailureTextV1(
			classifyExecutionFailureV1({
				...claim.failure,
				conversationUnavailable: claim.conversationUnavailable === true,
			}),
			claim.traceId ?? claim.receiptId,
		);
	}
	/**
	 * #3377：有效期结束前 30 秒仍不能完成复核时，改发不含业务内容的固定失败说明（内部错误类，
	 * 附追踪编号）并结束 stream，不静默过期。Store 只按已持久的事实核对回执、连接持有者与修订；
	 * 复核确认主体禁用、权限撤销或修订变化时仍取消。
	 */
	async function deliverRevalidationNotice(claim: WecomDeliveryClaimV1) {
		const prepared = await dependencies.store.prepareNotice(claim);
		if (prepared === "changed") {
			await dependencies.store.finish(claim, "cancelled");
			return;
		}
		if (prepared !== "prepared") return;
		let status: "sent" | "failed" | "unknown";
		try {
			status = await dependencies.sender.send({
				scope: claim.scope,
				replyHandle: claim.replyHandle,
				text: wecomExecutionFailureTextV1(
					"internal_error",
					claim.traceId ?? claim.receiptId,
				),
				revalidate: async () => {
					const latest = await authorizeClaim(claim);
					return (
						latest.outcome === "unavailable" || sameAuthority(claim, latest)
					);
				},
			});
		} catch {
			status = "unknown";
		}
		await dependencies.store.finish(claim, status);
	}
	return {
		async dispatch(): Promise<boolean> {
			const claim = await dependencies.store.claim();
			if (!claim) return false;
			const expiresAt = Date.parse(claim.replyExpiresAt);
			if (expiresAt <= clock()) {
				await dependencies.store.finish(claim, "expired");
				return true;
			}
			const current = await authorizeClaim(claim);
			if (current.outcome === "unavailable") {
				// #3377：依赖暂时不可用时不放弃回执：有效期内退避后重新领取复核，最后 30 秒改发固定说明。
				const room = expiresAt - wecomReplyTimeoutNoticeLeadMsV1 - clock();
				if (room > 0)
					await dependencies.store.defer(
						claim,
						Math.min(wecomRevalidationBackoffMsV1(claim.fence), room),
					);
				else await deliverRevalidationNotice(claim);
				return true;
			}
			if (!sameAuthority(claim, current)) {
				await dependencies.store.finish(claim, "cancelled");
				return true;
			}
			// #3374：附件消息已并入下一条消息的任务，以固定说明结束它的 stream，回复由下一条承担。
			const merged =
				claim.acceptanceStatus === "accepted" && claim.merged === true;
			// #3077：回答在有效期内没有就绪时，结束本次回复并明确提示超时，不静默过期。
			// 排队消息未开始即结束（含排队到回复时限）时给出排队结果，不按回复超时处理（§12.5）。
			const queueOutcome = wecomQueueOutcomeTextV1(claim);
			const timedOut =
				claim.acceptanceStatus === "accepted" &&
				!merged &&
				claim.answerReady === false &&
				queueOutcome === undefined;
			const answered =
				claim.acceptanceStatus === "accepted" &&
				!merged &&
				!timedOut &&
				queueOutcome === undefined &&
				claim.executionStatus === "completed";
			// 合并说明与排队结果优先，其余按回执状态与执行结果组合（#3374、#3376、#3377）。
			let text = merged
				? wecomAttachmentMergedTextV1
				: (queueOutcome ?? replyText(claim, timedOut));
			// #3229：只有完成的回答带结果文件。先规划哪些文件会发送（文本先于媒体），再把回答中的
			// `sandbox:` 引用改写为文件名与说明；不支持媒体的回复方式去掉结果文件，文本照常发送。
			let media: readonly WecomOutboundMediaV1[] = [];
			let rewriteThinking:
				| ((content: string) => string | undefined)
				| undefined;
			if (answered) {
				// 答案本身超过单条回复上限时按原规则明确失败，不能只发结果文件。
				if (claim.answerTooLong) {
					await dependencies.store.finish(claim, "failed");
					return true;
				}
				const planned = await planReplyMedia(claim, text);
				if (planned === "retry") return true;
				if (planned === "invalid") {
					await dependencies.store.finish(claim, "failed");
					return true;
				}
				text = planned.text;
				media = planned.media;
				rewriteThinking = planned.rewriteThinking;
			}
			if (!text || Buffer.byteLength(text) > wecomReplyMaximumBytesV1) {
				await dependencies.store.finish(claim, "failed");
				return true;
			}
			// #2982：只有完成且有答案的回复组合思考过程；固定文案与只有文件的回复不附带。
			const textWithThinking =
				answered && claim.textDeltas.join("") && claim.thinking
					? composeWecomThinkingReplyV1(text, claim.thinking, rewriteThinking)
					: undefined;
			if (!(await dependencies.store.prepare(claim, current.authority, media)))
				return true;
			const revalidate = async () =>
				sameAuthority(claim, await authorizeClaim(claim));
			let status: "sent" | "failed" | "unknown";
			try {
				status = await dependencies.sender.send({
					scope: claim.scope,
					replyHandle: claim.replyHandle,
					text,
					...(textWithThinking ? { textWithThinking } : {}),
					revalidate,
				});
			} catch {
				status = "unknown";
			}
			// 文本未明确受理时不发送媒体：什么都没发出为 failed，ACK 丢失保持 unknown。
			if (status === "sent" && media.length)
				status = await deliverMedia(claim, media, revalidate);
			await dependencies.store.finish(claim, status);
			return true;
		},
	};

	/**
	 * 规划本次回复的结果文件并改写回答。`retry` 表示规划依赖暂时不可用，留待重新领取；`invalid`
	 * 表示无法确认回答中的引用，不发送。
	 */
	async function planReplyMedia(
		claim: WecomDeliveryClaimV1,
		answer: string,
	): Promise<
		| {
				readonly text: string;
				readonly media: readonly WecomOutboundMediaV1[];
				/** 思考过程中的 `sandbox:` 引用按同样的规划改写；无法确认时返回 undefined，不附带思考过程。 */
				readonly rewriteThinking: (content: string) => string | undefined;
		  }
		| "retry"
		| "invalid"
	> {
		const files = claim.media ?? [];
		const parse = (content: string) =>
			parseWecomAnswerReferencesV1(content, dependencies.answerReferences);
		let references: ReturnType<typeof parseWecomAnswerReferencesV1>;
		try {
			references = parse(answer);
		} catch {
			return "invalid";
		}
		const ordered = orderWecomResultFilesV1(files, references);
		const skipped = new Map<string, WecomOutboundMediaSkipReasonV1>();
		const rewriteThinking = (content: string) => {
			try {
				return rewriteWecomAnswerV1({
					answer: content,
					references: parse(content),
					files: ordered,
					skipped,
					appendUnreferenced: false,
				});
			} catch {
				return undefined;
			}
		};
		if (files.length === 0 && references.length === 0)
			return { text: answer, media: [], rewriteThinking };
		const candidates: WecomOutboundMediaV1[] = [];
		for (const file of ordered) {
			const kind = wecomOutboundMediaKindV1(file);
			if (!kind || candidates.length >= wecomReplyMediaMaxCountV1)
				skipped.set(file.fileId, "exceeds_limit");
			else candidates.push({ ...file, kind });
		}
		const sender = dependencies.sender;
		let plans: readonly WecomOutboundMediaPlanV1[] | null = null;
		if (
			candidates.length &&
			sender.planMedia &&
			sender.sendMedia &&
			claim.conversationId &&
			claim.executionId
		) {
			try {
				plans = await sender.planMedia({
					scope: claim.scope,
					replyHandle: claim.replyHandle,
					files: candidates,
				});
			} catch {
				return "retry";
			}
			if (
				plans !== null &&
				(!Array.isArray(plans) ||
					plans.length !== candidates.length ||
					plans.some(
						(plan) =>
							![
								"send",
								"unsupported_type",
								"exceeds_limit",
								"rate_limited",
							].includes(plan),
					))
			)
				return "invalid";
		}
		const media: WecomOutboundMediaV1[] = [];
		for (const [index, file] of candidates.entries()) {
			const plan = plans?.[index];
			if (plan === "send") media.push(file);
			else skipped.set(file.fileId, plan ?? "unsupported_channel");
		}
		return {
			text: rewriteWecomAnswerV1({
				answer,
				references,
				files: ordered,
				skipped,
				maxBytes: wecomReplyMaximumBytesV1,
			}),
			media,
			rewriteThinking,
		};
	}

	/**
	 * 文本已受理后按顺序逐个发送媒体，每个文件先记录发送意图再产生外部效果。撤权、绑定变化或
	 * 回执不再由本次领取持有时，未发送的媒体不再发出。全部受理为 sent，否则为 unknown。
	 */
	async function deliverMedia(
		claim: WecomDeliveryClaimV1,
		media: readonly WecomOutboundMediaV1[],
		revalidate: () => Promise<boolean>,
	): Promise<"sent" | "unknown"> {
		const { conversationId, executionId } = claim;
		const sendMedia = dependencies.sender.sendMedia;
		if (!conversationId || !executionId || !sendMedia) return "unknown";
		let complete = true;
		for (const [ordinal, file] of media.entries()) {
			try {
				if (
					!(await revalidate()) ||
					!(await dependencies.store.progressMedia(claim, ordinal, "sending"))
				)
					return "unknown";
			} catch {
				return "unknown";
			}
			let outcome: "sent" | "failed" | "unknown";
			try {
				outcome = await sendMedia({
					scope: claim.scope,
					replyHandle: claim.replyHandle,
					file,
					source: { actorId: claim.actorId, conversationId, executionId },
					revalidate,
				});
			} catch {
				outcome = "unknown";
			}
			if (outcome !== "sent") complete = false;
			try {
				if (!(await dependencies.store.progressMedia(claim, ordinal, outcome)))
					complete = false;
			} catch {
				complete = false;
			}
		}
		return complete ? "sent" : "unknown";
	}
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
						// #3374：智能机器人入站按会话保序，只含附件的消息与随后的消息合并为一个任务。
						...(scope.kind === "wecom_bot"
							? { attachmentMergeWindow: true as const }
							: {}),
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
