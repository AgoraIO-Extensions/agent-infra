import { expect, it } from "vitest";
import {
	type OperationsTaskFactV2,
	projectOperationsTaskV2,
} from "./operations-task.js";

const at = (second: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, second));
const window = { start: at(5).toISOString(), end: at(10).toISOString() };
const task = {
	executionId: "run",
	status: "failed" as const,
	createdAt: at(0),
	terminalAt: null,
	unknownSince: null,
};
const evidence = (facts: OperationsTaskFactV2[]) =>
	projectOperationsTaskV2(task, facts, window).evidence;
const fact = (
	kind: string,
	state: string,
	second: number,
): OperationsTaskFactV2 => ({ kind, state, at: at(second), code: null });

it.each([
	[7, 12],
	[2, 8],
])(
	"preserves verified model and queue endpoints when %s → %s crosses the window",
	(start, finish) => {
		const pair = { operationRef: "operation", attemptRef: "attempt" };
		const result = evidence([
			fact("task.status", "waiting", start),
			{
				...fact("model", "started", start),
				...pair,
				startedAt: at(start).toISOString(),
			},
			fact("execution.status", "submitted", finish),
			{
				...fact("model", "completed", finish),
				...pair,
				finishedAt: at(finish).toISOString(),
			},
		]);
		for (const stage of ["model", "queue"]) {
			expect(result).toContainEqual(
				expect.objectContaining({
					stage,
					state: "completed",
					observedAt: at(finish).toISOString(),
					startedAt: at(start).toISOString(),
					finishedAt: at(finish).toISOString(),
					durationMs: (finish - start) * 1000,
				}),
			);
		}
	},
);

it("omits unrelated out-of-window endpoints and keeps their durations unknown", () => {
	const result = evidence([
		fact("task.status", "waiting", 7),
		{
			...fact("tool", "started", 7),
			operationRef: "op",
			attemptRef: "first",
			startedAt: at(7).toISOString(),
		},
		fact("execution.status", "cancelled", 8),
		fact("execution.status", "submitted", 12),
		{
			...fact("tool", "completed", 12),
			operationRef: "op",
			attemptRef: "other",
			finishedAt: at(12).toISOString(),
		},
	]);
	expect(result.map(({ stage, durationMs }) => [stage, durationMs])).toEqual([
		["queue", null],
		["tool", null],
	]);
});

it("shows registered Turn failure codes and masks unknown codes in the same family", () => {
	const result = evidence([
		{
			...fact("dispatch-failure", "failed", 7),
			code: "RUNTIME_FILE_INPUT_REJECTED",
		},
		{
			...fact("dispatch-failure", "failed", 8),
			code: "RUNTIME_FILE_INPUT_UNKNOWN_EXTENSION",
		},
	]);
	expect(result.map(({ errorCode }) => errorCode)).toEqual([
		"RUNTIME_FILE_INPUT_REJECTED",
		null,
	]);
});
