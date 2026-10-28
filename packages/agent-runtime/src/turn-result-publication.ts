import {
	type RuntimeEvent,
	type RuntimeOperationFactV2,
	RuntimeOperationFactV2Schema,
} from "@agent-infra/contracts/runtime";
import { RuntimeHostError } from "./errors.js";
import {
	isSandboxResultPlanV1,
	type SandboxResultEntryV1,
	type SandboxResultPlanV1,
	settleSandboxResultsWithoutBridgeV1,
} from "./sandbox-result-references.js";

/**
 * #3226：Claude 与 Session（Pi、ACP）Driver 共用的 Turn 级发布状态。
 *
 * 原生 Turn 以 completed 结束、最终回答已确认后保存发布计划；`stopReason`/`checkpoint`
 * 记录原生终态，计划收敛后才写终态事件，重启时沿已保存的进度继续。
 */
export interface TurnResultPublicationV1 {
	plan: SandboxResultPlanV1;
	readonly stopReason?: string;
	readonly checkpoint?: string;
}

interface PublishingTurn {
	events: RuntimeEvent[];
	operationFacts?: RuntimeOperationFactV2[];
	resultPublication?: TurnResultPublicationV1;
}

export function isTurnResultPublicationV1(
	value: unknown,
): value is TurnResultPublicationV1 {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const record = value as Record<string, unknown>;
	return (
		Object.keys(record).every((key) =>
			["plan", "stopReason", "checkpoint"].includes(key),
		) &&
		isSandboxResultPlanV1(record.plan) &&
		(record.stopReason === undefined ||
			typeof record.stopReason === "string") &&
		(record.checkpoint === undefined || typeof record.checkpoint === "string")
	);
}

/** 与 Driver 的 recordFact 相同的转换规则，在已有提交内追加一条操作事实。 */
export function appendTurnOperationFactV1(
	turn: Pick<PublishingTurn, "operationFacts">,
	input: RuntimeOperationFactV2,
	localTool = false,
) {
	const fact = RuntimeOperationFactV2Schema.parse(input);
	if (
		localTool &&
		(fact.kind !== "tool" ||
			fact.executionBoundary !== "sandbox-local" ||
			fact.phase === "intent")
	)
		throw new RuntimeHostError(
			"RUNTIME_OPERATION_CONFLICT",
			"Local tool facts cannot carry intent",
			409,
		);
	turn.operationFacts ??= [];
	const previous = turn.operationFacts
		.filter(
			(entry) =>
				entry.operationRef === fact.operationRef &&
				entry.attemptRef === fact.attemptRef,
		)
		.at(-1);
	const duplicate =
		previous &&
		previous.kind === fact.kind &&
		JSON.stringify(previous) === JSON.stringify(fact);
	if (duplicate) return;
	if (!previous) {
		if (fact.phase !== "intent" && !(localTool && fact.phase === "started"))
			throw new RuntimeHostError(
				"RUNTIME_OPERATION_CONFLICT",
				"Runtime operation must start with intent",
				409,
			);
	} else if (
		previous.kind !== fact.kind ||
		(previous.kind === "tool" &&
			fact.kind === "tool" &&
			(previous.toolId !== fact.toolId ||
				previous.executionBoundary !== fact.executionBoundary)) ||
		(previous.phase !== "intent" && previous.phase !== "started") ||
		fact.phase === "intent"
	)
		throw new RuntimeHostError(
			"RUNTIME_OPERATION_CONFLICT",
			"Runtime operation fact transition is invalid",
			409,
		);
	const latestPhases = new Map<string, RuntimeOperationFactV2["phase"]>();
	for (const entry of turn.operationFacts)
		latestPhases.set(
			JSON.stringify([entry.operationRef, entry.attemptRef]),
			entry.phase,
		);
	latestPhases.set(
		JSON.stringify([fact.operationRef, fact.attemptRef]),
		fact.phase,
	);
	let reservedSlots = 0;
	for (const phase of latestPhases.values()) {
		if (phase === "intent") reservedSlots += 2;
		else if (phase === "started") reservedSlots += 1;
	}
	if (turn.operationFacts.length + 1 + reservedSlots > 256)
		throw new RuntimeHostError(
			"RUNTIME_OPERATION_CONFLICT",
			"Runtime operation fact journal is full",
			409,
		);
	turn.operationFacts.push(fact);
}

/** journal 中同一引用、同一 descriptor 的已确认结果文件事件。 */
export function confirmedTurnResultFileIdV1(
	events: readonly RuntimeEvent[],
	entry: SandboxResultEntryV1,
) {
	const descriptor = entry.descriptor;
	if (!descriptor) return undefined;
	for (const event of events)
		if (
			event.type === "file" &&
			event.schemaVersion === 2 &&
			event.payload.workspaceReference === entry.workspaceReference &&
			event.payload.name === descriptor.name &&
			event.payload.mimeType === descriptor.mediaType &&
			event.payload.sizeBytes === descriptor.sizeBytes
		)
			return event.payload.fileId;
	return undefined;
}

/** 没有执行期文件交换上下文时，就地收敛中断的发布：不重发、不新建意图。 */
export function settleTurnResultPublicationV1(turn: PublishingTurn) {
	const publication = turn.resultPublication;
	if (!publication || publication.plan.settled) return;
	const settled = settleSandboxResultsWithoutBridgeV1(
		publication.plan,
		(entry) => confirmedTurnResultFileIdV1(turn.events, entry),
	);
	for (const fact of settled.facts) appendTurnOperationFactV1(turn, fact);
	publication.plan = settled.plan;
}
