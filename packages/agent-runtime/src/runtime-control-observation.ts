import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { RuntimeHostError } from "./errors.js";

/**
 * #4358 I2: fixed stdout diagnostics for the actual stages of a stop control
 * (engineering Spec §18.5.3). They only observe; nothing here authorizes,
 * changes a control result or is read back by the control path.
 */
export const runtimeControlEvidenceCodeV1 = "RUNTIME_CONTROL_EVIDENCE_V1";

export const RuntimeControlStageV1Schema = z.enum([
	"control_received",
	"control_validated",
	"latch_commit_confirmed",
	"original_result_read",
	"interrupt_write_accepted",
	"native_interrupt_ack",
	"terminal_commit_confirmed",
]);
export const RuntimeControlOutcomeV1Schema = z.enum([
	"observed",
	"rejected",
	"unknown",
	"not_required",
	"not_applicable",
]);
export const RuntimeControlReasonV1Schema = z.enum([
	"invalid_request",
	"authorization_denied",
	"stale_fence",
	"operation_conflict",
	"unavailable",
	"write_failed",
	"timeout",
	"disconnected",
	"protocol_invalid",
	"natural_terminal",
]);

const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const count = z.number().int().nonnegative().safe();
/**
 * #4360 round 6: a fixed U2 time field (Spec §18.5.3) is a UTC instant with at
 * most nanosecond precision, at most 30 characters. The writer emits
 * `Date#toISOString()` (24 characters).
 */
const utcInstant = z.iso.datetime().max(30);

/**
 * #4360 round 6: the reader's fixed input limits. The largest record the
 * closed schema admits (every reference at 128 characters, every optional
 * field present) serializes to under 1,900 characters, so a longer line is
 * never a U2 record. The overall limit bounds one collected Pod or instance
 * log; past it the reader stops and signs nothing.
 */
export const runtimeControlEvidenceMaxLineCharsV1 = 4_096;
export const runtimeControlEvidenceMaxInputCharsV1 = 16 * 1024 * 1024;

const RuntimeControlBindingV1Schema = z.strictObject({
	agentId: ref,
	conversationId: ref,
	executionId: ref,
	turnId: ref,
	sessionGeneration: z.number().int().positive().safe(),
	executionDeliveryFence: count,
	stopRequestId: ref,
	controlFence: count,
	controlPurpose: z.enum(["business", "control"]),
	controlRecordId: ref.optional(),
	controlReason: z
		.enum([
			"stop",
			"authorization_revoked",
			"recovery",
			"generation_isolation",
			"browser_handoff",
			"browser_side_effect",
		])
		.optional(),
	authorizationRecordId: ref.optional(),
});
export type RuntimeControlBindingV1 = z.infer<
	typeof RuntimeControlBindingV1Schema
>;

export const RuntimeControlEvidenceV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	code: z.literal(runtimeControlEvidenceCodeV1),
	stage: RuntimeControlStageV1Schema,
	outcome: RuntimeControlOutcomeV1Schema,
	reason: RuntimeControlReasonV1Schema.optional(),
	rpcCode: z.number().int().safe().optional(),
	clockId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
	podUid: z
		.string()
		.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
		.optional(),
	monoSequence: z.number().int().positive().safe(),
	observedAtUtc: utcInstant,
	elapsedMonoMs: count.optional(),
	...RuntimeControlBindingV1Schema.partial().shape,
	interruptTarget: count.optional(),
	interruptTargets: count.optional(),
	terminalStatus: z.enum(["completed", "failed", "cancelled"]).optional(),
	terminalRef: ref.optional(),
	terminalOccurredAtUtc: utcInstant.optional(),
});
export type RuntimeControlEvidenceV1 = z.infer<
	typeof RuntimeControlEvidenceV1Schema
>;

/** The handler-entry instant of one control, in both clock domains. */
export interface RuntimeControlMarkV1 {
	readonly utcMs: number;
	readonly mono: number;
}

export interface RuntimeControlObservationV1 {
	readonly stage: z.infer<typeof RuntimeControlStageV1Schema>;
	readonly outcome: z.infer<typeof RuntimeControlOutcomeV1Schema>;
	readonly reason?: z.infer<typeof RuntimeControlReasonV1Schema>;
	readonly rpcCode?: number;
	/** Without a verified binding the record carries no request identifiers. */
	readonly binding?: RuntimeControlBindingV1;
	/** The control's handler entry; `control_received` reports this instant. */
	readonly mark?: RuntimeControlMarkV1;
	readonly atMark?: boolean;
	readonly interrupt?: { readonly target: number; readonly targets: number };
	readonly terminal?: {
		readonly status: "completed" | "failed" | "cancelled";
		readonly ref: string;
		readonly occurredAt: string;
	};
}

export interface RuntimeControlObserverV1 {
	readonly clockId: string;
	mark(): RuntimeControlMarkV1;
	/** Never throws and never waits; a dropped record leaves a sequence gap. */
	emit(observation: RuntimeControlObservationV1): void;
}

export function createRuntimeControlObserverV1(
	options: {
		readonly output?: {
			write(line: string): boolean;
			on?(event: "drain" | "error", listener: () => void): unknown;
		};
		readonly podUid?: string;
		readonly instanceId?: string;
		readonly now?: () => number;
		readonly monotonic?: () => number;
	} = {},
): RuntimeControlObserverV1 {
	const output = options.output ?? process.stdout;
	const now = options.now ?? Date.now;
	const monotonic = options.monotonic ?? (() => performance.now());
	const podUid = options.podUid?.toLowerCase();
	const reportedPodUid =
		podUid &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
			podUid,
		)
			? podUid
			: undefined;
	const clockId = createHash("sha256")
		.update(`${podUid ?? ""}\n${options.instanceId ?? randomUUID()}`)
		.digest("base64url")
		.slice(0, 22);
	let sequence = 0;
	let blocked = false;
	try {
		output.on?.("drain", () => {
			blocked = false;
		});
		output.on?.("error", () => {
			blocked = true;
		});
	} catch {
		blocked = true;
	}
	return {
		clockId,
		mark: () => ({ utcMs: now(), mono: monotonic() }),
		emit(observation) {
			sequence += 1;
			try {
				if (blocked) return;
				const mono = observation.atMark ? observation.mark?.mono : monotonic();
				const parsed = RuntimeControlEvidenceV1Schema.safeParse({
					schemaVersion: 1,
					code: runtimeControlEvidenceCodeV1,
					stage: observation.stage,
					outcome: observation.outcome,
					...(observation.reason ? { reason: observation.reason } : {}),
					...(observation.rpcCode === undefined
						? {}
						: { rpcCode: observation.rpcCode }),
					clockId,
					...(reportedPodUid ? { podUid: reportedPodUid } : {}),
					monoSequence: sequence,
					observedAtUtc: new Date(
						observation.atMark && observation.mark
							? observation.mark.utcMs
							: now(),
					).toISOString(),
					...(observation.mark && mono !== undefined
						? {
								elapsedMonoMs: Math.max(
									0,
									Math.floor(mono - observation.mark.mono),
								),
							}
						: {}),
					...(observation.binding ? { ...observation.binding } : {}),
					...(observation.interrupt
						? {
								interruptTarget: observation.interrupt.target,
								interruptTargets: observation.interrupt.targets,
							}
						: {}),
					...(observation.terminal
						? {
								terminalStatus: observation.terminal.status,
								terminalRef: observation.terminal.ref,
								terminalOccurredAtUtc: observation.terminal.occurredAt,
							}
						: {}),
				});
				if (!parsed.success) return;
				if (!output.write(`${JSON.stringify(parsed.data)}\n`)) blocked = true;
			} catch {
				blocked = true;
			}
		},
	};
}

/** Fixed rejection class of a control failure; never the error text. */
export function runtimeControlRejectionReasonV1(
	error: unknown,
): z.infer<typeof RuntimeControlReasonV1Schema> {
	if (!(error instanceof RuntimeHostError)) return "unavailable";
	if (error.code === "RUNTIME_GRANT_INVALID") return "authorization_denied";
	if (error.code === "RUNTIME_REQUEST_INVALID") return "invalid_request";
	if (error.code === "RUNTIME_FENCE_STALE") return "stale_fence";
	if (error.code === "RUNTIME_OPERATION_CONFLICT") return "operation_conflict";
	return "unavailable";
}

export interface RuntimeControlObservationContextV1 {
	readonly observer: RuntimeControlObserverV1;
	readonly binding: RuntimeControlBindingV1;
	readonly mark: RuntimeControlMarkV1;
}

const context = new AsyncLocalStorage<RuntimeControlObservationContextV1>();

/** Same-process correlation for observation only; never an authority source. */
export function withRuntimeControlObservationV1<T>(
	value: RuntimeControlObservationContextV1 | undefined,
	work: () => T,
): T {
	return value ? context.run(value, work) : work();
}

export function currentRuntimeControlObservationV1() {
	return context.getStore();
}

export function emitRuntimeControlObservationV1(
	value: RuntimeControlObservationContextV1 | undefined,
	observation: Omit<RuntimeControlObservationV1, "binding" | "mark">,
) {
	value?.observer.emit({
		...observation,
		binding: value.binding,
		mark: value.mark,
	});
}

const controlBindingKeysV1 = Object.keys(
	RuntimeControlBindingV1Schema.shape,
) as Array<keyof RuntimeControlBindingV1>;

const requiredStages = [
	"control_received",
	"control_validated",
	"interrupt_write_accepted",
	"native_interrupt_ack",
	"terminal_commit_confirmed",
] as const;

/**
 * #4360: every native Turn the control interrupted needs its own write and
 * ACK record. All interrupt records must declare the same target count, and
 * each target index in that range must carry both stages; one target's
 * records never stand in for another's. #4360 round 5: the work is linear in
 * the records read; the declared count is only compared, never iterated.
 */
function interruptTargetsComplete(
	records: readonly RuntimeControlEvidenceV1[],
) {
	const interrupts = records.filter(
		(record) =>
			record.stage === "interrupt_write_accepted" ||
			record.stage === "native_interrupt_ack",
	);
	const counts = new Set(interrupts.map((record) => record.interruptTargets));
	const [count] = counts;
	if (counts.size !== 1 || count === undefined || count < 1) return false;
	if (
		!interrupts.every(
			(record) =>
				record.interruptTarget !== undefined && record.interruptTarget < count,
		)
	)
		return false;
	// Every index is in [0, count), so `count` distinct indexes are all of them.
	return (["interrupt_write_accepted", "native_interrupt_ack"] as const).every(
		(stage) =>
			new Set(
				interrupts
					.filter((record) => record.stage === stage)
					.map((record) => record.interruptTarget),
			).size === count,
	);
}

/** First index of a sorted array whose value is not below `target`. */
function lowerBound(values: readonly number[], target: number) {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((values[middle] ?? Number.POSITIVE_INFINITY) < target) low = middle + 1;
		else high = middle;
	}
	return low;
}

const controlBindingCommonV1 = RuntimeControlBindingV1Schema.omit({
	controlPurpose: true,
	controlRecordId: true,
	controlReason: true,
	authorizationRecordId: true,
}).shape;

/**
 * #4360 round 4, reader only: the complete original control binding a
 * timeline needs before it can be signed (Spec §18.5.1/§18.5.3). Every scope,
 * generation and fence field is required; a control-purpose Stop carries its
 * control record and reason, a business Stop its authorization record, and
 * neither may carry the other's fields.
 */
const RuntimeControlCompleteBindingV1Schema = z.discriminatedUnion(
	"controlPurpose",
	[
		z.strictObject({
			...controlBindingCommonV1,
			controlPurpose: z.literal("control"),
			controlRecordId: ref,
			controlReason: RuntimeControlBindingV1Schema.shape.controlReason.unwrap(),
		}),
		z.strictObject({
			...controlBindingCommonV1,
			controlPurpose: z.literal("business"),
			authorizationRecordId: ref,
		}),
	],
);

function hasCompleteBinding(record: RuntimeControlEvidenceV1) {
	return RuntimeControlCompleteBindingV1Schema.safeParse(
		Object.fromEntries(
			controlBindingKeysV1
				.filter((name) => record[name] !== undefined)
				.map((name) => [name, record[name]]),
		),
	).success;
}

/**
 * #4360 rounds 3 and 4: a timeline is signed only from a positive whitelist
 * (Spec §18.5.3); a stage name alone is not proof. Each record needs the
 * complete original binding, its control's elapsed monotonic time, no RPC
 * error code, an outcome and reason its stage allows, and exactly its
 * stage's result fields:
 * - receipt, validation, the durable latch and a replayed read are observed;
 * - the original terminal is observed, at most for a natural terminal, and
 *   carries the finite status, event reference and time;
 * - an interrupt write or ACK is observed, or `not_required` for a natural
 *   terminal; only the ACK may be `not_applicable` (a protocol without an
 *   interrupt response). Both carry their target index and count.
 * Anything else leaves the timeline unproven.
 */
function provesStage(record: RuntimeControlEvidenceV1) {
	if (
		record.elapsedMonoMs === undefined ||
		record.rpcCode !== undefined ||
		!hasCompleteBinding(record)
	)
		return false;
	const interrupt =
		record.stage === "interrupt_write_accepted" ||
		record.stage === "native_interrupt_ack";
	const terminal = record.stage === "terminal_commit_confirmed";
	const interruptFields = [record.interruptTarget, record.interruptTargets];
	const terminalFields = [
		record.terminalStatus,
		record.terminalRef,
		record.terminalOccurredAtUtc,
	];
	if (
		!interruptFields.every((field) => (field !== undefined) === interrupt) ||
		!terminalFields.every((field) => (field !== undefined) === terminal)
	)
		return false;
	const observed = record.outcome === "observed";
	const natural = record.reason === "natural_terminal";
	switch (record.stage) {
		case "control_received":
		case "control_validated":
		case "latch_commit_confirmed":
		case "original_result_read":
			return observed && record.reason === undefined;
		case "terminal_commit_confirmed":
			return observed && (record.reason === undefined || natural);
		case "interrupt_write_accepted":
			return (
				(observed && record.reason === undefined) ||
				(record.outcome === "not_required" && natural)
			);
		case "native_interrupt_ack":
			return (
				(observed && record.reason === undefined) ||
				(record.outcome === "not_required" && natural) ||
				(record.outcome === "not_applicable" && record.reason === undefined)
			);
	}
}

export interface RuntimeControlTimelineV1 {
	readonly clockId: string;
	readonly executionId: string;
	readonly stopRequestId: string;
	readonly status: "complete" | "rejected" | "unproven";
	readonly records: readonly RuntimeControlEvidenceV1[];
}

/**
 * Reader whitelist: keeps only records that pass the closed schema, groups
 * them per clock domain and control, and marks a control unproven when a
 * stage is missing or unknown, or its clock domain dropped a record inside
 * its span. Clock domains are never merged or ordered by UTC.
 */
export function projectRuntimeControlEvidenceV1(lines: Iterable<string>) {
	const records: RuntimeControlEvidenceV1[] = [];
	let rejectedLines = 0;
	let inputChars = 0;
	let truncated = false;
	for (const line of lines) {
		inputChars += line.length;
		if (inputChars > runtimeControlEvidenceMaxInputCharsV1) {
			truncated = true;
			break;
		}
		if (line.length > runtimeControlEvidenceMaxLineCharsV1) {
			if (line.includes(runtimeControlEvidenceCodeV1)) rejectedLines += 1;
			continue;
		}
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		if (
			!value ||
			typeof value !== "object" ||
			(value as { code?: unknown }).code !== runtimeControlEvidenceCodeV1
		)
			continue;
		const parsed = RuntimeControlEvidenceV1Schema.safeParse(value);
		if (parsed.success) records.push(parsed.data);
		else rejectedLines += 1;
	}
	const sequences = new Map<string, Set<number>>();
	for (const record of records) {
		const seen = sequences.get(record.clockId) ?? new Set<number>();
		seen.add(record.monoSequence);
		sequences.set(record.clockId, seen);
	}
	// #4360 round 5: the distinct sequences each clock domain actually wrote,
	// sorted once; a span is checked by counting them, never by walking it.
	const sortedSequences = new Map<string, number[]>();
	for (const [clockId, seen] of sequences)
		sortedSequences.set(
			clockId,
			[...seen].sort((a, b) => a - b),
		);
	// #4360 MUST-1: a timeline is one clock domain and one complete original
	// control binding; records of a renewed fence or a replaced scope never join.
	const controls = new Map<string, RuntimeControlEvidenceV1[]>();
	for (const record of records) {
		if (!record.executionId || !record.stopRequestId) continue;
		const key = JSON.stringify([
			record.clockId,
			...controlBindingKeysV1.map((name) => record[name] ?? null),
		]);
		const group = controls.get(key);
		if (group) group.push(record);
		else controls.set(key, [record]);
	}
	const timelines: RuntimeControlTimelineV1[] = [];
	for (const group of controls.values()) {
		const ordered = [...group].sort((a, b) => a.monoSequence - b.monoSequence);
		const first = ordered[0];
		const last = ordered.at(-1);
		if (!first || !last) continue;
		// The span is gap-free only if its clock domain wrote every sequence in
		// it: the count of distinct written sequences inside equals its width.
		const written = sortedSequences.get(first.clockId) ?? [];
		const gap =
			lowerBound(written, last.monoSequence + 1) -
				lowerBound(written, first.monoSequence) !==
			last.monoSequence - first.monoSequence + 1;
		const has = (stage: string) => ordered.some((r) => r.stage === stage);
		const rejected = ordered.some((r) => r.outcome === "rejected");
		const unknown = ordered.some((r) => r.outcome === "unknown");
		// #4360 MUST-2: a replayed result read proves nothing about the original
		// control; only the original latch and every later stage do.
		const complete =
			has("latch_commit_confirmed") &&
			requiredStages.every(has) &&
			ordered.every(provesStage) &&
			interruptTargetsComplete(ordered);
		timelines.push({
			clockId: first.clockId,
			executionId: first.executionId as string,
			stopRequestId: first.stopRequestId as string,
			status:
				truncated || gap || unknown
					? "unproven"
					: rejected
						? "rejected"
						: complete
							? "complete"
							: "unproven",
			records: ordered,
		});
	}
	return { records, rejectedLines, truncated, timelines };
}
