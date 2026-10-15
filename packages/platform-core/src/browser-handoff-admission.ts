import { createHash } from "node:crypto";
import type { ConversationExecutionAuthorityV1 } from "./conversation-execution-types.js";

export type BrowserHandoffCommandV1 =
	| {
			readonly schemaVersion: 1;
			readonly command: "take_over" | "return_to_agent" | "revoke";
			readonly handoffId: string;
	  }
	| {
			readonly schemaVersion: 1;
			readonly command:
				| "pause"
				| "confirm_side_effect"
				| "reject_side_effect"
				| "cancel_side_effect";
			readonly handoffId?: string;
			readonly confirmationId?: string;
	  };

export type BrowserHandoffAdmissionRequestV1 = Readonly<{
	schemaVersion: 1;
	conversationId: string;
	command: BrowserHandoffCommandV1;
	idempotencyKey: string;
	requestId: string;
	traceId: string;
}>;

export type BrowserHandoffAdmissionActiveExecutionV1 = Readonly<{
	executionId: string;
	turnId: string;
	sessionGeneration: number;
	deliveryFence: number;
	status: "submitted" | "processing" | "unknown";
}>;

export type BrowserHandoffAdmissionStateV1 = Readonly<{
	conversation: {
		readonly schemaVersion: 1;
		readonly conversationId: string;
		readonly agentId: string;
		readonly actorId: string;
		readonly channelId: string;
		readonly sessionGeneration: number;
		readonly hostSessionRef: string;
		readonly authorizationRevision: string;
		readonly status: "ready" | "active";
	};
	activeExecution: BrowserHandoffAdmissionActiveExecutionV1 | null;
}>;

export type BrowserHandoffAdmissionPlanV1 = Readonly<{
	schemaVersion: 1;
	kind: "browser-handoff";
	conversationId: string;
	agentId: string;
	actorId: string;
	channelId: string;
	executionId: string;
	turnId: string;
	sessionGeneration: number;
	deliveryFence: number;
	hostSessionRef: string;
	command: BrowserHandoffCommandV1;
	outbox: {
		readonly id: string;
		readonly operation: "conversation.browser.handoff.v1";
		readonly payload: {
			readonly schemaVersion: 1;
			readonly conversationId: string;
			readonly agentId: string;
			readonly actorId: string;
			readonly channelId: string;
			readonly executionId: string;
			readonly turnId: string;
			readonly sessionGeneration: number;
			readonly deliveryFence: number;
			readonly command: BrowserHandoffCommandV1;
		};
		readonly requestId: string;
		readonly traceId: string;
	};
	result: {
		readonly schemaVersion: 1;
		readonly status: "submitted";
		readonly conversationId: string;
		readonly executionId: string;
		readonly command: BrowserHandoffCommandV1["command"];
	};
	idempotency: {
		readonly scopeType: "conversation";
		readonly scopeId: string;
		readonly actorId: string;
		readonly key: string;
		readonly requestDigest: string;
	};
}>;

export type BrowserHandoffAdmissionDecisionV1 =
	| {
			readonly outcome: "accepted" | "replayed";
			readonly plan: BrowserHandoffAdmissionPlanV1;
	  }
	| {
			readonly outcome:
				| "busy"
				| "denied"
				| "stale"
				| "unavailable"
				| "unsupported";
			readonly reason?:
				| "authorization_lost"
				| "conversation_unavailable"
				| "idempotency_conflict";
	  }
	| { readonly outcome: "conflict"; readonly reason: "idempotency_conflict" };

export interface BrowserHandoffAdmissionTransactionPortV1 {
	admit(
		request: {
			readonly command: BrowserHandoffAdmissionRequestV1;
			readonly authority: ConversationExecutionAuthorityV1;
			readonly requestDigest: string;
		},
		decide: (
			state: BrowserHandoffAdmissionStateV1,
		) => Promise<
			| BrowserHandoffAdmissionPlanV1
			| Exclude<
					BrowserHandoffAdmissionDecisionV1,
					{ outcome: "accepted" | "replayed" }
			  >
		>,
		isAuthorized: () => Promise<boolean>,
	): Promise<BrowserHandoffAdmissionDecisionV1>;
}

export interface BrowserHandoffAdmissionUseCaseV1 {
	admit(
		request: BrowserHandoffAdmissionRequestV1,
	): Promise<BrowserHandoffAdmissionDecisionV1>;
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function browserHandoffAdmissionRequestDigestV1(
	request: BrowserHandoffAdmissionRequestV1,
): string {
	return digest({
		schemaVersion: 1,
		command: "browser.handoff",
		conversationId: request.conversationId,
		commandBody: request.command,
	});
}

function validText(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function validCommand(
	command: BrowserHandoffCommandV1,
): command is Extract<
	BrowserHandoffCommandV1,
	{ readonly command: "take_over" | "return_to_agent" | "revoke" }
> {
	return (
		command.schemaVersion === 1 &&
		(command.command === "take_over" ||
			command.command === "return_to_agent" ||
			command.command === "revoke") &&
		validText(command.handoffId)
	);
}

export function createBrowserHandoffAdmissionUseCaseV1(dependencies: {
	authorization: {
		authorize(input: {
			schemaVersion: 1;
			operation: "browser.handoff";
			conversationId: string;
		}): Promise<
			| {
					readonly outcome: "allowed";
					readonly authority: ConversationExecutionAuthorityV1;
			  }
			| { readonly outcome: "denied" }
		>;
	};
	state: {
		read(
			conversationId: string,
		): Promise<BrowserHandoffAdmissionStateV1 | null>;
	};
	transaction: BrowserHandoffAdmissionTransactionPortV1;
}): BrowserHandoffAdmissionUseCaseV1 {
	return {
		async admit(request) {
			if (
				request.schemaVersion !== 1 ||
				!validText(request.conversationId) ||
				!validText(request.idempotencyKey) ||
				!validText(request.requestId) ||
				!validText(request.traceId) ||
				!validCommand(request.command)
			)
				return { outcome: "unavailable", reason: "conversation_unavailable" };
			const authorized = await dependencies.authorization.authorize({
				schemaVersion: 1,
				operation: "browser.handoff",
				conversationId: request.conversationId,
			});
			if (authorized.outcome !== "allowed")
				return { outcome: "denied", reason: "authorization_lost" };
			const authority = authorized.authority;
			const requestDigest = browserHandoffAdmissionRequestDigestV1(request);
			const decision = await dependencies.transaction.admit(
				{ command: request, authority, requestDigest },
				async (state) => {
					const active = state.activeExecution;
					const conversation = state.conversation;
					if (
						conversation.conversationId !== request.conversationId ||
						conversation.actorId !== authority.actorId ||
						conversation.agentId !== authority.agentId ||
						conversation.channelId !== authority.channelId ||
						conversation.authorizationRevision !==
							authority.authorizationRevision ||
						!validText(conversation.hostSessionRef)
					)
						return { outcome: "denied", reason: "authorization_lost" };
					if (!active)
						return {
							outcome: "unavailable",
							reason: "conversation_unavailable",
						};
					if (active.sessionGeneration !== conversation.sessionGeneration)
						return { outcome: "stale" };
					if (active.status === "unknown") return { outcome: "busy" };
					const executionId = active.executionId;
					const command = request.command;
					const plan: BrowserHandoffAdmissionPlanV1 = {
						schemaVersion: 1,
						kind: "browser-handoff",
						conversationId: conversation.conversationId,
						agentId: conversation.agentId,
						actorId: conversation.actorId,
						channelId: conversation.channelId,
						executionId,
						turnId: active.turnId,
						sessionGeneration: conversation.sessionGeneration,
						deliveryFence: active.deliveryFence,
						hostSessionRef: conversation.hostSessionRef,
						command,
						outbox: {
							id: `conversation:browser-handoff:${digest({
								conversationId: conversation.conversationId,
								actorId: authority.actorId,
								idempotencyKey: request.idempotencyKey,
							})}`,
							operation: "conversation.browser.handoff.v1",
							payload: {
								schemaVersion: 1,
								conversationId: conversation.conversationId,
								agentId: conversation.agentId,
								actorId: conversation.actorId,
								channelId: conversation.channelId,
								executionId,
								turnId: active.turnId,
								sessionGeneration: conversation.sessionGeneration,
								deliveryFence: active.deliveryFence,
								command,
							},
							requestId: request.requestId,
							traceId: request.traceId,
						},
						result: {
							schemaVersion: 1,
							status: "submitted",
							conversationId: conversation.conversationId,
							executionId,
							command: command.command,
						},
						idempotency: {
							scopeType: "conversation",
							scopeId: conversation.conversationId,
							actorId: authority.actorId,
							key: request.idempotencyKey,
							requestDigest,
						},
					};
					return plan;
				},
				async () => {
					try {
						const current = await dependencies.authorization.authorize({
							schemaVersion: 1,
							operation: "browser.handoff",
							conversationId: request.conversationId,
						});
						return (
							current.outcome === "allowed" &&
							current.authority.actorId === authority.actorId &&
							current.authority.agentId === authority.agentId &&
							current.authority.channelId === authority.channelId &&
							current.authority.authorizationRevision ===
								authority.authorizationRevision
						);
					} catch {
						return false;
					}
				},
			);
			return decision;
		},
	};
}
