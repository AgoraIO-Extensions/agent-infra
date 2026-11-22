import { describe, expect, it } from "vitest";
import { RuntimeHostError } from "./errors.js";
import {
	createRuntimeControlObserverV1,
	projectRuntimeControlEvidenceV1,
	type RuntimeControlBindingV1,
	runtimeControlRejectionReasonV1,
} from "./runtime-control-observation.js";

const podUid = "0f4a7c52-9b3e-4d1a-8c7f-2e6b5a4d3c21";
const binding: RuntimeControlBindingV1 = {
	agentId: "agent-a",
	conversationId: "conversation-a",
	executionId: "execution-a",
	turnId: "turn-a",
	sessionGeneration: 1,
	executionDeliveryFence: 1,
	stopRequestId: "stop-a",
	controlFence: 1,
	controlPurpose: "control",
	controlRecordId: "control-a",
	controlReason: "authorization_revoked",
};

function sink(options: { refuse?: boolean; throws?: boolean } = {}) {
	const lines: string[] = [];
	const listeners = new Map<string, () => void>();
	return {
		lines,
		drain: () => listeners.get("drain")?.(),
		output: {
			write(line: string) {
				if (options.throws) throw new Error("synthetic EPIPE");
				lines.push(line.trimEnd());
				return !options.refuse;
			},
			on(event: "drain" | "error", listener: () => void) {
				listeners.set(event, listener);
			},
		},
	};
}

function observerFor(
	output: ReturnType<typeof sink>["output"],
	instance = "i1",
) {
	let utc = Date.parse("2026-11-21T21:00:00.000Z");
	let mono = 1000;
	return createRuntimeControlObserverV1({
		output,
		podUid,
		instanceId: instance,
		now: () => utc++,
		monotonic: () => (mono += 5),
	});
}

function fullStop(
	observer: ReturnType<typeof observerFor>,
	value: RuntimeControlBindingV1 = binding,
) {
	const mark = observer.mark();
	observer.emit({
		stage: "control_received",
		outcome: "observed",
		binding: value,
		mark,
		atMark: true,
	});
	for (const stage of ["control_validated", "latch_commit_confirmed"] as const)
		observer.emit({ stage, outcome: "observed", binding: value, mark });
	for (const stage of [
		"interrupt_write_accepted",
		"native_interrupt_ack",
	] as const)
		observer.emit({
			stage,
			outcome: "observed",
			binding: value,
			mark,
			interrupt: { target: 0, targets: 1 },
		});
	observer.emit({
		stage: "terminal_commit_confirmed",
		outcome: "observed",
		binding: value,
		mark,
		terminal: {
			status: "cancelled",
			ref: "codex-cursor-7",
			occurredAt: "2026-11-21T21:00:00.050Z",
		},
	});
}

describe("Runtime control observation (#4358 I2)", () => {
	it("writes the fixed record with handler-entry time, clock domain and monotonic order", () => {
		const out = sink();
		const observer = observerFor(out.output);
		fullStop(observer);
		const records = out.lines.map((line) => JSON.parse(line));
		expect(records.map((record) => record.stage)).toEqual([
			"control_received",
			"control_validated",
			"latch_commit_confirmed",
			"interrupt_write_accepted",
			"native_interrupt_ack",
			"terminal_commit_confirmed",
		]);
		expect(records.map((record) => record.monoSequence)).toEqual([
			1, 2, 3, 4, 5, 6,
		]);
		expect(records[0]).toEqual({
			schemaVersion: 1,
			code: "RUNTIME_CONTROL_EVIDENCE_V1",
			stage: "control_received",
			outcome: "observed",
			clockId: observer.clockId,
			podUid,
			monoSequence: 1,
			observedAtUtc: "2026-11-21T21:00:00.000Z",
			elapsedMonoMs: 0,
			...binding,
		});
		expect(records.slice(1).every((record) => record.elapsedMonoMs > 0)).toBe(
			true,
		);
		expect(records.every((record) => record.clockId === observer.clockId)).toBe(
			true,
		);
	});

	it("drops anything outside the closed schema and keeps the canary out of stdout", () => {
		const out = sink();
		const observer = observerFor(out.output);
		const canary = "sk-canary-0123456789abcdef /home/private/journal";
		observer.emit({
			stage: "control_validated",
			outcome: "observed",
			binding: {
				...binding,
				prompt: canary,
				grant: canary,
			} as unknown as RuntimeControlBindingV1,
		});
		observer.emit({
			stage: "control_validated",
			outcome: "observed",
			binding: { ...binding, executionId: canary },
		});
		observer.emit({
			stage: "control_received",
			outcome: "rejected",
			reason: "authorization_denied",
		});
		expect(out.lines.join("\n")).not.toContain("canary");
		expect(out.lines).toHaveLength(1);
		const rejected = JSON.parse(out.lines[0] ?? "{}");
		expect(rejected).toMatchObject({
			monoSequence: 3,
			reason: "authorization_denied",
		});
		expect(rejected.executionId).toBeUndefined();
	});

	it("never throws when stdout fails, and backpressure leaves a detectable gap", () => {
		const failing = observerFor(sink({ throws: true }).output);
		expect(() => fullStop(failing)).not.toThrow();

		const out = sink({ refuse: true });
		const observer = observerFor(out.output);
		fullStop(observer);
		// The first write was accepted but reported backpressure; later records
		// are dropped until drain, so the reader sees a sequence gap.
		expect(out.lines).toHaveLength(1);
		out.drain();
		observer.emit({ stage: "control_validated", outcome: "observed", binding });
		const view = projectRuntimeControlEvidenceV1(out.lines);
		expect(view.timelines).toHaveLength(1);
		expect(view.timelines[0]?.status).toBe("unproven");
	});

	it("projects one complete timeline per clock domain and control", () => {
		const out = sink();
		const observer = observerFor(out.output);
		fullStop(observer);
		const view = projectRuntimeControlEvidenceV1([
			"not json",
			JSON.stringify({ code: "CODEX_EXECUTOR_DRAIN_VERIFIED", podUid }),
			...out.lines,
		]);
		expect(view.rejectedLines).toBe(0);
		expect(view.timelines).toEqual([
			expect.objectContaining({
				clockId: observer.clockId,
				executionId: "execution-a",
				stopRequestId: "stop-a",
				status: "complete",
			}),
		]);
	});

	it("rejects tampered lines and never merges another control, Execution or restarted process", () => {
		const out = sink();
		const observer = observerFor(out.output);
		fullStop(observer);
		const other = {
			...binding,
			executionId: "execution-b",
			stopRequestId: "stop-b",
		};
		observer.emit({
			stage: "control_received",
			outcome: "observed",
			binding: other,
		});
		const restarted = observerFor(out.output, "i2");
		expect(restarted.clockId).not.toBe(observer.clockId);
		restarted.emit({
			stage: "native_interrupt_ack",
			outcome: "observed",
			binding,
		});
		const tampered = JSON.stringify({
			...JSON.parse(out.lines[1] ?? "{}"),
			message: "sk-canary",
		});
		const view = projectRuntimeControlEvidenceV1([...out.lines, tampered]);
		expect(view.rejectedLines).toBe(1);
		const byKey = Object.fromEntries(
			view.timelines.map((timeline) => [
				`${timeline.clockId === observer.clockId ? "first" : "restart"}:${timeline.executionId}`,
				timeline.status,
			]),
		);
		expect(byKey).toEqual({
			"first:execution-a": "complete",
			"first:execution-b": "unproven",
			"restart:execution-a": "unproven",
		});
	});

	it("keeps unknown and rejected stages distinct from proof", () => {
		const out = sink();
		const observer = observerFor(out.output);
		const mark = observer.mark();
		for (const stage of [
			"control_received",
			"control_validated",
			"latch_commit_confirmed",
			"interrupt_write_accepted",
		] as const)
			observer.emit({ stage, outcome: "observed", binding, mark });
		observer.emit({
			stage: "native_interrupt_ack",
			outcome: "unknown",
			reason: "timeout",
			binding,
			mark,
		});
		const stale = { ...binding, stopRequestId: "stop-stale" };
		observer.emit({
			stage: "control_received",
			outcome: "observed",
			binding: stale,
		});
		observer.emit({
			stage: "control_validated",
			outcome: "observed",
			binding: stale,
		});
		observer.emit({
			stage: "latch_commit_confirmed",
			outcome: "rejected",
			reason: "stale_fence",
			binding: stale,
		});
		const statuses = Object.fromEntries(
			projectRuntimeControlEvidenceV1(out.lines).timelines.map((timeline) => [
				timeline.stopRequestId,
				timeline.status,
			]),
		);
		expect(statuses).toEqual({
			"stop-a": "unproven",
			"stop-stale": "rejected",
		});
	});

	it("classifies failures by fixed code only", () => {
		expect(
			runtimeControlRejectionReasonV1(
				new RuntimeHostError("RUNTIME_FENCE_STALE", "stale", 409),
			),
		).toBe("stale_fence");
		expect(runtimeControlRejectionReasonV1(new Error("secret text"))).toBe(
			"unavailable",
		);
	});

	it("never joins records of different control bindings into one complete timeline (#4360 MUST-1)", () => {
		const out = sink();
		const observer = observerFor(out.output);
		const mark = observer.mark();
		const renewed = { ...binding, controlFence: 2 };
		for (const stage of [
			"control_received",
			"control_validated",
			"latch_commit_confirmed",
		] as const)
			observer.emit({ stage, outcome: "observed", binding, mark });
		for (const stage of [
			"interrupt_write_accepted",
			"native_interrupt_ack",
		] as const)
			observer.emit({ stage, outcome: "observed", binding: renewed, mark });
		observer.emit({
			stage: "terminal_commit_confirmed",
			outcome: "observed",
			binding: renewed,
			mark,
			terminal: {
				status: "cancelled",
				ref: "codex-cursor-7",
				occurredAt: "2026-11-21T21:00:00.050Z",
			},
		});
		for (const replaced of [
			{ ...binding, sessionGeneration: 2 },
			{ ...binding, executionDeliveryFence: 2 },
			{ ...binding, agentId: "agent-b" },
			{ ...binding, controlRecordId: "control-b" },
		])
			observer.emit({
				stage: "native_interrupt_ack",
				outcome: "observed",
				binding: replaced,
				mark,
			});
		const view = projectRuntimeControlEvidenceV1(out.lines);
		expect(view.timelines.length).toBeGreaterThan(1);
		expect(view.timelines.every((t) => t.status === "unproven")).toBe(true);
	});

	it("does not treat a replayed result as the original control timeline (#4360 MUST-2)", () => {
		const out = sink();
		const observer = observerFor(out.output);
		const mark = observer.mark();
		for (const stage of [
			"control_received",
			"control_validated",
			"original_result_read",
		] as const)
			observer.emit({ stage, outcome: "observed", binding, mark });
		expect(projectRuntimeControlEvidenceV1(out.lines).timelines).toEqual([
			expect.objectContaining({ status: "unproven" }),
		]);
		// With the original trajectory of the same binding present, it is complete.
		const full = sink();
		const second = observerFor(full.output);
		fullStop(second);
		const replayMark = second.mark();
		for (const stage of [
			"control_received",
			"control_validated",
			"original_result_read",
		] as const)
			second.emit({ stage, outcome: "observed", binding, mark: replayMark });
		expect(projectRuntimeControlEvidenceV1(full.lines).timelines).toEqual([
			expect.objectContaining({ status: "complete" }),
		]);
	});

	it("requires every interrupt target's write and ACK before a timeline is complete (#4360 per-target)", () => {
		const timeline = (
			targets: ReadonlyArray<
				readonly [
					"interrupt_write_accepted" | "native_interrupt_ack",
					number,
					"observed" | "not_required",
				]
			>,
			count = 2,
			natural = true,
		) => {
			const out = sink();
			const observer = observerFor(out.output);
			const mark = observer.mark();
			observer.emit({
				stage: "control_received",
				outcome: "observed",
				binding,
				mark,
				atMark: true,
			});
			for (const stage of [
				"control_validated",
				"latch_commit_confirmed",
			] as const)
				observer.emit({ stage, outcome: "observed", binding, mark });
			const interrupt = (target: number) => ({ target, targets: count });
			const [first, ...rest] = targets;
			if (first)
				observer.emit({
					stage: first[0],
					outcome: first[2],
					...(first[2] === "not_required" && natural
						? { reason: "natural_terminal" as const }
						: {}),
					binding,
					mark,
					interrupt: interrupt(first[1]),
				});
			observer.emit({
				stage: "terminal_commit_confirmed",
				outcome: "observed",
				binding,
				mark,
				terminal: {
					status: "cancelled",
					ref: "codex-cursor-9",
					occurredAt: "2026-11-21T21:00:00.050Z",
				},
			});
			for (const [stage, target, outcome] of rest)
				observer.emit({
					stage,
					outcome,
					...(outcome === "not_required" && natural
						? { reason: "natural_terminal" as const }
						: {}),
					binding,
					mark,
					interrupt: interrupt(target),
				});
			return projectRuntimeControlEvidenceV1(out.lines).timelines[0]?.status;
		};
		// Target 1's ACK was cut off at the end of the collected log: no gap.
		expect(
			timeline([
				["interrupt_write_accepted", 0, "observed"],
				["native_interrupt_ack", 0, "observed"],
				["interrupt_write_accepted", 1, "observed"],
			]),
		).toBe("unproven");
		// Target 1 is missing entirely.
		expect(
			timeline([
				["interrupt_write_accepted", 0, "observed"],
				["native_interrupt_ack", 0, "observed"],
			]),
		).toBe("unproven");
		// A target outside the declared count does not stand in for a missing one.
		expect(
			timeline([
				["interrupt_write_accepted", 0, "observed"],
				["native_interrupt_ack", 0, "observed"],
				["interrupt_write_accepted", 2, "observed"],
				["native_interrupt_ack", 2, "observed"],
			]),
		).toBe("unproven");
		expect(
			timeline([
				["interrupt_write_accepted", 0, "observed"],
				["native_interrupt_ack", 0, "observed"],
				["interrupt_write_accepted", 1, "not_required"],
				["native_interrupt_ack", 1, "not_required"],
			]),
		).toBe("complete");
		// #4360 round 3: not_required without a natural terminal basis.
		expect(
			timeline(
				[
					["interrupt_write_accepted", 0, "observed"],
					["native_interrupt_ack", 0, "observed"],
					["interrupt_write_accepted", 1, "not_required"],
					["native_interrupt_ack", 1, "not_required"],
				],
				2,
				false,
			),
		).toBe("unproven");
		expect(
			timeline([
				["interrupt_write_accepted", 0, "observed"],
				["native_interrupt_ack", 0, "observed"],
				["interrupt_write_accepted", 1, "observed"],
				["native_interrupt_ack", 1, "observed"],
			]),
		).toBe("complete");
	});

	it("does not sign stages that were not actually proven (#4360 round 3)", () => {
		const project = (
			outcome: "observed" | "not_applicable",
			terminal: boolean,
		) => {
			const out = sink();
			const observer = observerFor(out.output);
			const mark = observer.mark();
			observer.emit({
				stage: "control_received",
				outcome: "observed",
				binding,
				mark,
				atMark: true,
			});
			for (const stage of [
				"control_validated",
				"latch_commit_confirmed",
			] as const)
				observer.emit({ stage, outcome, binding, mark });
			for (const stage of [
				"interrupt_write_accepted",
				"native_interrupt_ack",
			] as const)
				observer.emit({
					stage,
					outcome: "observed",
					binding,
					mark,
					interrupt: { target: 0, targets: 1 },
				});
			observer.emit({
				stage: "terminal_commit_confirmed",
				outcome,
				binding,
				mark,
				...(terminal
					? {
							terminal: {
								status: "cancelled" as const,
								ref: "codex-cursor-7",
								occurredAt: "2026-11-21T21:00:00.050Z",
							},
						}
					: {}),
			});
			const view = projectRuntimeControlEvidenceV1(out.lines);
			expect(view.rejectedLines).toBe(0);
			return view.timelines[0]?.status;
		};
		// Validated, latch and terminal declared not_applicable, no terminal result.
		expect(project("not_applicable", false)).toBe("unproven");
		// Every stage observed, but the terminal carries no original result.
		expect(project("observed", false)).toBe("unproven");
		expect(project("observed", true)).toBe("complete");
	});
});
