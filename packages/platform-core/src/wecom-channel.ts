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
export interface WecomMessageV1 extends WecomScopeV1 {
	/** Stable provider receiver identity, independent of a replacement binding reference. */
	readonly providerId: string;
	readonly eventId: string;
	readonly text: string;
	/** Opaque encrypted route; never exposed to the Runtime or browser. */
	readonly replyHandle: string;
	readonly replyExpiresAt: string;
}
export interface WecomAuthorityV1 {
	readonly actor: ConversationExecutionAuthorityV1 & {
		readonly taskBoundary: TaskAuthorizationBoundaryV1;
	};
	readonly channelRevision: string;
	readonly managementRevision: number;
}
export interface WecomAuthorizationPortV1 {
	authorize(
		scope: WecomScopeV1,
		operation?: "use" | "read",
		originalBoundary?: TaskAuthorizationBoundaryV1,
	): Promise<
		| { readonly outcome: "allowed"; readonly authority: WecomAuthorityV1 }
		| { readonly outcome: "denied" | "unavailable"; readonly actorId?: string }
	>;
}
export type WecomReceiptStatusV1 = "accepted" | "busy" | "unavailable";
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
	readonly conversationKey: string;
	readonly requestDigest: string;
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
		) => Promise<Omit<WecomReceiptV1, "receiptId">>,
	): Promise<WecomAcceptanceV1>;
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
}) {
	return {
		async receive(
			input: WecomMessageV1,
			connectionFence?: WecomConnectionFenceV1,
		): Promise<WecomAcceptanceV1> {
			const value = snapshotAgentManagementDataObject(input);
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
				!isAgentManagementText(value.text, 32768) ||
				!isAgentManagementText(value.replyHandle, 12000) ||
				!isAgentManagementText(value.replyExpiresAt) ||
				!Number.isFinite(Date.parse(value.replyExpiresAt as string)) ||
				(value.threadId !== null && !isAgentManagementText(value.threadId)) ||
				!["wecom_bot", "wecom_app"].includes(value.kind as string) ||
				!["single", "group"].includes(value.conversationType as string)
			)
				throw new Error("Invalid WeCom message");
			const message = { ...value } as unknown as WecomMessageV1;
			const identity = await dependencies.authorization.authorize(message);
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
			)
				return { outcome: "denied" };
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
				async (conversation) => {
					const created = await conversation.createConversation({
						schemaVersion: 1,
						agentId: message.agentId,
						idempotencyKey: conversationKey,
						requestId: eventKey,
						traceId: eventKey,
					});
					if (created.outcome !== "accepted" && created.outcome !== "replayed")
						throw new Error("WeCom acceptance authorization changed");
					const decision = await conversation.accept({
						schemaVersion: 1,
						command: "message",
						conversationId: created.result.conversationId,
						text: message.text,
						idempotencyKey: eventKey,
						requestId: eventKey,
						traceId: eventKey,
					});
					if (decision.outcome === "busy")
						return {
							status: "busy",
							conversationId: created.result.conversationId,
							executionId: null,
						};
					if (
						decision.outcome !== "accepted" &&
						decision.outcome !== "replayed"
					)
						throw new Error("WeCom acceptance authorization changed");
					return {
						status: "accepted",
						conversationId: created.result.conversationId,
						executionId: decision.result.executionId,
					};
				},
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
	readonly acceptanceStatus: WecomReceiptStatusV1;
	readonly executionStatus: string | null;
	readonly textDeltas: readonly string[];
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
	}): Promise<"sent" | "failed" | "unknown">;
}
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
			const current = await dependencies.authorization.authorize(
				claim.scope,
				"use",
				claim.taskBoundary,
			);
			if (
				current.outcome !== "allowed" ||
				current.authority.actor.actorId !== claim.actorId ||
				current.authority.channelRevision !== claim.channelRevision
			) {
				await dependencies.store.finish(claim, "cancelled");
				return true;
			}
			const text =
				claim.acceptanceStatus === "busy"
					? "Agent 正忙，请稍后重试"
					: claim.acceptanceStatus === "unavailable"
						? "Agent 当前不可用，请稍后重试"
						: claim.executionStatus === "completed"
							? claim.textDeltas.join("")
							: claim.executionStatus === "cancelled"
								? "本次任务已停止"
								: "本次任务执行失败，请稍后重试";
			if (!text || Buffer.byteLength(text) > 20_480) {
				await dependencies.store.finish(claim, "failed");
				return true;
			}
			if (!(await dependencies.store.prepare(claim, current.authority)))
				return true;
			let status: "sent" | "failed" | "unknown";
			try {
				status = await dependencies.sender.send({
					scope: claim.scope,
					replyHandle: claim.replyHandle,
					text,
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
	readonly configuration: import("./agent-configuration.js").AgentConfigurationRecordV2;
	readonly authorizationRevision: string;
}
export interface WecomAuthorityStatePortV1 {
	readAuthorityState(agentId: string): Promise<WecomAuthorityStateV1 | null>;
}
export function createWecomAuthorizationV1(dependencies: {
	readonly identity: WecomIdentityPortV1;
	readonly state: WecomAuthorityStatePortV1;
}): WecomAuthorizationPortV1 {
	return {
		async authorize(scope, operation, originalBoundary) {
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
						b.bindingReference === scope.bindingReference,
				) ||
				(configuration.source.kind === "custom" &&
					configuration.source.interactionMode !== "platform-adapter")
			)
				return { outcome: "denied", actorId: actor.userId };
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
					!isTaskAuthorizationCurrentV1({
						boundary: originalBoundary,
						user: actor,
						agent: management,
					})) ||
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
