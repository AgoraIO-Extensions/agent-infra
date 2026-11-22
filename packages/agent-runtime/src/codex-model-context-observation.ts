import { randomUUID } from "node:crypto";
import type { CodexModelTurn } from "./codex-model-transport.js";

/**
 * Engineering Spec §18.5.2 模型上下文 and Runtime HLD §8.5.6 step 5: an in-memory, read-only
 * observation of the model requests Codex actually sends through the protected transport.
 *
 * - Every authenticated inbound request gets a bounded sequence number before admission.
 * - Gaps only accumulate. A gap that cannot be attributed to an Execution degrades every
 *   Execution of that Session whose observation is still open.
 * - Markers are compared against the final JSON that is about to be sent, by JSON semantics,
 *   only in the fields that carry context. Marker values and bodies are never stored.
 * - The result is fixed only when the Execution is closed after the existing provider drain;
 *   one receipt per model attempt, each requiring the whole Execution to be complete.
 * - "written" (request body fully written) has no reliable observation and is not claimed.
 *
 * Nothing here can throw into, delay or change the transport, its journal or business results.
 */

export interface CodexModelContextScenarioV1 {
	readonly id: string;
	readonly version: number;
	/** Fixed, non-secret synthetic values of the approved scenario fixture. */
	readonly selfMarker: string;
	readonly foreignMarker: string;
}

/** The scenario catalog is frozen with the producer version (Spec §18.5.1 验收场景). */
export const codexModelContextProducerVersionV1 = "codex-model-context-1";
export const codexModelContextScenarioV1: CodexModelContextScenarioV1 =
	Object.freeze({
		id: "u1-model-context",
		version: 1,
		selfMarker: "AIX-U1-CONTEXT-SELF-7Q4M2W",
		foreignMarker: "AIX-U1-CONTEXT-FOREIGN-3K9P5T",
	});

export type CodexModelContextGapV1 =
	| "admission_rejected"
	| "turn_unmapped"
	| "body_invalid"
	| "endpoint_unknown"
	| "cancelled"
	| "not_inspected"
	| "attempt_unmapped"
	| "ambiguous_marker"
	| "opaque_context"
	| "compaction"
	| "capacity"
	| "observer_failed"
	| "transport_closed";

export interface CodexModelContextAttemptV1 {
	readonly executionId: string;
	readonly operationRef: string;
	readonly attemptRef: string;
}

export interface CodexModelContextTicketV1 {
	/** The native Turn the server resolved and bound for this request. */
	mapped(turn: CodexModelTurn): void;
	/** The original model operation/attempt the Driver persisted for this request. */
	bind(attempt: CodexModelContextAttemptV1 | undefined): void;
	/** The final request JSON, after rewriting, right before it is sent. */
	inspect(value: unknown): void;
	gap(reason: CodexModelContextGapV1): void;
	/** The request handler finished; an uninspected request without a gap becomes one. */
	finish(): void;
}

export interface CodexModelContextReceiptV1 {
	readonly operationRef: string;
	readonly attemptRef: string;
	/**
	 * Fixed when the request arrived, before anything was observed; an attempt the
	 * observation never saw gets one at closure and can only be UNPROVEN.
	 */
	readonly challengeRef: string;
	readonly selfMarkerPresent: boolean;
	readonly foreignMarkerAbsent: boolean;
	readonly observationComplete: boolean;
	/** The attempt's request was observed on its way out. */
	readonly observed: boolean;
}

interface Ticket {
	readonly sequence: number;
	readonly challengeRef: string;
	readonly conversationKey: string;
	attempt?: CodexModelContextAttemptV1;
	turnKey?: string;
	inspected: boolean;
	self: boolean;
	foreign: boolean;
	readonly gaps: Set<CodexModelContextGapV1>;
	finished: boolean;
}

const skippedKeys = new Set([
	"type",
	"role",
	"id",
	"call_id",
	"name",
	"status",
]);
const opaqueKeys = new Set(["encrypted_content"]);
const compactionTypes = new Set(["compaction", "compaction_summary"]);
const maximumDepth = 64;

/**
 * Semantic inspection of one final request. Only `input` (and a string `instructions`) carry
 * the Execution's context; tool definitions, model, metadata or URLs never count as a hit.
 */
export function inspectCodexModelContextV1(
	value: unknown,
	scenario: CodexModelContextScenarioV1,
):
	| {
			readonly self: boolean;
			readonly foreign: boolean;
			readonly gaps: readonly CodexModelContextGapV1[];
	  }
	| undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const request = value as Record<string, unknown>;
	const gaps = new Set<CodexModelContextGapV1>();
	const self = scenario.selfMarker.normalize("NFC");
	const foreign = scenario.foreignMarker.normalize("NFC");
	const hits = { self: false, foreign: false };
	const scan = (text: string) => {
		const normalized = text.normalize("NFC");
		if (normalized.includes(self)) hits.self = true;
		if (normalized.includes(foreign)) hits.foreign = true;
	};
	// Context held by the provider cannot be inspected here.
	for (const key of ["previous_response_id", "conversation", "prompt"])
		if (request[key] !== undefined && request[key] !== null)
			gaps.add("opaque_context");
	if (typeof request.instructions === "string") {
		const normalized = request.instructions.normalize("NFC");
		// A marker in the task instructions makes the result ambiguous.
		if (normalized.includes(self) || normalized.includes(foreign))
			gaps.add("ambiguous_marker");
	} else if (
		request.instructions !== undefined &&
		request.instructions !== null
	)
		gaps.add("body_invalid");
	const walk = (node: unknown, depth: number) => {
		if (depth > maximumDepth) {
			gaps.add("body_invalid");
			return;
		}
		if (typeof node === "string") {
			scan(node);
			return;
		}
		if (Array.isArray(node)) {
			for (const item of node) walk(item, depth + 1);
			return;
		}
		if (!node || typeof node !== "object") return;
		const record = node as Record<string, unknown>;
		if (typeof record.type === "string" && compactionTypes.has(record.type))
			gaps.add("compaction");
		for (const [key, child] of Object.entries(record)) {
			if (skippedKeys.has(key)) continue;
			if (opaqueKeys.has(key)) {
				if (typeof child === "string" && child.length > 0)
					gaps.add("opaque_context");
				continue;
			}
			walk(child, depth + 1);
		}
	};
	if (request.input === undefined) gaps.add("body_invalid");
	else walk(request.input, 0);
	return { self: hits.self, foreign: hits.foreign, gaps: [...gaps] };
}

export function createCodexModelContextObservationV1(options: {
	readonly scenario: CodexModelContextScenarioV1;
	/** Only Sessions of an Execution inside the deployment window are observed. */
	readonly observes: (conversationKey: string) => boolean;
	readonly maximumTickets?: number;
	readonly randomRef?: () => string;
}) {
	const randomRef = options.randomRef ?? randomUUID;
	const maximumTickets = options.maximumTickets ?? 4_096;
	let sequence = 0;
	let closed = false;
	const tickets = new Map<number, Ticket>();
	const executionGaps = new Map<string, Set<CodexModelContextGapV1>>();
	/** Sequences of unattributable gaps per Session; `lostBefore` covers trimmed entries. */
	const sessionGaps = new Map<string, { at: number[]; lostBefore: number }>();
	/** Sequence at which the previous Execution of the Session was closed. */
	const sessionClosedAt = new Map<string, number>();
	/** Executions already closed; a late request of one is a Session gap. */
	const closedExecutions = new Set<string>();
	const maximumSessionGaps = 1_024;

	const sessionGap = (conversationKey: string) => {
		const gaps = sessionGaps.get(conversationKey) ?? { at: [], lostBefore: 0 };
		gaps.at.push(++sequence);
		if (gaps.at.length > maximumSessionGaps)
			gaps.lostBefore = gaps.at.shift() ?? gaps.lostBefore;
		sessionGaps.set(conversationKey, gaps);
	};
	const recordGap = (ticket: Ticket, reason: CodexModelContextGapV1) => {
		ticket.gaps.add(reason);
		if (ticket.attempt) {
			const gaps = executionGaps.get(ticket.attempt.executionId) ?? new Set();
			gaps.add(reason);
			executionGaps.set(ticket.attempt.executionId, gaps);
		} else sessionGap(ticket.conversationKey);
	};
	const guard =
		<A extends unknown[]>(ticket: Ticket, run: (...args: A) => void) =>
		(...args: A) => {
			try {
				run(...args);
			} catch {
				try {
					recordGap(ticket, "observer_failed");
				} catch {
					// Observation stays incomplete; the request is unaffected.
				}
			}
		};

	return {
		/** Called for every request that passed the transport credential check. */
		inbound(conversationKey: string): CodexModelContextTicketV1 | undefined {
			try {
				if (closed || !options.observes(conversationKey)) return undefined;
				if (tickets.size >= maximumTickets) {
					sessionGap(conversationKey);
					return undefined;
				}
				const ticket: Ticket = {
					sequence: ++sequence,
					challengeRef: randomRef(),
					conversationKey,
					inspected: false,
					self: false,
					foreign: false,
					gaps: new Set(),
					finished: false,
				};
				tickets.set(ticket.sequence, ticket);
				return {
					mapped: guard(ticket, (turn: CodexModelTurn) => {
						if (turn.conversationKey !== conversationKey)
							recordGap(ticket, "turn_unmapped");
						else ticket.turnKey = `${turn.threadId}\u0000${turn.turnId}`;
					}),
					bind: guard(
						ticket,
						(attempt: CodexModelContextAttemptV1 | undefined) => {
							if (
								!attempt ||
								ticket.attempt ||
								![
									attempt.executionId,
									attempt.operationRef,
									attempt.attemptRef,
								].every((value) => typeof value === "string" && value)
							) {
								recordGap(ticket, "attempt_unmapped");
								return;
							}
							if (closedExecutions.has(attempt.executionId)) {
								recordGap(ticket, "attempt_unmapped");
								return;
							}
							ticket.attempt = { ...attempt };
							// Gaps seen before the binding stay with the Session as well.
							if (ticket.gaps.size > 0) {
								const gaps =
									executionGaps.get(attempt.executionId) ?? new Set();
								for (const gap of ticket.gaps) gaps.add(gap);
								executionGaps.set(attempt.executionId, gaps);
							}
						},
					),
					inspect: guard(ticket, (value: unknown) => {
						const result = inspectCodexModelContextV1(value, options.scenario);
						if (!result) {
							recordGap(ticket, "body_invalid");
							return;
						}
						ticket.inspected = true;
						ticket.self ||= result.self;
						ticket.foreign ||= result.foreign;
						for (const gap of result.gaps) recordGap(ticket, gap);
					}),
					gap: guard(ticket, (reason: CodexModelContextGapV1) =>
						recordGap(ticket, reason),
					),
					finish: guard(ticket, () => {
						if (ticket.finished) return;
						ticket.finished = true;
						if (!ticket.attempt) {
							// Never tied to an Execution: it already is, or now becomes, a
							// Session gap, and nothing else refers to it.
							if (ticket.gaps.size === 0) recordGap(ticket, "attempt_unmapped");
							tickets.delete(ticket.sequence);
							return;
						}
						if (!ticket.inspected && ticket.gaps.size === 0)
							recordGap(ticket, "not_inspected");
					}),
				};
			} catch {
				try {
					sessionGap(conversationKey);
				} catch {
					// Nothing to record into; the Session cannot close complete anyway.
				}
				return undefined;
			}
		},
		/** A Session-wide event, such as a compaction Turn, that cannot be tied to one request. */
		sessionGap(conversationKey: string): void {
			try {
				sessionGap(conversationKey);
			} catch {
				// See above.
			}
		},
		/**
		 * Fixes the receipts of one Execution after the existing provider drain. `attempts` is the
		 * Driver's committed set of model operation/attempts of the Execution; `drained` is false
		 * when the drain failed or was not reached, `recovered` when the Driver took the
		 * Execution over from an earlier process and cannot know its earlier requests.
		 */
		closeExecution(input: {
			readonly conversationKey: string;
			readonly executionId: string;
			readonly attempts: readonly {
				readonly operationRef: string;
				readonly attemptRef: string;
			}[];
			readonly drained: boolean;
			readonly recovered: boolean;
		}): readonly CodexModelContextReceiptV1[] {
			const own = [...tickets.values()].filter(
				(ticket) => ticket.attempt?.executionId === input.executionId,
			);
			// The Execution may have been open since the previous closure of its Session, or
			// since its own first request if that was earlier (overlapping Executions).
			const since = Math.min(
				sessionClosedAt.get(input.conversationKey) ?? 0,
				...own.map((ticket) => ticket.sequence - 1),
			);
			const sessionGapRecord = sessionGaps.get(input.conversationKey);
			const unattributed =
				sessionGapRecord !== undefined &&
				(since < sessionGapRecord.lostBefore ||
					sessionGapRecord.at.some((at) => at > since));
			const byAttempt = new Map(
				own.map((ticket) => [
					`${ticket.attempt?.operationRef}\u0000${ticket.attempt?.attemptRef}`,
					ticket,
				]),
			);
			const expected = new Set(
				input.attempts.map(
					(attempt) => `${attempt.operationRef}\u0000${attempt.attemptRef}`,
				),
			);
			const executionComplete =
				!closed &&
				input.drained &&
				!input.recovered &&
				!unattributed &&
				(executionGaps.get(input.executionId)?.size ?? 0) === 0 &&
				expected.size === input.attempts.length &&
				own.length === byAttempt.size &&
				own.every((ticket) => ticket.finished) &&
				[...byAttempt.keys()].every((key) => expected.has(key)) &&
				[...expected].every((key) => byAttempt.has(key));
			const receipts = input.attempts.map((attempt) => {
				const ticket = byAttempt.get(
					`${attempt.operationRef}\u0000${attempt.attemptRef}`,
				);
				const attemptComplete =
					ticket !== undefined &&
					ticket.finished &&
					ticket.inspected &&
					ticket.gaps.size === 0;
				return {
					operationRef: attempt.operationRef,
					attemptRef: attempt.attemptRef,
					challengeRef: ticket?.challengeRef ?? randomRef(),
					selfMarkerPresent: ticket?.self === true,
					foreignMarkerAbsent: ticket?.foreign !== true,
					observationComplete: executionComplete && attemptComplete,
					observed: ticket?.inspected === true,
				};
			});
			for (const ticket of own) tickets.delete(ticket.sequence);
			executionGaps.delete(input.executionId);
			closedExecutions.add(input.executionId);
			if (closedExecutions.size > 4_096)
				closedExecutions.delete(
					closedExecutions.values().next().value as string,
				);
			sessionClosedAt.set(input.conversationKey, ++sequence);
			// Gaps older than every still-open ticket of the Session can no longer matter.
			if (sessionGapRecord) {
				const oldestOpen = Math.min(
					sequence,
					...[...tickets.values()]
						.filter(
							(ticket) => ticket.conversationKey === input.conversationKey,
						)
						.map((ticket) => ticket.sequence - 1),
				);
				sessionGapRecord.at = sessionGapRecord.at.filter(
					(at) => at > oldestOpen,
				);
				if (
					sessionGapRecord.at.length === 0 &&
					sessionGapRecord.lostBefore <= oldestOpen
				)
					sessionGaps.delete(input.conversationKey);
			}
			return receipts;
		},
		/** A closed or restarted transport leaves every open observation incomplete. */
		close(): void {
			closed = true;
		},
	};
}

export type CodexModelContextObservationV1 = ReturnType<
	typeof createCodexModelContextObservationV1
>;
