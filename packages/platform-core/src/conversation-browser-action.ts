import { randomUUID } from "node:crypto";
import type {
	ConversationEventDecisionV1,
	ConversationEventUseCaseV1,
} from "./conversation-events.js";
import type {
	ConversationBrowserActionBindingV1,
	ConversationOperationFactV2,
	ConversationOperationFailureV2,
} from "./conversation-operation-facts.js";

export interface ConversationBrowserActionAttemptV1 {
	readonly operationRef: string;
	readonly attemptRef: string;
}

export function createConversationBrowserActionAttemptV1(
	newId: () => string = randomUUID,
): ConversationBrowserActionAttemptV1 {
	return { operationRef: newId(), attemptRef: newId() };
}

export interface ConversationBrowserActionInputV1 {
	readonly conversationId: string;
	readonly executionId: string;
	readonly sessionGeneration: number;
	readonly deliveryFence: number;
	readonly runtimeCursor: string;
	readonly occurredAt: string;
	readonly adapterEventKey: string;
	readonly attempt: ConversationBrowserActionAttemptV1;
	readonly phase: ConversationOperationFactV2["phase"];
	readonly toolId: string;
	readonly browser: ConversationBrowserActionBindingV1;
	readonly startedAt?: string;
	readonly finishedAt?: string;
	readonly durationMs?: number;
	readonly failureCode?: ConversationOperationFailureV2;
	readonly resultRef?: string;
}

export class ConversationBrowserActionExecutionError extends Error {
	readonly phase: "failed" | "unknown";
	readonly failureCode: ConversationOperationFailureV2;

	constructor(
		phase: "failed" | "unknown",
		message: string = phase,
		failureCode: ConversationOperationFailureV2 = phase === "unknown"
			? "recovery_unconfirmed"
			: "operation_failed",
	) {
		super(message);
		this.name = "ConversationBrowserActionExecutionError";
		this.phase = phase;
		this.failureCode = failureCode;
	}
}

export interface ConversationBrowserActionExecutionInputV1
	extends Omit<
		ConversationBrowserActionInputV1,
		"phase" | "adapterEventKey" | "runtimeCursor"
	> {
	readonly adapterEventKeyPrefix: string;
	readonly runtimeCursorPrefix: string;
	readonly now: () => string;
	readonly signal: AbortSignal;
	readonly run: (
		markStarted: () => Promise<void>,
		signal: AbortSignal,
	) => Promise<{ readonly resultRef?: string }>;
}

export function conversationBrowserActionFactV1(
	input: ConversationBrowserActionInputV1,
): ConversationOperationFactV2 {
	return {
		kind: "tool",
		operationRef: input.attempt.operationRef,
		attemptRef: input.attempt.attemptRef,
		phase: input.phase,
		toolId: input.toolId,
		browser: input.browser,
		...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
		...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
		...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
		...(input.failureCode === undefined
			? {}
			: { failureCode: input.failureCode }),
		...(input.resultRef === undefined ? {} : { resultRef: input.resultRef }),
	};
}

/** Persist through the existing Conversation event transaction. */
export async function persistConversationBrowserActionV1(
	useCase: ConversationEventUseCaseV1,
	input: ConversationBrowserActionInputV1,
): Promise<ConversationEventDecisionV1> {
	if (
		input.browser.sessionGeneration !== input.sessionGeneration ||
		input.browser.resourceFence !== input.deliveryFence
	)
		throw new Error("BROWSER_ACTION_BINDING_MISMATCH");
	const fact = conversationBrowserActionFactV1(input);
	return useCase.persist({
		schemaVersion: 1,
		conversationId: input.conversationId,
		executionId: input.executionId,
		sessionGeneration: input.sessionGeneration,
		deliveryFence: input.deliveryFence,
		adapterEventKey: input.adapterEventKey,
		runtimeCursor: input.runtimeCursor,
		occurredAt: input.occurredAt,
		event: { schemaVersion: 2, type: "execution.operation", fact },
	});
}

/**
 * One Browser action through the existing operation-event transaction. The
 * supplied `run` callback cannot execute its external I/O until `markStarted`
 * has committed; uncertain terminal persistence is never converted to success.
 */
export async function executeConversationBrowserActionV1(
	useCase: ConversationEventUseCaseV1,
	input: ConversationBrowserActionExecutionInputV1,
): Promise<{ readonly resultRef?: string }> {
	let started = false;
	if (input.signal.aborted)
		throw new ConversationBrowserActionExecutionError(
			"failed",
			"Browser action was cancelled before intent",
			"interrupted",
		);
	const persistPhase = async (
		phase: ConversationOperationFactV2["phase"],
		fields: Pick<
			ConversationBrowserActionInputV1,
			"startedAt" | "finishedAt" | "durationMs" | "failureCode" | "resultRef"
		> = {},
	) => {
		const decision = await persistConversationBrowserActionV1(useCase, {
			...input,
			phase,
			...fields,
			adapterEventKey: `${input.adapterEventKeyPrefix}:${phase}`,
			runtimeCursor: `${input.runtimeCursorPrefix}:${phase}`,
		});
		if (decision.outcome === "stale")
			throw new Error("BROWSER_ACTION_PERSISTENCE_STALE");
		return decision;
	};
	const intentDecision = await persistPhase("intent");
	if (intentDecision.outcome === "replayed") {
		if (intentDecision.event.event.type !== "execution.operation")
			throw new Error("BROWSER_ACTION_RECOVERY_INVALID");
		const fact = intentDecision.event.event.fact;
		if (fact.kind === "tool" && fact.phase === "completed")
			return { resultRef: fact.resultRef };
		throw new ConversationBrowserActionExecutionError(
			"unknown",
			"Browser action already has a persisted attempt",
		);
	}
	if (input.signal.aborted) {
		await persistPhase("failed", {
			finishedAt: input.now(),
			failureCode: "interrupted",
		});
		throw new ConversationBrowserActionExecutionError(
			"failed",
			"Browser action was cancelled after intent",
			"interrupted",
		);
	}
	const markStarted = async () => {
		if (started) return;
		if (input.signal.aborted)
			throw new ConversationBrowserActionExecutionError(
				"failed",
				"Browser action was cancelled before start",
				"interrupted",
			);
		const decision = await persistPhase("started", {
			startedAt: input.now(),
		});
		if (decision.outcome === "replayed")
			throw new ConversationBrowserActionExecutionError(
				"unknown",
				"Browser action start already exists",
			);
		started = true;
	};
	try {
		const result = await input.run(markStarted, input.signal);
		if (!started)
			throw new ConversationBrowserActionExecutionError(
				"failed",
				"Browser action did not cross the started barrier",
			);
		if (input.signal.aborted)
			throw new ConversationBrowserActionExecutionError(
				"unknown",
				"Browser action was cancelled after start",
				"interrupted",
			);
		await persistPhase("completed", {
			finishedAt: input.now(),
			resultRef: result.resultRef,
		});
		return result;
	} catch (error) {
		const phase =
			error instanceof ConversationBrowserActionExecutionError
				? error.phase
				: started
					? "unknown"
					: "failed";
		const failureCode: ConversationOperationFailureV2 =
			error instanceof ConversationBrowserActionExecutionError
				? error.failureCode
				: input.signal.aborted
					? "interrupted"
					: phase === "unknown"
						? "recovery_unconfirmed"
						: "operation_failed";
		await persistPhase(phase, {
			finishedAt: input.now(),
			failureCode,
		});
		throw error;
	}
}
