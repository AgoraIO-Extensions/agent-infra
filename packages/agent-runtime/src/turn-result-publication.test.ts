import type { RuntimeOperationFactV2 } from "@agent-infra/contracts/runtime";
import { expect, it } from "vitest";
import { appendTurnOperationFactV1 } from "./turn-result-publication.js";

const tool = {
	kind: "tool" as const,
	toolId: "Bash",
	operationRef: "operation",
	attemptRef: "attempt",
};
it("allows only trusted local tool observations to start without intent", () => {
	const turn: { operationFacts?: RuntimeOperationFactV2[] } = {};
	appendTurnOperationFactV1(
		turn,
		{ ...tool, executionBoundary: "sandbox-local", phase: "started" },
		true,
	);
	appendTurnOperationFactV1(turn, {
		...tool,
		executionBoundary: "sandbox-local",
		phase: "completed",
	});
	expect(turn.operationFacts?.map((fact) => fact.phase)).toEqual([
		"started",
		"completed",
	]);
	expect(() =>
		appendTurnOperationFactV1(turn, { ...tool, phase: "started" }, true),
	).toThrow();
});
it("keeps mediated model and tool operations intent-first", () => {
	for (const toolId of [
		"Bash",
		"workspace.publish_result_file",
		"mcp.connection",
		"browser.click",
	])
		expect(() =>
			appendTurnOperationFactV1({}, { ...tool, toolId, phase: "started" }),
		).toThrow("must start with intent");
	expect(() =>
		appendTurnOperationFactV1({}, { ...tool, phase: "intent" }, true),
	).toThrow();
	expect(() =>
		appendTurnOperationFactV1({}, { ...tool, phase: "completed" }, true),
	).toThrow();
	expect(() =>
		appendTurnOperationFactV1(
			{},
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
	const turn: { operationFacts?: RuntimeOperationFactV2[] } = {};
	appendTurnOperationFactV1(turn, {
		...tool,
		toolId: "workspace.publish_result_file",
		phase: "intent",
	});
	appendTurnOperationFactV1(turn, {
		...tool,
		toolId: "workspace.publish_result_file",
		phase: "started",
	});
	appendTurnOperationFactV1(turn, {
		...tool,
		toolId: "workspace.publish_result_file",
		phase: "completed",
	});
	expect(turn.operationFacts).toHaveLength(3);
});
