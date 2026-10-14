import { expect, it } from "vitest";
import {
	type OpenCodeRuntimeOptions,
	resolveOpenCodeSkillHome,
	validateOpenCodeRuntimeOptions,
} from "./opencode-bootstrap.js";

const option = {
	modelOptionId: "primary",
	model: "claude-opus-5",
	reasoningLevels: ["high"],
	endpoint: "https://models.example.test/v1",
	authentication: "bearer" as const,
};

function options(
	override: Partial<OpenCodeRuntimeOptions> = {},
): OpenCodeRuntimeOptions {
	return {
		path: "/tmp/opencode-driver",
		executable: "/opt/opencode/bin/opencode",
		configVersion: "configuration-v4",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [option],
		...override,
	};
}

it("rejects keyless OpenCode startup without Host authorization", () => {
	expect(() => validateOpenCodeRuntimeOptions(options())).toThrow(
		"RUNTIME_CONFIGURATION_INVALID",
	);
});

it("accepts keyless OpenCode startup with Host authorization", () => {
	expect(() =>
		validateOpenCodeRuntimeOptions(
			options({ authorizeModelAction: async () => ({ relayKey: "key" }) }),
		),
	).not.toThrow();
});

it("retains static credential validation for legacy OpenCode options", () => {
	expect(() =>
		validateOpenCodeRuntimeOptions(
			options({
				configVersion: "configuration-v3",
				modelOptions: [{ ...option, credential: "static-model-key-012345" }],
			}),
		),
	).not.toThrow();
});

it("uses the verified Applied root as the private OpenCode Skill home", () => {
	const skillDirectory = {
		nativeRoot: "/opt/agent-infra-skill-hub",
		generationId: "a".repeat(64),
		findSkills: () => [],
		readSkill: async () => new Uint8Array(),
	};
	expect(resolveOpenCodeSkillHome("/tmp/session", skillDirectory)).toBe(
		"/opt/agent-infra-skill-hub",
	);
	expect(resolveOpenCodeSkillHome("/tmp/session")).toBe("/tmp/session/home");
});
