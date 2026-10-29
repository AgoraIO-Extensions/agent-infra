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
