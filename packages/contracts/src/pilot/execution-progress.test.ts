import { describe, expect, it } from "vitest";
import {
	ExecutionFailureCategoryV1Schema,
	ExecutionFailureProjectionV1Schema,
	executionProgressPhaseV1,
	executionToolDisplayNameV1,
} from "./execution-progress.ts";

const status = (value: string) => ({
	type: "execution.status",
	payload: { status: value },
});
const task = (value: string) => ({
	type: "task.status",
	payload: { status: value },
});
const operation = (input: {
	readonly kind: "model" | "tool";
	readonly phase: string;
	readonly operationRef?: string;
	readonly attemptRef?: string;
	readonly toolId?: string;
}) => ({
	type: "execution.operation",
	payload: {
		kind: input.kind,
		phase: input.phase,
		operationRef: input.operationRef ?? `${input.kind}-1`,
		attemptRef: input.attemptRef ?? "attempt-1",
		...(input.kind === "tool" ? { toolId: input.toolId ?? "shell" } : {}),
	},
});

describe("executionProgressPhaseV1", () => {
	it("derives the base phase only from persisted status facts", () => {
		expect(executionProgressPhaseV1([task("waiting")])).toEqual({
			kind: "queued",
		});
		expect(executionProgressPhaseV1([status("submitted")])).toEqual({
			kind: "preparing",
		});
		expect(
			executionProgressPhaseV1([status("submitted"), status("processing")]),
		).toEqual({ kind: "running" });
		// 没有事件时只用调用方给出的已持久状态；也没有时不显示阶段。
		expect(executionProgressPhaseV1([], "submitted")).toEqual({
			kind: "preparing",
		});
		expect(executionProgressPhaseV1([])).toBeNull();
	});

	it("shows no phase once the execution is terminal or unconfirmed", () => {
		for (const terminal of ["completed", "failed", "cancelled", "unknown"])
			expect(
				executionProgressPhaseV1([status("processing"), status(terminal)]),
			).toBeNull();
		expect(executionProgressPhaseV1([], "bogus")).toBeNull();
	});

	it("shows the tool that is actually running and returns to running when it ends", () => {
		const started = [
			status("processing"),
			operation({ kind: "tool", phase: "intent", toolId: "browser_navigate" }),
			operation({ kind: "tool", phase: "started", toolId: "browser_navigate" }),
		];
		expect(executionProgressPhaseV1(started)).toEqual({
			kind: "tool",
			toolId: "browser_navigate",
		});
		expect(
			executionProgressPhaseV1([
				...started,
				operation({
					kind: "tool",
					phase: "completed",
					toolId: "browser_navigate",
				}),
			]),
		).toEqual({ kind: "running" });
		// 结果待核实的调用不再算作进行中，不按时间推测它仍在运行。
		expect(
			executionProgressPhaseV1([
				...started,
				operation({
					kind: "tool",
					phase: "unknown",
					toolId: "browser_navigate",
				}),
			]),
		).toEqual({ kind: "running" });
	});

	it("uses the most recently updated running operation", () => {
		expect(
			executionProgressPhaseV1([
				status("processing"),
				operation({
					kind: "tool",
					phase: "started",
					operationRef: "a",
					toolId: "first",
				}),
				operation({
					kind: "tool",
					phase: "started",
					operationRef: "b",
					toolId: "second",
				}),
			]),
		).toEqual({ kind: "tool", toolId: "second" });
		expect(
			executionProgressPhaseV1([
				status("processing"),
				operation({
					kind: "tool",
					phase: "started",
					operationRef: "a",
					toolId: "first",
				}),
				operation({
					kind: "tool",
					phase: "started",
					operationRef: "b",
					toolId: "second",
				}),
				operation({
					kind: "tool",
					phase: "completed",
					operationRef: "b",
					toolId: "second",
				}),
			]),
		).toEqual({ kind: "tool", toolId: "first" });
	});

	it("reports a model retry only for a new attempt of the same model call", () => {
		const first = [
			status("processing"),
			operation({ kind: "model", phase: "started", attemptRef: "a1" }),
		];
		expect(executionProgressPhaseV1(first)).toEqual({ kind: "running" });
		const retrying = [
			...first,
			operation({ kind: "model", phase: "failed", attemptRef: "a1" }),
			operation({ kind: "model", phase: "intent", attemptRef: "a2" }),
		];
		expect(executionProgressPhaseV1(retrying)).toEqual({
			kind: "model_retry",
		});
		expect(
			executionProgressPhaseV1([
				...retrying,
				operation({ kind: "model", phase: "completed", attemptRef: "a2" }),
			]),
		).toEqual({ kind: "running" });
		// 不同的模型调用各自只有一次尝试，不是重试。
		expect(
			executionProgressPhaseV1([
				status("processing"),
				operation({ kind: "model", phase: "completed", operationRef: "m1" }),
				operation({ kind: "model", phase: "started", operationRef: "m2" }),
			]),
		).toEqual({ kind: "running" });
	});

	it("ignores malformed facts instead of guessing a phase", () => {
		expect(
			executionProgressPhaseV1([
				status("processing"),
				{
					type: "execution.operation",
					payload: { kind: "tool", phase: "started" },
				},
				{ type: "execution.operation", payload: null },
				{ type: "text.delta", payload: { text: "答案" } },
			]),
		).toEqual({ kind: "running" });
	});
});

describe("executionToolDisplayNameV1", () => {
	it("names browser tools like the Web browser card and keeps other tool ids", () => {
		expect(executionToolDisplayNameV1("browser_navigate")).toBe("打开页面");
		expect(executionToolDisplayNameV1("browser_observe")).toBe("读取页面");
		expect(executionToolDisplayNameV1("browser_interact")).toBe("操作页面");
		expect(executionToolDisplayNameV1("shell")).toBe("shell");
		expect(executionToolDisplayNameV1("constructor")).toBe("constructor");
	});
});

describe("ExecutionFailureCategoryV1Schema", () => {
	it("publishes the channel-neutral categories of Spec §16.1.1", () => {
		expect(ExecutionFailureCategoryV1Schema.options).toEqual([
			"model_unavailable",
			"agent_updating",
			"session_preparation_failed",
			"attachment_unreadable",
			"authorization_revoked",
			"relay_key_unavailable",
			"queue_timeout",
			"conversation_unavailable",
			"internal_error",
		]);
		expect(
			ExecutionFailureProjectionV1Schema.safeParse({
				category: "internal_error",
				message: "平台内部错误",
			}).success,
		).toBe(true);
		expect(
			ExecutionFailureProjectionV1Schema.safeParse({
				category: "internal_error",
				message: "",
			}).success,
		).toBe(false);
		expect(
			ExecutionFailureProjectionV1Schema.safeParse({
				category: "RUNTIME_DRIVER_INVALID",
				message: "x",
			}).success,
		).toBe(false);
	});
});
