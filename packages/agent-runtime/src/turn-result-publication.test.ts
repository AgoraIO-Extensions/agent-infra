import type {
	RuntimeEvent,
	RuntimeOperationFactV2,
} from "@agent-infra/contracts/runtime";
import { expect, it } from "vitest";
import {
	appendTurnOperationFactV1,
	publishTurnOperationFactsV1,
} from "./turn-result-publication.js";

function journalTurn() {
	return {
		executionId: "execution",
		events: [] as RuntimeEvent[],
		operationFacts: [] as RuntimeOperationFactV2[],
		sequence: 0,
	};
}
const append = (
	turn: ReturnType<typeof journalTurn>,
	fact: RuntimeOperationFactV2,
	localTool = false,
) => appendTurnOperationFactV1(turn, fact, turn, "fixture", localTool);

const tool = {
	kind: "tool" as const,
	toolId: "Bash",
	operationRef: "operation",
	attemptRef: "attempt",
};
it("allows only trusted local tool observations to start without intent", () => {
	const turn = journalTurn();
	append(
		turn,
		{ ...tool, executionBoundary: "sandbox-local", phase: "started" },
		true,
	);
	append(turn, {
		...tool,
		executionBoundary: "sandbox-local",
		phase: "completed",
	});
	expect(turn.operationFacts?.map((fact) => fact.phase)).toEqual([
		"started",
		"completed",
	]);
	expect(() => append(turn, { ...tool, phase: "started" }, true)).toThrow();
});
it("reserves the exit slot for an uncertain Shell and keeps full legacy cursors readable", () => {
	const shell = {
		...tool,
		toolId: "shell",
		executionBoundary: "sandbox-local",
	} as const;
	function filled(count: number) {
		const turn = journalTurn();
		for (let i = 0; i < count; i++) {
			const ref = String(Math.floor(i / 2));
			turn.operationFacts.push({
				...tool,
				operationRef: ref,
				attemptRef: ref,
				phase: i % 2 ? "completed" : "intent",
			});
		}
		publishTurnOperationFactsV1(turn, turn, "fixture");
		return turn;
	}
	const turn = filled(252);
	append(turn, { ...shell, phase: "started" }, true);
	append(turn, { ...shell, phase: "unknown" }, true);
	expect(() =>
		append(turn, { ...tool, phase: "intent", operationRef: "new" }),
	).toThrow("journal is full");
	append(turn, { ...shell, phase: "completed" }, true);
	expect(turn.events.at(-1)?.payload).toMatchObject({ phase: "completed" });
	const legacy = filled(254);
	legacy.operationFacts.push({ ...shell, phase: "started" });
	publishTurnOperationFactsV1(legacy, legacy, "fixture");
	const preserved = [...legacy.events];
	expect(
		appendTurnOperationFactV1(
			legacy,
			{ ...shell, phase: "unknown" },
			legacy,
			"fixture",
			"recover-shell",
		),
	).toBe(false);
	expect(
		appendTurnOperationFactV1(
			legacy,
			{ ...shell, phase: "completed" },
			legacy,
			"fixture",
			"recover-shell",
		),
	).toBe(true);
	expect(legacy.events.slice(0, -1)).toEqual(preserved);
	const full = filled(254);
	full.operationFacts.push(
		{ ...shell, phase: "started" },
		{ ...shell, phase: "unknown" },
	);
	publishTurnOperationFactsV1(full, full, "fixture");
	const frozen = structuredClone(full);
	expect(
		appendTurnOperationFactV1(
			full,
			{ ...shell, phase: "completed" },
			full,
			"fixture",
			"recover-shell",
		),
	).toBe(false);
	expect(full).toEqual(frozen);
	const pair = filled(254);
	const cursors = [...pair.events];
	expect(
		appendTurnOperationFactV1(
			pair,
			{ ...shell, phase: "failed", failureCode: "operation_failed" },
			pair,
			"fixture",
			"recover-shell",
		),
	).toBe(true);
	expect(pair.events.slice(0, 254)).toEqual(cursors);
	expect(pair.operationFacts.slice(-2)).toEqual([
		{ ...shell, phase: "started" },
		{ ...shell, phase: "failed", failureCode: "operation_failed" },
	]);
	const mixed = filled(248);
	for (const operationRef of ["one", "two"])
		mixed.operationFacts.push(
			{ ...shell, operationRef, phase: "started" },
			{ ...shell, operationRef, phase: "unknown" },
		);
	mixed.operationFacts.push(
		{ ...tool, phase: "intent" },
		{ ...tool, phase: "started" },
	);
	publishTurnOperationFactsV1(mixed, mixed, "fixture");
	const issued = [...mixed.events];
	expect(append(mixed, { ...tool, phase: "unknown" })).toBe(true);
	expect(mixed.events.slice(0, 254)).toEqual(issued);
	expect(
		appendTurnOperationFactV1(
			mixed,
			{ ...shell, operationRef: "one", phase: "completed" },
			mixed,
			"fixture",
			"recover-shell",
		),
	).toBe(true);
	expect(
		appendTurnOperationFactV1(
			mixed,
			{ ...shell, operationRef: "two", phase: "completed" },
			mixed,
			"fixture",
			"recover-shell",
		),
	).toBe(false);
});
it("keeps mediated model and tool operations intent-first", () => {
	for (const toolId of [
		"Bash",
		"workspace.publish_result_file",
		"mcp.connection",
		"browser.click",
	])
		expect(() =>
			append(journalTurn(), { ...tool, toolId, phase: "started" }),
		).toThrow("must start with intent");
	expect(() =>
		append(journalTurn(), { ...tool, phase: "intent" }, true),
	).toThrow();
	expect(() =>
		append(journalTurn(), { ...tool, phase: "completed" }, true),
	).toThrow();
	expect(() =>
		append(
			journalTurn(),
			{
				kind: "model",
				operationRef: "model",
				attemptRef: "attempt",
				phase: "started",
				model: {
					configVersion: "config",
					modelOptionId: "option",
					modelId: "model",
				},
			},
			true,
		),
	).toThrow();
	const turn = journalTurn();
	append(turn, {
		...tool,
		toolId: "workspace.publish_result_file",
		phase: "intent",
	});
	append(turn, {
		...tool,
		toolId: "workspace.publish_result_file",
		phase: "started",
	});
	append(turn, {
		...tool,
		toolId: "workspace.publish_result_file",
		phase: "completed",
	});
	expect(turn.operationFacts).toHaveLength(3);
});

it("publishes a legacy unsealed fact suffix once without changing existing cursors", () => {
	const turn = journalTurn();
	const intent = { ...tool, phase: "intent" as const };
	append(turn, intent);
	const first = structuredClone(turn.events[0]);
	turn.operationFacts.push({
		...tool,
		phase: "started",
		startedAt: "2026-01-01T00:00:00.000Z",
	});
	publishTurnOperationFactsV1(turn, turn, "fixture");
	expect(turn.events).toHaveLength(2);
	expect(turn.events[0]).toEqual(first);
	expect(turn.events[1]).toMatchObject({
		schemaVersion: 2,
		type: "operation",
		cursor: "fixture-2",
		payload: { phase: "started" },
	});
	const published = structuredClone(turn);
	publishTurnOperationFactsV1(turn, turn, "fixture");
	expect(turn).toEqual(published);
});
it("rejects a conflicting published payload even with the same operation and phase", () => {
	const turn = journalTurn();
	append(turn, { ...tool, phase: "intent" });
	turn.operationFacts[0] = { ...tool, toolId: "other", phase: "intent" };
	expect(() => publishTurnOperationFactsV1(turn, turn, "fixture")).toThrow(
		"does not match its journal",
	);
});
it("preserves a sealed legacy turn instead of appending facts after its terminal event", () => {
	const turn = journalTurn();
	turn.operationFacts.push({ ...tool, phase: "intent" });
	turn.sequence = 1;
	turn.events.push({
		schemaVersion: 1,
		type: "completed",
		cursor: "fixture-1",
		adapterEventKey: "terminal",
		executionId: turn.executionId,
		occurredAt: "2026-01-01T00:00:00.000Z",
		payload: { status: "completed" },
	});
	const original = structuredClone(turn);
	publishTurnOperationFactsV1(turn, turn, "fixture");
	expect(turn).toEqual(original);
});
