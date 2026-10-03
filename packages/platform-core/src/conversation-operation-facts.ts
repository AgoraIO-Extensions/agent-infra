import {
	isAgentManagementText,
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
	snapshotAgentManagementDenseArray,
} from "./agent-management-input.js";

export type ConversationOperationFailureV2 =
	| "authorization_denied"
	| "authorization_unavailable"
	| "dependency_unavailable"
	| "request_rejected"
	| "response_incomplete"
	| "operation_failed"
	| "persistence_unavailable"
	| "interrupted"
	| "recovery_unconfirmed";

/** Domain evidence only; transport validation belongs to the Runtime Adapter. */
type ConversationConnectionAssociationV1 =
	| {
			readonly serviceRef: string;
			readonly verification: "verified";
			readonly callRef: string;
	  }
	| {
			readonly serviceRef: string;
			readonly verification: "unverified";
			readonly callRef?: string;
			readonly reason:
				| "receipt_missing"
				| "record_unavailable"
				| "authorization_unavailable"
				| "binding_mismatch"
				| "response_unconfirmed";
	  };

interface ConversationOperationBaseV2 {
	readonly operationRef: string;
	readonly attemptRef: string;
	readonly parentOperationRef?: string;
	readonly phase: "intent" | "started" | "completed" | "failed" | "unknown";
	readonly startedAt?: string;
	readonly finishedAt?: string;
	readonly durationMs?: number;
	readonly failureCode?: ConversationOperationFailureV2;
}

export type ConversationOperationFactV2 = ConversationOperationBaseV2 &
	(
		| {
				readonly kind: "model";
				readonly model: {
					readonly configVersion: string;
					readonly modelOptionId: string;
					readonly modelId: string;
					readonly reasoningLevel?: string;
				};
				readonly usage?: {
					readonly inputTokens?: number;
					readonly outputTokens?: number;
					readonly cachedInputTokens?: number;
				};
		  }
		| {
				readonly kind: "tool";
				readonly toolId: string;
				readonly resultRef?: string;
				readonly connection?: ConversationConnectionAssociationV1;
		  }
	);

export interface ConversationOperationEventV2 {
	readonly schemaVersion: 2;
	readonly type: "execution.operation";
	readonly fact: ConversationOperationFactV2;
}

function invalid(): never {
	throw new TypeError("Conversation operation fact is invalid");
}

function record(
	input: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
) {
	const value = snapshotAgentManagementDataObject(input);
	const presentOptional = optional.filter((key) => Object.hasOwn(value, key));
	requireAgentManagementExactKeys(value, [...required, ...presentOptional]);
	return value;
}

function reference(input: unknown): string {
	if (!isAgentManagementText(input)) invalid();
	return input;
}

function metadata(input: unknown): string {
	if (
		typeof input !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input)
	)
		invalid();
	return input;
}

function count(input: unknown): number {
	if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0)
		invalid();
	return input;
}

function time(input: unknown): string {
	const value = reference(input);
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp) || !/^\d{4}-\d{2}-\d{2}T/.test(value))
		invalid();
	return new Date(timestamp).toISOString();
}

function failure(input: unknown): ConversationOperationFailureV2 {
	if (
		input !== "authorization_denied" &&
		input !== "authorization_unavailable" &&
		input !== "dependency_unavailable" &&
		input !== "request_rejected" &&
		input !== "response_incomplete" &&
		input !== "operation_failed" &&
		input !== "persistence_unavailable" &&
		input !== "interrupted" &&
		input !== "recovery_unconfirmed"
	)
		invalid();
	return input;
}

function connectionAssociation(
	input: unknown,
): ConversationConnectionAssociationV1 {
	const shape = snapshotAgentManagementDataObject(input);
	if (shape.verification === "verified") {
		const value = record(input, ["serviceRef", "verification", "callRef"]);
		return {
			serviceRef: metadata(value.serviceRef),
			verification: "verified",
			callRef: metadata(value.callRef),
		};
	}
	const value = record(
		input,
		["serviceRef", "verification", "reason"],
		["callRef"],
	);
	if (
		value.verification !== "unverified" ||
		(value.reason !== "receipt_missing" &&
			value.reason !== "record_unavailable" &&
			value.reason !== "authorization_unavailable" &&
			value.reason !== "binding_mismatch" &&
			value.reason !== "response_unconfirmed")
	)
		invalid();
	return {
		serviceRef: metadata(value.serviceRef),
		verification: "unverified",
		...(value.callRef === undefined
			? {}
			: { callRef: metadata(value.callRef) }),
		reason: value.reason,
	};
}

/** Domain facts, deliberately independent from transport Zod schemas. */
export function parseConversationOperationFactV2(
	input: unknown,
): ConversationOperationFactV2 {
	const shape = snapshotAgentManagementDataObject(input);
	const value = record(
		input,
		[
			"kind",
			"operationRef",
			"attemptRef",
			"phase",
			...(shape.kind === "model" ? ["model"] : ["toolId"]),
		],
		[
			"parentOperationRef",
			"startedAt",
			"finishedAt",
			"durationMs",
			"failureCode",
			...(shape.kind === "model" ? ["usage"] : ["resultRef", "connection"]),
		],
	);
	if (value.kind !== "model" && value.kind !== "tool") invalid();
	if (
		value.phase !== "intent" &&
		value.phase !== "started" &&
		value.phase !== "completed" &&
		value.phase !== "failed" &&
		value.phase !== "unknown"
	)
		invalid();
	const base: ConversationOperationBaseV2 = {
		operationRef: reference(value.operationRef),
		attemptRef: reference(value.attemptRef),
		phase: value.phase,
		...(value.parentOperationRef === undefined
			? {}
			: { parentOperationRef: reference(value.parentOperationRef) }),
		...(value.startedAt === undefined
			? {}
			: { startedAt: time(value.startedAt) }),
		...(value.finishedAt === undefined
			? {}
			: { finishedAt: time(value.finishedAt) }),
		...(value.durationMs === undefined
			? {}
			: { durationMs: count(value.durationMs) }),
		...(value.failureCode === undefined
			? {}
			: { failureCode: failure(value.failureCode) }),
	};
	if (
		base.parentOperationRef === base.operationRef ||
		(base.startedAt !== undefined &&
			base.finishedAt !== undefined &&
			base.startedAt > base.finishedAt) ||
		(base.phase === "intent" &&
			[
				base.startedAt,
				base.finishedAt,
				base.durationMs,
				base.failureCode,
				value.usage,
				value.resultRef,
			].some((item) => item !== undefined)) ||
		(base.phase === "started" &&
			[
				base.finishedAt,
				base.durationMs,
				base.failureCode,
				value.usage,
				value.resultRef,
			].some((item) => item !== undefined)) ||
		(base.phase === "completed" && base.failureCode !== undefined)
	)
		invalid();
	if (value.kind === "tool")
		return {
			...base,
			kind: "tool",
			toolId: metadata(value.toolId),
			...(value.resultRef === undefined
				? {}
				: { resultRef: reference(value.resultRef) }),
			...(value.connection === undefined
				? {}
				: { connection: connectionAssociation(value.connection) }),
		};
	const model = record(
		value.model,
		["configVersion", "modelOptionId", "modelId"],
		["reasoningLevel"],
	);
	const usage =
		value.usage === undefined
			? undefined
			: record(
					value.usage,
					[],
					["inputTokens", "outputTokens", "cachedInputTokens"],
				);
	return {
		...base,
		kind: "model",
		model: {
			configVersion: metadata(model.configVersion),
			modelOptionId: metadata(model.modelOptionId),
			modelId: metadata(model.modelId),
			...(model.reasoningLevel === undefined
				? {}
				: { reasoningLevel: metadata(model.reasoningLevel) }),
		},
		...(usage === undefined
			? {}
			: {
					usage: {
						...(usage.inputTokens === undefined
							? {}
							: { inputTokens: count(usage.inputTokens) }),
						...(usage.outputTokens === undefined
							? {}
							: { outputTokens: count(usage.outputTokens) }),
						...(usage.cachedInputTokens === undefined
							? {}
							: { cachedInputTokens: count(usage.cachedInputTokens) }),
					},
				}),
	};
}

export function parseConversationOperationEventV2(
	input: unknown,
): ConversationOperationEventV2 {
	const value = record(input, ["schemaVersion", "type", "fact"]);
	if (value.schemaVersion !== 2 || value.type !== "execution.operation")
		invalid();
	return {
		schemaVersion: 2,
		type: "execution.operation",
		fact: parseConversationOperationFactV2(value.fact),
	};
}

export function parseConversationOperationHistoryV2(
	input: unknown,
): readonly ConversationOperationFactV2[] {
	return snapshotAgentManagementDenseArray(input, Number.MAX_SAFE_INTEGER).map(
		parseConversationOperationFactV2,
	);
}

function operationBinding(fact: ConversationOperationFactV2) {
	return JSON.stringify([
		fact.kind,
		fact.parentOperationRef ?? null,
		fact.kind === "model" ? fact.model : fact.toolId,
	]);
}

function requireConnectionSuccessor(
	previous: ConversationOperationFactV2,
	next: ConversationOperationFactV2,
): void {
	if (previous.kind !== "tool" || next.kind !== "tool" || !previous.connection)
		return;
	if (
		!next.connection ||
		previous.connection.serviceRef !== next.connection.serviceRef ||
		(previous.connection.callRef !== undefined &&
			previous.connection.callRef !== next.connection.callRef) ||
		(previous.connection.verification === "verified" &&
			next.connection.verification !== "verified")
	)
		invalid();
}

function isConnectionMetadataUpdate(
	previous: ConversationOperationFactV2,
	next: ConversationOperationFactV2,
): boolean {
	if (previous.kind !== "tool" || next.kind !== "tool" || !next.connection)
		return false;
	const { connection: previousConnection, ...previousFact } = previous;
	const { connection: nextConnection, ...nextFact } = next;
	return (
		JSON.stringify(previousFact) === JSON.stringify(nextFact) &&
		JSON.stringify(previousConnection) !== JSON.stringify(nextConnection)
	);
}

/** Each attempt starts once; recovery can confirm an unknown original attempt. */
export function requireConversationOperationSuccessorV2(
	history: readonly ConversationOperationFactV2[],
	nextInput: ConversationOperationFactV2,
	metadataOnly = false,
): void {
	const next = parseConversationOperationFactV2(nextInput);
	const facts = parseConversationOperationHistoryV2(history);
	const previous = facts.findLast(
		(fact) => fact.operationRef === next.operationRef,
	);
	if (
		metadataOnly &&
		(!previous ||
			!(["completed", "failed", "unknown"] as const).some(
				(phase) => phase === previous.phase,
			) ||
			!isConnectionMetadataUpdate(previous, next))
	)
		invalid();
	if (
		facts.some(
			(fact) =>
				fact.attemptRef === next.attemptRef &&
				fact.operationRef !== next.operationRef,
		)
	)
		invalid();
	if (
		next.parentOperationRef !== undefined &&
		!facts.some((fact) => fact.operationRef === next.parentOperationRef)
	)
		invalid();
	if (!previous) {
		if (next.phase !== "intent") invalid();
		return;
	}
	if (operationBinding(previous) !== operationBinding(next)) invalid();
	// The association belongs to the original logical operation, including retries.
	requireConnectionSuccessor(previous, next);
	if (previous.attemptRef !== next.attemptRef) {
		if (
			next.phase !== "intent" ||
			(previous.phase !== "completed" && previous.phase !== "failed") ||
			facts.some((fact) => fact.attemptRef === next.attemptRef)
		)
			invalid();
		return;
	}
	// Later read-only verification changes evidence, never another tool outcome.
	if (isConnectionMetadataUpdate(previous, next)) return;
	if (
		(previous.startedAt !== undefined &&
			next.startedAt !== previous.startedAt) ||
		next.phase === "intent" ||
		previous.phase === "completed" ||
		previous.phase === "failed" ||
		(next.phase === "started" && previous.phase !== "intent") ||
		(next.phase === "completed" &&
			previous.phase !== "started" &&
			previous.phase !== "unknown") ||
		(next.phase === "unknown" && previous.phase === "unknown")
	)
		invalid();
}
