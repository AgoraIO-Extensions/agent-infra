import { performance } from "node:perf_hooks";
import {
	type ConversationEventDecisionV1,
	ConversationEventError,
	type ConversationEventStateV1,
	type ConversationEventUseCaseDependenciesV1,
	type ConversationEventUseCaseOptionsV1,
	type ConversationEventUseCaseV1,
	type ConversationEventWritePlanV1,
	type ConversationOperationFailureV2,
	createConversationEventUseCaseV1,
	parseConversationOperationHistoryV2,
} from "@agent-infra/platform-core";
import type {
	ModelTokenUsage,
	OperationalCode,
	OperationalEvent,
	OperationalOutcome,
	startObservability,
} from "./index.js";

const terminalPhases = new Set(["completed", "failed", "unknown"]);
const failureCodes: Partial<
	Record<ConversationOperationFailureV2, OperationalCode>
> = {
	authorization_denied: "AUTHORIZATION_DENIED",
	authorization_unavailable: "DEPENDENCY_UNAVAILABLE",
	dependency_unavailable: "DEPENDENCY_UNAVAILABLE",
	persistence_unavailable: "PERSISTENCE_UNAVAILABLE",
};

function firstOperationOutcome(
	next: ConversationEventWritePlanV1 | ConversationEventDecisionV1,
	state: ConversationEventStateV1,
): OperationalEvent | undefined {
	if ("outcome" in next || next.event.event.type !== "execution.operation")
		return;
	const fact = next.event.event.fact;
	if (!terminalPhases.has(fact.phase)) return;
	const history = parseConversationOperationHistoryV2(state.operationHistory);
	if (
		history.some(
			(previous) =>
				previous.kind === fact.kind &&
				previous.operationRef === fact.operationRef &&
				previous.attemptRef === fact.attemptRef &&
				terminalPhases.has(previous.phase),
		)
	)
		return;
	let outcome: OperationalOutcome = "failed";
	if (fact.phase === "completed") outcome = "completed";
	else if (fact.phase === "unknown") outcome = "unknown";
	else if (fact.failureCode === "authorization_denied") outcome = "rejected";
	const code =
		fact.phase === "unknown"
			? "OPERATION_UNKNOWN"
			: fact.failureCode === undefined
				? undefined
				: failureCodes[fact.failureCode];
	return {
		stage: fact.kind,
		outcome,
		...(code === undefined ? {} : { code }),
		...(fact.durationMs === undefined ? {} : { durationMs: fact.durationMs }),
		operationRef: fact.operationRef,
		attemptRef: fact.attemptRef,
		conversationId: next.event.conversationId,
		executionId: next.event.executionId,
	};
}

function firstModelUsage(
	next: ConversationEventWritePlanV1 | ConversationEventDecisionV1,
	state: ConversationEventStateV1,
): ModelTokenUsage | undefined {
	if ("outcome" in next || next.event.event.type !== "execution.operation")
		return;
	const fact = next.event.event.fact;
	if (fact.kind !== "model" || !fact.usage) return;
	const history = parseConversationOperationHistoryV2(state.operationHistory);
	const usage: { -readonly [K in keyof ModelTokenUsage]: ModelTokenUsage[K] } =
		{};
	for (const field of [
		"inputTokens",
		"outputTokens",
		"cachedInputTokens",
	] as const) {
		if (
			fact.usage[field] !== undefined &&
			!history.some(
				(previous) =>
					previous.kind === "model" &&
					previous.operationRef === fact.operationRef &&
					previous.attemptRef === fact.attemptRef &&
					previous.usage?.[field] !== undefined,
			)
		)
			usage[field] = fact.usage[field];
	}
	return Object.keys(usage).length ? usage : undefined;
}

export function createObservedConversationEvents(
	dependencies: ConversationEventUseCaseDependenciesV1 & {
		readonly telemetry: Pick<ReturnType<typeof startObservability>, "record"> &
			Partial<Pick<ReturnType<typeof startObservability>, "recordModelUsage">>;
	},
	options: ConversationEventUseCaseOptionsV1 = {},
): ConversationEventUseCaseV1 {
	const { transaction, telemetry } = dependencies;
	const newId = options.newId;
	const record = (event: OperationalEvent) => {
		try {
			telemetry.record(event);
		} catch {
			// Capture failure cannot change the Core result or cursor acknowledgement.
		}
	};
	return {
		async persist(command) {
			const began = performance.now();
			let correlation:
				| { readonly conversationId: string; readonly executionId: string }
				| undefined;
			let operationOutcome: OperationalEvent | undefined;
			let modelUsage: ModelTokenUsage | undefined;
			const events = createConversationEventUseCaseV1(
				{
					transaction: {
						persistEvent(request, decide) {
							correlation = {
								conversationId: request.command.conversationId,
								executionId: request.command.executionId,
							};
							return transaction.persistEvent(request, (state) => {
								const next = decide(state);
								// Read the same locked history; emit only after Core confirms the return value.
								try {
									operationOutcome = firstOperationOutcome(next, state);
									modelUsage = firstModelUsage(next, state);
								} catch {
									// An observation failure cannot abort the event/audit transaction.
								}
								return next;
							});
						},
					},
				},
				{ newId },
			);
			try {
				const decision = await events.persist(command);
				if (decision.outcome === "accepted") {
					record({
						stage: "result_persist",
						outcome: "completed",
						durationMs: performance.now() - began,
						conversationId: decision.event.conversationId,
						executionId: decision.event.executionId,
					});
					if (operationOutcome) record(operationOutcome);
					if (modelUsage) {
						try {
							telemetry.recordModelUsage?.(modelUsage);
						} catch {
							// Usage export is observational; the original ACK is unchanged.
						}
					}
				}
				return decision;
			} catch (error) {
				if (
					error instanceof ConversationEventError &&
					error.code === "unavailable"
				)
					record({
						stage: "result_persist",
						outcome: "failed",
						code: "PERSISTENCE_UNAVAILABLE",
						durationMs: performance.now() - began,
						...correlation,
					});
				throw error;
			}
		},
	};
}
