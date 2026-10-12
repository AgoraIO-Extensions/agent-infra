import { expect, it } from "vitest";
import { piNativeSkillArguments } from "./pi-bootstrap.js";
import type { RuntimeFilesystemSkillDirectoryV1 } from "./skill-hub-directory.js";

it("keeps Pi Skills disabled without a trusted directory", () => {
	expect(piNativeSkillArguments(undefined)).toEqual(["--no-skills"]);
});

it("uses only projection-derived explicit Skill entry paths", () => {
	const directory: RuntimeFilesystemSkillDirectoryV1 = {
		generationId: "a".repeat(64),
		findSkills: () => [],
		nativeSkillPaths: () => [
			"/opt/agent-infra-skill-hub/.agents/skills/workspace-summary/SKILL.md",
		],
		readSkill: async () => new Uint8Array(),
	};
	expect(piNativeSkillArguments(directory)).toEqual([
		"--skill",
		"/opt/agent-infra-skill-hub/.agents/skills/workspace-summary/SKILL.md",
	]);
});

it("fails closed for duplicate or caller-shaped native Skill paths", () => {
	for (const path of [
		"/tmp/skill.md",
		"/opt/.agents/skills/../outside/SKILL.md",
	])
		expect(() =>
			piNativeSkillArguments({
				generationId: "a".repeat(64),
				findSkills: () => [],
				nativeSkillPaths: () => [path],
				readSkill: async () => new Uint8Array(),
			}),
		).toThrow("RUNTIME_SKILL_DIRECTORY_UNAVAILABLE");
	expect(() =>
		piNativeSkillArguments({
			generationId: "a".repeat(64),
			findSkills: () => [],
			nativeSkillPaths: () => [
				"/opt/.agents/skills/a/SKILL.md",
				"/opt/.agents/skills/a/SKILL.md",
			],
			readSkill: async () => new Uint8Array(),
		}),
	).toThrow("RUNTIME_SKILL_DIRECTORY_UNAVAILABLE");
});
