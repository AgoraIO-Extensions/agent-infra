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
