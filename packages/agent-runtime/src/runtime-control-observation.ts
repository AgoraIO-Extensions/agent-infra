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
	observedAtUtc: z.iso.datetime(),
	elapsedMonoMs: count.optional(),
	...RuntimeControlBindingV1Schema.partial().shape,
	interruptTarget: count.optional(),
	interruptTargets: count.optional(),
	terminalStatus: z.enum(["completed", "failed", "cancelled"]).optional(),
	terminalRef: ref.optional(),
	terminalOccurredAtUtc: z.iso.datetime().optional(),
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

const requiredStages = [
	"control_received",
	"control_validated",
	"interrupt_write_accepted",
	"native_interrupt_ack",
	"terminal_commit_confirmed",
] as const;

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
	for (const line of lines) {
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
	const controls = new Map<string, RuntimeControlEvidenceV1[]>();
	for (const record of records) {
		if (!record.executionId || !record.stopRequestId) continue;
		const key = JSON.stringify([
			record.clockId,
			record.executionId,
			record.stopRequestId,
		]);
		controls.set(key, [...(controls.get(key) ?? []), record]);
	}
	const timelines: RuntimeControlTimelineV1[] = [];
	for (const group of controls.values()) {
		const ordered = [...group].sort((a, b) => a.monoSequence - b.monoSequence);
		const first = ordered[0];
		const last = ordered.at(-1);
		if (!first || !last) continue;
		const seen = sequences.get(first.clockId) ?? new Set<number>();
		let gap = false;
		for (let item = first.monoSequence; item <= last.monoSequence; item += 1)
			if (!seen.has(item)) gap = true;
		const has = (stage: string) => ordered.some((r) => r.stage === stage);
		const rejected = ordered.some((r) => r.outcome === "rejected");
		const unknown = ordered.some((r) => r.outcome === "unknown");
		const complete = has("original_result_read")
			? has("control_received") && has("control_validated")
			: has("latch_commit_confirmed") && requiredStages.every(has);
		timelines.push({
			clockId: first.clockId,
			executionId: first.executionId as string,
			stopRequestId: first.stopRequestId as string,
			status:
				gap || unknown
					? "unproven"
					: rejected
						? "rejected"
						: complete
							? "complete"
							: "unproven",
			records: ordered,
		});
	}
	return { records, rejectedLines, timelines };
}
