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
	| "new_conversation"
	/** 入站媒体不符合限制或当前模式不支持媒体：不调用 Agent，回复固定说明（#3227）。 */
	| "media_rejected";
export interface WecomReceiptV1 {
	readonly receiptId: string;
	readonly status: WecomReceiptStatusV1;
	readonly conversationId: string | null;
	readonly executionId: string | null;
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
					return store.accept(
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
						return rejectMedia({ reason: "failed", maxBytes: null });
					}
					if (signal?.aborted) return { outcome: "unavailable" };
					if (resolution.outcome === "rejected") {
						if (!isWecomMediaRejectionV1(resolution))
							throw new Error("Invalid WeCom media resolution");
						return rejectMedia({
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
				}
				let changed = false;
				try {
					return await store.accept(
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
				} catch (error) {
					if (!changed) throw error;
					// 再次变化时不再重试，明确告知用户重新发送，而不是静默丢弃。
					if (attempt >= 2)
						return rejectMedia({ reason: "failed", maxBytes: null });
				}
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
	 * #3077：已受理执行的回复内容是否就绪（失败、停止，或完成且答案已完整落库）。为 false 时，Store
	 * 只在回复有效期最后 {@link wecomReplyTimeoutNoticeLeadMsV1} 内领取，Core 发送固定超时提示。
	 */
	readonly answerReady?: boolean;
	/** 回执所属的 Conversation 已不可用；失败文案据此附带 /new 指引（#3184）。 */
	readonly conversationUnavailable?: boolean;
	/** `media_rejected` 回执的拒绝原因，决定固定说明（#3227）。 */
	readonly mediaRejection?: WecomMediaRejectionV1;
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
				claim.acceptanceStatus === "media_rejected"
					? wecomMediaRejectionTextV1(claim.mediaRejection)
					: claim.acceptanceStatus === "busy"
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
