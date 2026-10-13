import { describe, expect, it } from "vitest";
import {
	assertCodexModelProfilesV1,
	validateCodexModelProfilesV1,
} from "./codex-model-profile.js";

const profiles = [
	{ model: "gpt-5.3-codex", reasoningLevels: ["low", "high"] },
	{ model: "gpt-5.2-codex", reasoningLevels: ["medium"] },
];

describe("fixed Codex model profiles", () => {
	it("matches exact and hyphen-separated model suffixes", () => {
		expect(() =>
			assertCodexModelProfilesV1({
				profiles,
				options: [
					{ modelId: "gpt-5.3-codex", reasoningLevels: ["high"] },
					{ modelId: "gpt-5.3-codex-2026-01-01", reasoningLevels: ["low"] },
				],
			}),
		).not.toThrow();
	});

	it.each([
		["missing model", "gpt-6.1-sol", ["high"]],
		["unrelated prefix", "gpt-5.30", ["high"]],
		["unsupported reasoning", "gpt-5.3-codex", ["ultra"]],
	] as const)("rejects %s", (_name, modelId, reasoningLevels) => {
		expect(() =>
			assertCodexModelProfilesV1({
				profiles,
				options: [{ modelId, reasoningLevels }],
			}),
		).toThrow("CODEX_MODEL_PROFILE_UNSUPPORTED");
	});

	it("chooses the longest matching profile", () => {
		const nested = [
			...profiles,
			{ model: "gpt-5.3-codex-2026", reasoningLevels: ["medium"] },
		];
		expect(() =>
			assertCodexModelProfilesV1({
				profiles: nested,
				options: [
					{
						modelId: "gpt-5.3-codex-2026-01-01",
						reasoningLevels: ["high"],
					},
				],
			}),
		).toThrow();
	});

	it("rejects malformed and duplicate profiles", () => {
		expect(() => validateCodexModelProfilesV1([])).toThrow();
		expect(() =>
			validateCodexModelProfilesV1([
				...profiles,
				{ model: "gpt-5.3-codex", reasoningLevels: ["high"] },
			]),
		).toThrow();
	});
});
