import {
	type ConversationEventCommandV1,
	type ConversationEventDecisionV1,
	type ConversationEventTransactionPortV1,
	type ConversationEventUseCaseV1,
	type ConversationEventWritePlanV1,
	createConversationEventUseCaseV1,
	type PersistedConversationEventV1,
	type PersistedRuntimeConversationEventV1,
} from "./conversation-events.js";
import {
	type ConversationCommandDecisionV1,
	type ConversationExecutionAuthorityV1,
	type ConversationExecutionAuthorizationPortV1,
	type ConversationExecutionStateV1,
	type ConversationExecutionTransactionPortV1,
	type ConversationExecutionUseCaseOptionsV1,
	type ConversationExecutionUseCaseV1,
	type ConversationMessageWritePlanV1,
	type ConversationMetadataRecoveryStateV1,
	type ConversationModelConfigurationV1,
	type ConversationModelSelectionDecisionV1,
	type ConversationModelSelectionFallbackWriteV1,
	type ConversationModelSelectionWritePlanV1,
	type ConversationRegenerationWritePlanV1,
	type ConversationStopDecisionV1,
	type ConversationStopWritePlanV1,
	type CreateConversationDecisionV1,
	createConversationExecutionUseCaseV1,
} from "./conversation-execution.js";
import {
	bindInputFileV1,
	type FileRecordV1,
	isConfirmedResultFileV1,
} from "./file-authority.js";

export interface FakeConversationExecutionOptionsV1
	extends ConversationExecutionUseCaseOptionsV1 {
	readonly authority?: ConversationExecutionAuthorityV1;
	readonly authorization?: ConversationExecutionAuthorizationPortV1;
	readonly modelConfiguration?: ConversationModelConfigurationV1;
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
	readonly sessionGeneration: number;
	readonly deliveryFence: number;
	readonly modelConfigurationRevision: number | null;
	readonly modelOptionId: string | null;
	readonly reasoningLevel: string | null;
	lastEventSequence: number;
	status:
		| "submitted"
		| "processing"
		| "unknown"
		| "completed"
		| "failed"
		| "cancelled";
}

interface StoredOutbox {
	status?: "pending" | "succeeded" | "failed";
	metadataRecovery?: import("./conversation-dispatch.js").ConversationMetadataRecoveryV1;
	readonly operation: string;
	readonly executionId: string;
	readonly sessionGeneration: number;
	readonly modelConfigurationRevision?: number | null;
	readonly modelOptionId?: string | null;
	readonly reasoningLevel?: string | null;
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
	readonly executionId?: string;
	readonly details?: Record<string, unknown>;
}

type StoredTimelineEvent =
	| {
			readonly source: "runtime";
			readonly adapterEventKey: string;
			readonly eventDigest: string;
			readonly runtimeCursor: string;
			readonly event: PersistedRuntimeConversationEventV1;
	  }
	| {
			readonly source: "platform";
			readonly runtimeCursor: null;
			readonly event: PersistedConversationEventV1;
	  };

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

function isEventWritePlan(
	decision: ConversationEventWritePlanV1 | ConversationEventDecisionV1,
): decision is ConversationEventWritePlanV1 {
	return !Object.hasOwn(decision, "outcome");
}

function isRegenerationWritePlan(
	decision:
		| ConversationRegenerationWritePlanV1
		| { readonly outcome: "busy" | "denied" },
): decision is ConversationRegenerationWritePlanV1 {
	return !Object.hasOwn(decision, "outcome");
}

function isModelSelectionWritePlan(
	decision:
		| ConversationModelSelectionWritePlanV1
		| { readonly outcome: "denied" },
): decision is ConversationModelSelectionWritePlanV1 {
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
	#failNextCommit = false;
	readonly #conversations = new Map<
		string,
		ConversationExecutionStateV1["conversation"]
	>();
	readonly #messages: StoredMessage[] = [];
	private readonly files = new Map<string, FileRecordV1>();
	seedFile(file: FileRecordV1) {
		this.files.set(file.fileId, structuredClone(file));
	}

	readonly #executions: StoredExecution[] = [];
	readonly #stops: StoredStop[] = [];
	readonly #outbox: StoredOutbox[] = [];
	readonly #acceptedAuthorities = new Map<
		string,
		ConversationExecutionAuthorityV1
	>();
	readonly #audit: StoredAudit[] = [];
	readonly #events: StoredTimelineEvent[] = [];
	readonly #currentAuthorizationRevision: string | undefined;
	#modelConfiguration: ConversationModelConfigurationV1 | undefined;
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
	readonly #modelSelectionIdempotency = new Map<
		string,
		StoredIdempotency<ConversationModelSelectionDecisionV1>
	>();
	readonly #interface: ConversationExecutionUseCaseV1;
	readonly #eventInterface: ConversationEventUseCaseV1;

	constructor(options: FakeConversationExecutionOptionsV1 = {}) {
		let nextId = 1;
		const now = options.now ?? (() => new Date(0));
		const newId = options.newId ?? (() => `fake_conversation_${nextId++}`);
		this.#currentAuthorizationRevision =
			options.authority?.authorizationRevision;
		this.#modelConfiguration = structuredClone(options.modelConfiguration);
		const transaction: ConversationExecutionTransactionPortV1 = {
			requestMetadataRecovery: async (request, decide) => {
				const candidates: ConversationMetadataRecoveryStateV1["candidates"][number][] =
					[];
				const outboxes = new Map<string, StoredOutbox>();
				for (const execution of this.#executions.filter(
					(execution) =>
						execution.conversationId === request.query.conversationId,
				)) {
					const original = this.#acceptedAuthorities.get(execution.executionId);
					const originals = this.#outbox
						.filter(
							(outbox) =>
								outbox.executionId === execution.executionId &&
								[
									"conversation.turn.submit.v1",
									"conversation.turn.regenerate.v1",
								].includes(outbox.operation),
						)
						.map((outbox) => {
							const itemId = `${outbox.operation === "conversation.turn.submit.v1" ? "conversation:turn" : "conversation:regenerate"}:${outbox.executionId}`;
							outboxes.set(itemId, outbox);
							return {
								itemId,
								operation: outbox.operation,
								status: outbox.status ?? "pending",
								payload: {
									schemaVersion: 1,
									conversationId: execution.conversationId,
									executionId: outbox.executionId,
									messageId: outbox.messageId,
									turnId: execution.turnId,
									sessionGeneration: outbox.sessionGeneration,
									...(outbox.metadataRecovery
										? { metadataRecovery: outbox.metadataRecovery }
										: {}),
								},
							};
						});
					const history = this.#events.filter(
						(event) =>
							event.source === "runtime" &&
							event.event.executionId === execution.executionId,
					);
					const facts = new Map<
						string,
						import("./conversation-operation-facts.js").ConversationOperationFactV2
					>();
					for (const record of history) {
						const event = record.event.event;
						if (
							event.type === "execution.operation" &&
							event.fact.kind === "tool"
						)
							facts.set(
								key([event.fact.operationRef, event.fact.attemptRef]),
								event.fact,
							);
					}
					candidates.push({
						execution: {
							...execution,
							agentId: original?.agentId ?? "",
							channelId: original?.channelId ?? "",
							authorizationRevision: original?.authorizationRevision ?? "",
							runtimeCursor: history.at(-1)?.runtimeCursor ?? null,
						},
						originalOutboxes: originals,
						boundary: original?.taskBoundary ?? null,
						latestToolFacts: [...facts.values()],
					});
				}
				const plan = decide({
					conversation: structuredClone(
						this.#conversations.get(request.query.conversationId),
					),
					candidates,
				});
				if (this.#failNextCommit && plan.updates.length > 0) {
					this.#failNextCommit = false;
					throw new Error("Injected Fake Conversation commit failure");
				}
				for (const update of plan.updates) {
					const outbox = outboxes.get(update.itemId);
					if (!outbox) throw new Error("Invalid Fake recovery plan");
					outbox.status = "pending";
					outbox.metadataRecovery = structuredClone(update.metadataRecovery);
				}
				return plan.result;
			},
			readConversation: async (request, project) => {
				if (
					!isCurrentConversationBinding(
						this.#conversations.get(request.query.conversationId),
						request.authority,
						request.query.conversationId,
					) ||
					(this.#currentAuthorizationRevision !== undefined &&
						request.authority.authorizationRevision !==
							this.#currentAuthorizationRevision)
				) {
					return { outcome: "denied" };
				}
				return project(this.#state(request.query.conversationId));
			},
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
					if (decision.outcome === "denied" || decision.outcome === "busy") {
						return decision;
					}
					this.#commandIdempotency.set(idempotencyKey, {
						requestDigest: request.requestDigest,
						decision,
					});
					return decision;
				}
				const plan: ConversationMessageWritePlanV1 = decision;
				const boundFiles = (request.command.attachments ?? []).map((fileId) =>
					bindInputFileV1(
						this.files.get(fileId) ?? null,
						plan.conversation,
						{
							messageId: plan.message.messageId,
							executionId: plan.message.executionId,
							sessionGeneration: plan.conversation.sessionGeneration,
						},
						plan.message.createdAt,
					),
				);

				if (this.#failNextCommit) {
					this.#failNextCommit = false;
					throw new Error("Injected Fake Conversation commit failure");
				}
				this.#conversations.set(
					plan.conversation.conversationId,
					structuredClone(plan.conversation),
				);
				for (const file of boundFiles) this.files.set(file.fileId, file);
				this.#messages.push({
					messageId: plan.message.messageId,
					conversationId: plan.message.conversationId,
					actorId: plan.message.actorId,
					role: "user",
					executionId: plan.message.executionId,
					text: plan.message.text,
				});
				if (plan.execution) {
					this.#acceptedAuthorities.set(
						plan.execution.executionId,
						structuredClone(request.authority),
					);
					this.#executions.push({
						executionId: plan.execution.executionId,
						conversationId: plan.execution.conversationId,
						actorId: plan.execution.actorId,
						turnId: plan.execution.turnId,
						sessionGeneration: plan.execution.sessionGeneration,
						deliveryFence: plan.execution.deliveryFence,
						modelConfigurationRevision:
							plan.execution.modelConfigurationRevision,
						modelOptionId: plan.execution.modelOptionId,
						reasoningLevel: plan.execution.reasoningLevel,
						lastEventSequence: 0,
						status: plan.execution.status,
					});
				}
				this.#outbox.push({
					operation: plan.outboxIntent.operation,
					executionId: plan.outboxIntent.executionId,
					sessionGeneration: plan.outboxIntent.sessionGeneration,
					modelConfigurationRevision:
						plan.outboxIntent.modelConfigurationRevision,
					modelOptionId: plan.outboxIntent.modelOptionId,
					reasoningLevel: plan.outboxIntent.reasoningLevel,
					messageId: plan.outboxIntent.messageId,
				});
				this.#audit.push({
					action: plan.auditEvent.action,
					actorId: plan.auditEvent.actorId,
					traceId: plan.auditEvent.traceId,
					requestId: plan.auditEvent.requestId,
				});
				this.#persistModelSelectionFallback(plan.modelSelectionFallback);
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
			executeModelSelection: async (request, decide) => {
				if (
					!isCurrentConversationBinding(
						this.#conversations.get(request.command.conversationId),
						request.authority,
						request.command.conversationId,
					)
				) {
					return { outcome: "denied" };
				}
				if (
					this.#currentAuthorizationRevision !== undefined &&
					request.authority.authorizationRevision !==
						this.#currentAuthorizationRevision
				) {
					return { outcome: "denied" };
				}
				const idempotencyKey = key([
					request.command.conversationId,
					request.authority.actorId,
					request.command.command,
					request.command.idempotencyKey,
				]);
				const existing = this.#modelSelectionIdempotency.get(idempotencyKey);
				if (existing) {
					if (existing.requestDigest !== request.requestDigest) {
						return { outcome: "conflict", reason: "idempotency_conflict" };
					}
					if (existing.decision.outcome !== "accepted") {
						throw new Error("Invalid Fake model selection idempotency state");
					}
					return {
						outcome: "replayed",
						result: structuredClone(existing.decision.result),
					};
				}
				const decision = decide(this.#state(request.command.conversationId));
				if (!isModelSelectionWritePlan(decision)) return decision;
				if (this.#failNextCommit) {
					this.#failNextCommit = false;
					throw new Error("Injected Fake Conversation commit failure");
				}
				this.#conversations.set(
					decision.conversation.conversationId,
					structuredClone(decision.conversation),
				);
				this.#audit.push({
					action: decision.auditEvent.action,
					actorId: decision.auditEvent.actorId,
					traceId: decision.auditEvent.traceId,
					requestId: decision.auditEvent.requestId,
					details: {
						modelConfigurationRevision:
							decision.auditEvent.modelConfigurationRevision,
						modelOptionId: decision.auditEvent.modelOptionId,
						reasoningLevel: decision.auditEvent.reasoningLevel,
					},
				});
				const accepted = {
					outcome: "accepted",
					result: structuredClone(decision.result),
				} as const;
				this.#modelSelectionIdempotency.set(idempotencyKey, {
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
					if (decision.outcome === "denied" || decision.outcome === "busy") {
						return decision;
					}
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
				this.#acceptedAuthorities.set(
					plan.execution.executionId,
					structuredClone(request.authority),
				);
				this.#executions.push({
					executionId: plan.execution.executionId,
					conversationId: plan.execution.conversationId,
					actorId: plan.execution.actorId,
					turnId: plan.execution.turnId,
					sessionGeneration: plan.execution.sessionGeneration,
					deliveryFence: plan.execution.deliveryFence,
					modelConfigurationRevision: plan.execution.modelConfigurationRevision,
					modelOptionId: plan.execution.modelOptionId,
					reasoningLevel: plan.execution.reasoningLevel,
					lastEventSequence: 0,
					status: plan.execution.status,
				});
				this.#outbox.push({
					operation: plan.outboxIntent.operation,
					executionId: plan.outboxIntent.executionId,
					sessionGeneration: plan.outboxIntent.sessionGeneration,
					modelConfigurationRevision:
						plan.outboxIntent.modelConfigurationRevision,
					modelOptionId: plan.outboxIntent.modelOptionId,
					reasoningLevel: plan.outboxIntent.reasoningLevel,
					messageId: plan.outboxIntent.messageId,
				});
				this.#audit.push({
					action: plan.auditEvent.action,
					actorId: plan.auditEvent.actorId,
					traceId: plan.auditEvent.traceId,
					requestId: plan.auditEvent.requestId,
				});
				this.#persistModelSelectionFallback(plan.modelSelectionFallback);
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
		const eventTransaction: ConversationEventTransactionPortV1 = {
			persistEvent: async (request, decide) => {
				const conversation = this.#conversations.get(
					request.command.conversationId,
				);
				const execution = this.#executions.find(
					(candidate) =>
						candidate.conversationId === request.command.conversationId &&
						candidate.executionId === request.command.executionId,
				);
				const existing = this.#events.find(
					(candidate) =>
						candidate.source === "runtime" &&
						candidate.event.executionId === request.command.executionId &&
						candidate.adapterEventKey === request.command.adapterEventKey,
				);
				const decision = decide({
					operationHistory: this.#events.flatMap((record) =>
						record.source === "runtime" &&
						record.event.executionId === request.command.executionId &&
						record.event.event.type === "execution.operation"
							? [record.event.event.fact]
							: [],
					),
					conversation: conversation
						? {
								conversationId: conversation.conversationId,
								sessionGeneration: conversation.sessionGeneration,
								lastConversationCursor: conversation.lastConversationCursor,
							}
						: undefined,
					execution: execution
						? {
								executionId: execution.executionId,
								conversationId: execution.conversationId,
								sessionGeneration: execution.sessionGeneration,
								deliveryFence: execution.deliveryFence,
								lastSequence: execution.lastEventSequence,
							}
						: undefined,
					existingEvent:
						existing?.source === "runtime"
							? {
									event: structuredClone(existing.event),
									eventDigest: existing.eventDigest,
								}
							: undefined,
				});
				if (!isEventWritePlan(decision)) return decision;
				if (!conversation || !execution || existing) {
					throw new Error("Invalid Fake Conversation event plan");
				}
				if (
					decision.event.event.type === "result.file" &&
					!isConfirmedResultFileV1(
						this.files.get(decision.event.event.fileId) ?? null,
						{
							...conversation,
							executionId: execution.executionId,
							sessionGeneration: execution.sessionGeneration,
						},
						decision.event.event,
					)
				)
					throw new Error("Unconfirmed result file");
				this.#events.push({
					source: "runtime",
					adapterEventKey: decision.adapterEventKey,
					eventDigest: decision.eventDigest,
					runtimeCursor: decision.runtimeCursor,
					event: structuredClone(decision.event),
				});
				execution.lastEventSequence = decision.event.sequence;
				if (decision.transition) {
					execution.status = decision.transition.executionStatus;
				}
				this.#conversations.set(conversation.conversationId, {
					...conversation,
					lastConversationCursor: decision.event.conversationCursor,
					...(decision.transition
						? { status: decision.transition.conversationStatus }
						: {}),
				});
				return { outcome: "accepted", event: structuredClone(decision.event) };
			},
		};
		this.#interface = createConversationExecutionUseCaseV1(
			{
				authorization:
					options.authorization ?? defaultAuthorization(options.authority),
				transaction,
			},
			{ now, newId },
		);
		this.#eventInterface = createConversationEventUseCaseV1(
			{ transaction: eventTransaction },
			{ newId },
		);
	}

	createConversation: ConversationExecutionUseCaseV1["createConversation"] = (
		command,
	) => this.#interface.createConversation(command);

	requestMetadataRecovery: ConversationExecutionUseCaseV1["requestMetadataRecovery"] =
		(query) => this.#interface.requestMetadataRecovery(query);

	readConversation: ConversationExecutionUseCaseV1["readConversation"] = (
		query,
	) => this.#interface.readConversation(query);

	accept: ConversationExecutionUseCaseV1["accept"] = (command) =>
		this.#interface.accept(command);

	selectModel: ConversationExecutionUseCaseV1["selectModel"] = (command) =>
		this.#interface.selectModel(command);

	regenerate: ConversationExecutionUseCaseV1["regenerate"] = (command) =>
		this.#interface.regenerate(command);

	stop: ConversationExecutionUseCaseV1["stop"] = (command) =>
		this.#interface.stop(command);

	persistRuntimeEvent(command: ConversationEventCommandV1) {
		return this.#eventInterface.persist(command);
	}

	failNextCommit() {
		this.#failNextCommit = true;
	}

	setModelConfiguration(
		configuration: ConversationModelConfigurationV1 | undefined,
	) {
		this.#modelConfiguration = structuredClone(configuration);
	}

	completeExecution(
		executionId: string,
		delivery?: {
			readonly hostSessionRef: string;
			readonly deliveryFence: number;
			readonly outboxStatus: "succeeded" | "failed";
		},
	) {
		const execution = this.#executions.find(
			(candidate) => candidate.executionId === executionId,
		);
		if (!execution || !isActiveExecution(execution)) {
			throw new Error("Execution is not active");
		}
		if (delivery) {
			const conversation = this.#conversations.get(execution.conversationId);
			const outbox = this.#outbox.find(
				(outbox) =>
					outbox.executionId === executionId &&
					[
						"conversation.turn.submit.v1",
						"conversation.turn.regenerate.v1",
					].includes(outbox.operation),
			);
			if (!conversation || !outbox)
				throw new Error("Missing Fake runtime delivery");
			this.#executions[this.#executions.indexOf(execution)] = {
				...execution,
				status: "completed",
				deliveryFence: delivery.deliveryFence,
			};
			this.#conversations.set(execution.conversationId, {
				...conversation,
				hostSessionRef: delivery.hostSessionRef,
			});
			outbox.status = delivery.outboxStatus;
			return;
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
			events: this.#events,
		});
	}

	idempotencyCount() {
		return (
			this.#createIdempotency.size +
			this.#commandIdempotency.size +
			this.#stopIdempotency.size +
			this.#modelSelectionIdempotency.size
		);
	}

	#persistModelSelectionFallback(
		fallback: ConversationModelSelectionFallbackWriteV1 | null,
	): void {
		if (!fallback) return;
		const execution = this.#executions.find(
			(candidate) =>
				candidate.executionId === fallback.timelineEvent.executionId &&
				candidate.conversationId === fallback.timelineEvent.conversationId,
		);
		if (
			!execution ||
			fallback.timelineEvent.sequence !== execution.lastEventSequence + 1
		) {
			throw new Error("Invalid Fake model fallback event binding");
		}
		execution.lastEventSequence = fallback.timelineEvent.sequence;
		this.#events.push({
			source: "platform",
			runtimeCursor: null,
			event: structuredClone(fallback.timelineEvent),
		});
		this.#audit.push({
			action: fallback.auditEvent.action,
			actorId: fallback.auditEvent.actorId,
			traceId: fallback.auditEvent.traceId,
			requestId: fallback.auditEvent.requestId,
			executionId: fallback.auditEvent.executionId,
			details: {
				previousModelOptionId: fallback.previousModelOptionId,
				previousReasoningLevel: fallback.previousReasoningLevel,
				modelConfigurationRevision: fallback.modelConfigurationRevision,
				modelOptionId: fallback.modelOptionId,
				reasoningLevel: fallback.reasoningLevel,
			},
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
		const activeStopPending = active
			? this.#stops.some(
					(candidate) =>
						candidate.executionId === active.executionId &&
						candidate.status === "submitted",
				)
			: false;
		return {
			conversation: structuredClone(this.#conversations.get(conversationId)),
			modelConfiguration: structuredClone(this.#modelConfiguration),
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
						sessionGeneration: target.sessionGeneration,
						modelConfigurationRevision: target.modelConfigurationRevision,
						modelOptionId: target.modelOptionId,
						reasoningLevel: target.reasoningLevel,
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
						sessionGeneration: active.sessionGeneration,
						modelConfigurationRevision: active.modelConfigurationRevision,
						modelOptionId: active.modelOptionId,
						reasoningLevel: active.reasoningLevel,
						lastEventSequence: active.lastEventSequence,
						stopPending: activeStopPending,
						status: active.status as "submitted" | "processing" | "unknown",
					}
				: undefined,
		};
	}
}
