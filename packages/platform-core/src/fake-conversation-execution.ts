import {
	type ConversationCommandDecisionV1,
	type ConversationExecutionAuthorityV1,
	type ConversationExecutionAuthorizationPortV1,
	type ConversationExecutionStateV1,
	type ConversationExecutionTransactionPortV1,
	type ConversationExecutionUseCaseOptionsV1,
	type ConversationExecutionUseCaseV1,
	type ConversationMessageWritePlanV1,
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
	readonly executionId: string;
	readonly text: string;
}

interface StoredExecution {
	readonly executionId: string;
	readonly conversationId: string;
	readonly actorId: string;
	readonly turnId: string;
	readonly status: "submitted";
}

interface StoredOutbox {
	readonly operation: string;
	readonly executionId: string;
	readonly messageId: string;
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

export class FakeConversationExecutionV1
	implements ConversationExecutionUseCaseV1
{
	readonly #conversations = new Map<
		string,
		ConversationExecutionStateV1["conversation"]
	>();
	readonly #messages: StoredMessage[] = [];
	readonly #executions: StoredExecution[] = [];
	readonly #outbox: StoredOutbox[] = [];
	readonly #audit: StoredAudit[] = [];
	readonly #createIdempotency = new Map<
		string,
		StoredIdempotency<CreateConversationDecisionV1>
	>();
	readonly #messageIdempotency = new Map<
		string,
		StoredIdempotency<ConversationCommandDecisionV1>
	>();
	readonly #interface: ConversationExecutionUseCaseV1;

	constructor(options: FakeConversationExecutionOptionsV1 = {}) {
		const transaction: ConversationExecutionTransactionPortV1 = {
			createConversation: async (request, decide) => {
				const idempotencyKey = key([
					request.authority.agentId,
					request.authority.actorId,
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
				const idempotencyKey = key([
					request.command.conversationId,
					request.authority.actorId,
					request.command.idempotencyKey,
				]);
				const existing = this.#messageIdempotency.get(idempotencyKey);
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
				const active = this.#executions.find(
					(execution) =>
						execution.conversationId === request.command.conversationId,
				);
				const decision = decide({
					conversation: structuredClone(
						this.#conversations.get(request.command.conversationId),
					),
					activeExecution: active
						? {
								executionId: active.executionId,
								conversationId: active.conversationId,
								actorId: active.actorId,
								turnId: active.turnId,
								status: active.status,
							}
						: undefined,
				});
				if (!isMessageWritePlan(decision)) {
					if (decision.outcome === "denied") return decision;
					this.#messageIdempotency.set(idempotencyKey, {
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
				this.#messageIdempotency.set(idempotencyKey, {
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

	snapshot() {
		return structuredClone({
			conversations: [...this.#conversations.values()],
			messages: this.#messages,
			executions: this.#executions,
			outbox: this.#outbox,
			audit: this.#audit,
		});
	}
}
