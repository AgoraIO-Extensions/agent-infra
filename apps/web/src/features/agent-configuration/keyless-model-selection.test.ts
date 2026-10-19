import { describe, expect, it } from "vitest";

import {
	candidateKey,
	currentOptionLabel,
	initialKeylessModelRows,
	keylessCandidateLabels,
	keylessModelSelection,
	normalizedKeylessDefaults,
	optionIdFor,
} from "./keyless-model-selection.js";

const a = {
	endpointId: "relay",
	modelId: "model-a",
	reasoningLevels: ["medium", "high"],
};
const b = {
	endpointId: "relay",
	modelId: "model-b",
	reasoningLevels: ["low", "medium"],
};
const c = {
	endpointId: "other/ep",
	modelId: "model:c",
	reasoningLevels: ["low"],
};

it("uses trusted names without changing selection IDs and disambiguates repeated names", () => {
	const candidates = [
		{ ...a, displayName: "可信模型" },
		{ ...b, displayName: "可信模型" },
	];
	expect([...keylessCandidateLabels(candidates).entries()]).toEqual([
		[candidateKey(a), "可信模型（1）"],
		[candidateKey(b), "可信模型（2）"],
	]);
	const rows = initialKeylessModelRows(candidates, [
		{
			optionId: candidateKey(a),
			modelId: a.modelId,
			reasoningLevels: a.reasoningLevels,
		},
	]);
	expect(
		keylessModelSelection(candidates, rows, {
			optionId: candidateKey(a),
			level: "high",
		}).selection?.options[0],
	).toEqual({
		optionId: candidateKey(a),
		endpointId: a.endpointId,
		modelId: a.modelId,
		reasoningLevels: ["high", "medium"],
	});
	expect(
		currentOptionLabel(
			{
				optionId: candidateKey(a),
				modelId: a.modelId,
				displayName: "当前可信模型",
				reasoningLevels: a.reasoningLevels,
			},
			{ relay: "受信端点" },
		),
	).toBe("受信端点 · 当前可信模型");
});

it("omits a raw endpoint ID when deployment has no separate endpoint label", () => {
	const candidate = { ...a, displayName: "可信模型" };
	expect(
		keylessCandidateLabels([candidate], { relay: "relay" }).get(
			candidateKey(a),
		),
	).toBe("可信模型");
	expect(
		currentOptionLabel(
			{
				optionId: candidateKey(a),
				modelId: a.modelId,
				displayName: "可信模型",
				reasoningLevels: a.reasoningLevels,
			},
			{ relay: "relay" },
		),
	).toBe("可信模型");
});

describe("keyless model selection (#2421)", () => {
	it("encodes endpoint and model separately, like the application form and the server", () => {
		expect(optionIdFor("relay", "model-a")).toBe("relay:model-a");
		expect(optionIdFor("other/ep", "model:c")).toBe("other%2Fep:model%3Ac");
		expect(candidateKey(c)).toBe("other%2Fep:model%3Ac");
	});

	it("pre-checks the currently enabled models and keeps only levels the Key still offers", () => {
		const rows = initialKeylessModelRows(
			[a, b, c],
			[
				{
					optionId: "relay:model-a",
					modelId: "model-a",
					reasoningLevels: ["high", "xhigh"],
				},
				// 早期未编码的选项 ID 仍能对应到候选。
				{
					optionId: "other/ep:model:c",
					modelId: "model:c",
					reasoningLevels: ["low"],
				},
			],
		);
		expect(rows[candidateKey(a)]).toEqual({ checked: true, levels: ["high"] });
		expect(rows[candidateKey(b)]).toEqual({ checked: false, levels: [] });
		expect(rows[candidateKey(c)]).toEqual({ checked: true, levels: ["low"] });
	});

	it("falls back to all offered levels when none of the current levels is offered anymore", () => {
		const rows = initialKeylessModelRows(
			[a],
			[
				{
					optionId: "relay:model-a",
					modelId: "model-a",
					reasoningLevels: ["xhigh"],
				},
			],
		);
		expect(rows[candidateKey(a)]).toEqual({
			checked: true,
			levels: ["medium", "high"],
		});
	});

	it("matches by model id only when exactly one candidate has that model", () => {
		const odd = [
			{ optionId: "custom-id", modelId: "model-a", reasoningLevels: ["high"] },
		];
		expect(initialKeylessModelRows([a, b], odd)[candidateKey(a)]?.checked).toBe(
			true,
		);
		const twin = { ...a, endpointId: "second" };
		const rows = initialKeylessModelRows([a, twin], odd);
		expect(rows[candidateKey(a)]?.checked).toBe(false);
		expect(rows[candidateKey(twin)]?.checked).toBe(false);
	});

	it("keeps the preferred default while it is still selected, otherwise moves to the first selected model", () => {
		const rows = {
			[candidateKey(a)]: { checked: true, levels: ["high", "medium"] },
			[candidateKey(b)]: { checked: true, levels: ["low"] },
			[candidateKey(c)]: { checked: false, levels: [] },
		};
		expect(
			normalizedKeylessDefaults([a, b, c], rows, {
				optionId: candidateKey(b),
				level: "low",
			}),
		).toEqual({ optionId: candidateKey(b), level: "low" });
		// 偏好的档位不属于当前默认模型时取该模型的第一个档位（字典序）。
		expect(
			normalizedKeylessDefaults([a, b, c], rows, {
				optionId: candidateKey(b),
				level: "high",
			}),
		).toEqual({ optionId: candidateKey(b), level: "low" });
		// 偏好的模型被取消勾选。
		expect(
			normalizedKeylessDefaults([a, b, c], rows, {
				optionId: candidateKey(c),
				level: "low",
			}),
		).toEqual({ optionId: candidateKey(a), level: "high" });
		expect(
			normalizedKeylessDefaults(
				[a],
				{ [candidateKey(a)]: { checked: false, levels: [] } },
				{ optionId: "", level: "" },
			),
		).toEqual({ optionId: "", level: "" });
	});

	it("builds the request with sorted reasoning levels, matching the server's admitted selection", () => {
		const rows = {
			[candidateKey(a)]: { checked: true, levels: ["medium", "high"] },
			[candidateKey(b)]: { checked: true, levels: ["medium", "low"] },
		};
		const result = keylessModelSelection([a, b], rows, {
			optionId: candidateKey(a),
			level: "medium",
		});
		expect(result.selection).toEqual({
			options: [
				{
					optionId: "relay:model-a",
					endpointId: "relay",
					modelId: "model-a",
					reasoningLevels: ["high", "medium"],
				},
				{
					optionId: "relay:model-b",
					endpointId: "relay",
					modelId: "model-b",
					reasoningLevels: ["low", "medium"],
				},
			],
			defaultOptionId: "relay:model-a",
			defaultReasoningLevel: "medium",
		});
	});

	it.each([
		[
			"no model is checked",
			{ [candidateKey(a)]: { checked: false, levels: [] } },
			{ optionId: "", level: "" },
			"no_model",
		],
		[
			"a checked model has no level",
			{ [candidateKey(a)]: { checked: true, levels: [] } },
			{ optionId: candidateKey(a), level: "" },
			"no_reasoning_level",
		],
		[
			"the default is not selected",
			{ [candidateKey(a)]: { checked: true, levels: ["high"] } },
			{ optionId: "", level: "" },
			"no_default",
		],
		[
			"the default level is not enabled",
			{ [candidateKey(a)]: { checked: true, levels: ["high"] } },
			{ optionId: candidateKey(a), level: "medium" },
			"no_default",
		],
	] as const)(
		"reports a problem instead of a selection when %s",
		(_label, rows, defaults, problem) => {
			const result = keylessModelSelection([a], rows, defaults);
			expect(result.selection).toBeUndefined();
			expect(result.problem).toBe(problem);
		},
	);
});
