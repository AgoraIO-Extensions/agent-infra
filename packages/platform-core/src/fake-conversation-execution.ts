import {
	type ConversationCommandDecisionV1,
	type ConversationExecutionAuthorityV1,
	type ConversationExecutionAuthorizationPortV1,
	type ConversationExecutionStateV1,
	type ConversationExecutionTransactionPortV1,
	type ConversationExecutionUseCaseOptionsV1,
	type ConversationExecutionUseCaseV1,
	type ConversationMessageWritePlanV1,
	type ConversationRegenerationWritePlanV1,
	type ConversationStopDecisionV1,
	type ConversationStopWritePlanV1,
	type CreateConversationDecisionV1,
	createConversationExecutionUseCaseV1,
} from "./conversation-execution.js";

export interface FakeConversationExecutionOptionsV1
	extends ConversationExecutionUseCaseOptionsV1 {
	readonly authority?: ConversationExecutionAuthorityV1;
	readonly authorization?: ConversationExecutionAuthorizationPortV1;
}

interface StoredIdempotency<T> {
	readonly requestDigest: string;
	readonly decision: T;
}

interface StoredMessage {
	readonly messageId: string;
	readonly conversationId: string;
	readonly actorId: string;
	readonly role: "user";
	readonly executionId: string;
	readonly text: string;
}

interface StoredExecution {
	readonly executionId: string;
	readonly conversationId: string;
	readonly actorId: string;
	readonly turnId: string;
	status:
		| "submitted"
		| "processing"
		| "unknown"
		| "completed"
		| "failed"
		| "cancelled";
}

interface StoredOutbox {
	readonly operation: string;
	readonly executionId: string;
	readonly sessionGeneration: number;
	readonly messageId?: string;
	readonly stopRequestId?: string;
}

interface StoredStop {
	readonly executionId: string;
	readonly stopRequestId: string;
	status: "submitted" | "completed";
}

interface StoredAudit {
	readonly action: string;
	readonly actorId: string;
	readonly traceId: string;
	readonly requestId: string;
}

function key(parts: readonly string[]): string {
	return JSON.stringify(parts);
}

function defaultAuthorization(
	authority: ConversationExecutionAuthorityV1 | undefined,
): ConversationExecutionAuthorizationPortV1 {
	return {
		async authorize() {
			return authority
				? { outcome: "allowed", authority: structuredClone(authority) }
				: { outcome: "denied" };
		},
	};
}

function isMessageWritePlan(
	decision:
		| ConversationMessageWritePlanV1
		| { readonly outcome: "busy" | "denied" },
): decision is ConversationMessageWritePlanV1 {
	return !Object.hasOwn(decision, "outcome");
}

function isRegenerationWritePlan(
	decision:
		| ConversationRegenerationWritePlanV1
		| { readonly outcome: "busy" | "denied" },
): decision is ConversationRegenerationWritePlanV1 {
	return !Object.hasOwn(decision, "outcome");
}

function isStopWritePlan(
	decision:
		| ConversationStopWritePlanV1
		| Extract<
				ConversationStopDecisionV1,
				{ outcome: "accepted" | "replayed" | "denied" }
		  >,
): decision is ConversationStopWritePlanV1 {
	return !Object.hasOwn(decision, "outcome");
}

function isActiveExecution(execution: StoredExecution): boolean {
	return (
		execution.status === "submitted" ||
		execution.status === "processing" ||
		execution.status === "unknown"
	);
}

function isCurrentConversationBinding(
	conversation: ConversationExecutionStateV1["conversation"],
	authority: ConversationExecutionAuthorityV1,
	conversationId: string,
): boolean {
	return (
		conversation !== undefined &&
		conversation.conversationId === conversationId &&
		conversation.actorId === authority.actorId &&
		conversation.agentId === authority.agentId &&
		conversation.channelId === authority.channelId
	);
}

export class FakeConversationExecutionV1
	implements ConversationExecutionUseCaseV1
{
	readonly #conversations = new Map<
		string,
		ConversationExecutionStateV1["conversation"]
	>();
	readonly #messages: StoredMessage[] = [];
	readonly #executions: StoredExecution[] = [];
	readonly #stops: StoredStop[] = [];
	readonly #outbox: StoredOutbox[] = [];
	readonly #audit: StoredAudit[] = [];
	readonly #createIdempotency = new Map<
		string,
		StoredIdempotency<CreateConversationDecisionV1>
	>();
	readonly #commandIdempotency = new Map<
		string,
		StoredIdempotency<ConversationCommandDecisionV1>
	>();
	readonly #stopIdempotency = new Map<
		string,
		StoredIdempotency<ConversationStopDecisionV1>
	>();
	readonly #interface: ConversationExecutionUseCaseV1;

	constructor(options: FakeConversationExecutionOptionsV1 = {}) {
		const transaction: ConversationExecutionTransactionPortV1 = {
			createConversation: async (request, decide) => {
				const idempotencyKey = key([
					request.authority.agentId,
					request.authority.actorId,
					request.authority.channelId,
					request.command.idempotencyKey,
				]);
				const existing = this.#createIdempotency.get(idempotencyKey);
				if (existing) {
					if (existing.requestDigest !== request.requestDigest) {
						return { outcome: "conflict", reason: "idempotency_conflict" };
					}
					if (existing.decision.outcome !== "accepted") {
						throw new Error("Invalid Fake create idempotency state");
					}
					return {
						outcome: "replayed",
						result: structuredClone(existing.decision.result),
					};
				}
				const plan = decide();
				this.#conversations.set(
					plan.conversation.conversationId,
					structuredClone(plan.conversation),
				);
				const decision = {
					outcome: "accepted",
					result: structuredClone(plan.result),
				} as const;
				this.#createIdempotency.set(idempotencyKey, {
					requestDigest: request.requestDigest,
					decision,
				});
				return decision;
			},
			executeMessage: async (request, decide) => {
				if (
					!isCurrentConversationBinding(
						this.#conversations.get(request.command.conversationId),
						request.authority,
						request.command.conversationId,
					)
				) {
					return { outcome: "denied" };
				}
				const idempotencyKey = key([
					request.command.conversationId,
					request.authority.actorId,
					request.command.command,
					request.command.idempotencyKey,
				]);
				const existing = this.#commandIdempotency.get(idempotencyKey);
				if (existing) {
					if (existing.requestDigest !== request.requestDigest) {
						return { outcome: "conflict", reason: "idempotency_conflict" };
					}
					if (existing.decision.outcome === "accepted") {
						return {
							outcome: "replayed",
							result: structuredClone(existing.decision.result),
						};
					}
					return structuredClone(existing.decision);
				}
				const decision = decide(this.#state(request.command.conversationId));
				if (!isMessageWritePlan(decision)) {
					if (decision.outcome === "denied") return decision;
					this.#commandIdempotency.set(idempotencyKey, {
						requestDigest: request.requestDigest,
						decision,
					});
					return decision;
				}
				const plan: ConversationMessageWritePlanV1 = decision;
				this.#conversations.set(
					plan.conversation.conversationId,
					structuredClone(plan.conversation),
				);
				this.#messages.push({
					messageId: plan.message.messageId,
					conversationId: plan.message.conversationId,
					actorId: plan.message.actorId,
					role: "user",
					executionId: plan.message.executionId,
					text: plan.message.text,
				});
				if (plan.execution) {
					this.#executions.push({
						executionId: plan.execution.executionId,
						conversationId: plan.execution.conversationId,
						actorId: plan.execution.actorId,
						turnId: plan.execution.turnId,
						status: plan.execution.status,
					});
				}
				this.#outbox.push({
					operation: plan.outboxIntent.operation,
					executionId: plan.outboxIntent.executionId,
					sessionGeneration: plan.outboxIntent.sessionGeneration,
					messageId: plan.outboxIntent.messageId,
				});
				this.#audit.push({
					action: plan.auditEvent.action,
					actorId: plan.auditEvent.actorId,
					traceId: plan.auditEvent.traceId,
					requestId: plan.auditEvent.requestId,
				});
				const accepted = {
					outcome: "accepted",
					result: structuredClone(plan.result),
				} as const;
				this.#commandIdempotency.set(idempotencyKey, {
					requestDigest: request.requestDigest,
					decision: accepted,
				});
				return accepted;
			},
			executeRegeneration: async (request, decide) => {
				if (
					!isCurrentConversationBinding(
						this.#conversations.get(request.command.conversationId),
						request.authority,
						request.command.conversationId,
					)
				) {
					return { outcome: "denied" };
				}
				const idempotencyKey = key([
					request.command.conversationId,
					request.authority.actorId,
					request.command.command,
					request.command.idempotencyKey,
				]);
				const existing = this.#commandIdempotency.get(idempotencyKey);
				if (existing) {
					if (existing.requestDigest !== request.requestDigest) {
						return { outcome: "conflict", reason: "idempotency_conflict" };
					}
					if (existing.decision.outcome === "accepted") {
						return {
							outcome: "replayed",
							result: structuredClone(existing.decision.result),
						};
					}
					return structuredClone(existing.decision);
				}
				const decision = decide(
					this.#state(
						request.command.conversationId,
						request.command.sourceMessageId,
					),
				);
				if (!isRegenerationWritePlan(decision)) {
					if (decision.outcome === "denied") return decision;
					this.#commandIdempotency.set(idempotencyKey, {
						requestDigest: request.requestDigest,
						decision,
					});
					return decision;
				}
				const plan: ConversationRegenerationWritePlanV1 = decision;
				this.#conversations.set(
					plan.conversation.conversationId,
					structuredClone(plan.conversation),
				);
				this.#executions.push({
					executionId: plan.execution.executionId,
					conversationId: plan.execution.conversationId,
					actorId: plan.execution.actorId,
					turnId: plan.execution.turnId,
					status: plan.execution.status,
				});
				this.#outbox.push({
					operation: plan.outboxIntent.operation,
					executionId: plan.outboxIntent.executionId,
					sessionGeneration: plan.outboxIntent.sessionGeneration,
					messageId: plan.outboxIntent.messageId,
				});
				this.#audit.push({
					action: plan.auditEvent.action,
					actorId: plan.auditEvent.actorId,
					traceId: plan.auditEvent.traceId,
					requestId: plan.auditEvent.requestId,
				});
				const accepted = {
					outcome: "accepted",
					result: structuredClone(plan.result),
				} as const;
				this.#commandIdempotency.set(idempotencyKey, {
					requestDigest: request.requestDigest,
					decision: accepted,
				});
				return accepted;
			},
			executeStop: async (request, decide) => {
				if (
					!isCurrentConversationBinding(
						this.#conversations.get(request.command.conversationId),
						request.authority,
						request.command.conversationId,
					)
				) {
					return { outcome: "denied" };
				}
				const idempotencyKey = key([
					request.command.conversationId,
					request.authority.actorId,
					request.command.command,
					request.command.idempotencyKey,
				]);
				const existing = this.#stopIdempotency.get(idempotencyKey);
				if (existing) {
					if (existing.requestDigest !== request.requestDigest) {
						return { outcome: "conflict", reason: "idempotency_conflict" };
					}
					if (existing.decision.outcome === "accepted") {
						return {
							outcome: "replayed",
							result: structuredClone(existing.decision.result),
						};
					}
					return structuredClone(existing.decision);
				}
				const decision = decide(
					this.#state(
						request.command.conversationId,
						undefined,
						request.command.targetExecutionId,
					),
				);
				if (!isStopWritePlan(decision)) {
					if (decision.outcome === "denied") return decision;
					this.#stopIdempotency.set(idempotencyKey, {
						requestDigest: request.requestDigest,
						decision,
					});
					return decision;
				}
				const plan: ConversationStopWritePlanV1 = decision;
				this.#stops.push({
					executionId: plan.targetExecution.executionId,
					stopRequestId: plan.stopRequestId,
					status: "submitted",
				});
				this.#outbox.push({
					operation: plan.outboxIntent.operation,
					executionId: plan.outboxIntent.executionId,
					sessionGeneration: plan.outboxIntent.sessionGeneration,
					stopRequestId: plan.outboxIntent.stopRequestId,
				});
				this.#audit.push({
					action: plan.auditEvent.action,
					actorId: plan.auditEvent.actorId,
					traceId: plan.auditEvent.traceId,
					requestId: plan.auditEvent.requestId,
				});
				const accepted = {
					outcome: "accepted",
					result: structuredClone(plan.result),
				} as const;
				this.#stopIdempotency.set(idempotencyKey, {
					requestDigest: request.requestDigest,
					decision: accepted,
				});
				return accepted;
			},
		};
		this.#interface = createConversationExecutionUseCaseV1(
			{
				authorization:
					options.authorization ?? defaultAuthorization(options.authority),
				transaction,
			},
			options,
		);
	}

	createConversation: ConversationExecutionUseCaseV1["createConversation"] = (
		command,
	) => this.#interface.createConversation(command);

	accept: ConversationExecutionUseCaseV1["accept"] = (command) =>
		this.#interface.accept(command);

	regenerate: ConversationExecutionUseCaseV1["regenerate"] = (command) =>
		this.#interface.regenerate(command);

	stop: ConversationExecutionUseCaseV1["stop"] = (command) =>
		this.#interface.stop(command);

	completeExecution(executionId: string) {
		const execution = this.#executions.find(
			(candidate) => candidate.executionId === executionId,
		);
		if (!execution || !isActiveExecution(execution)) {
			throw new Error("Execution is not active");
		}
		execution.status = "completed";
	}

	snapshot() {
		return structuredClone({
			conversations: [...this.#conversations.values()],
			messages: this.#messages,
			executions: this.#executions,
			stops: this.#stops,
			outbox: this.#outbox,
			audit: this.#audit,
		});
	}

	#state(
		conversationId: string,
		sourceMessageId?: string,
		targetExecutionId?: string,
	): ConversationExecutionStateV1 {
		const source = sourceMessageId
			? this.#messages.find(
					(message) =>
						message.conversationId === conversationId &&
						message.messageId === sourceMessageId,
				)
			: undefined;
		const active = this.#executions.find(
			(execution) =>
				execution.conversationId === conversationId &&
				isActiveExecution(execution),
		);
		const target = targetExecutionId
			? this.#executions.find(
					(execution) =>
						execution.conversationId === conversationId &&
						execution.executionId === targetExecutionId,
				)
			: undefined;
		const stop = target
			? this.#stops.find(
					(candidate) => candidate.executionId === target.executionId,
				)
			: undefined;
		return {
			conversation: structuredClone(this.#conversations.get(conversationId)),
			sourceMessage: source
				? {
						messageId: source.messageId,
						conversationId: source.conversationId,
						actorId: source.actorId,
						role: source.role,
					}
				: undefined,
			targetExecution: target
				? {
						executionId: target.executionId,
						conversationId: target.conversationId,
						actorId: target.actorId,
						status: target.status,
					}
				: undefined,
			existingStop: stop
				? {
						executionId: stop.executionId,
						stopRequestId: stop.stopRequestId,
						status: stop.status,
					}
				: undefined,
			activeExecution: active
				? {
						executionId: active.executionId,
						conversationId: active.conversationId,
						actorId: active.actorId,
						turnId: active.turnId,
						status: active.status as "submitted" | "processing" | "unknown",
					}
				: undefined,
		};
	}
}
