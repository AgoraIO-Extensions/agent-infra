import { describe, expect, it } from "vitest";
import { SkillWorkloadProjectionV1Schema } from "../../src/skill-hub.ts";

const projection = {
	schemaVersion: 1 as const,
	agentId: "agent-1",
	agentVersion: "agent-version-1",
	skillVersion: {
		schemaVersion: 1 as const,
		skillId: "skill-1",
		skillVersionId: "skill-version-1",
		provider: "system" as const,
		version: "1.0.0",
		packageObjectVersion: "object-1",
		packageDigest: "a".repeat(64),
		manifestDigest: "b".repeat(64),
	},
	manifest: {
		schemaVersion: 1 as const,
		name: "workspace-summary",
		version: "1.0.0",
		entryPath: "SKILL.md" as const,
		files: [{ path: "SKILL.md", sizeBytes: 1, sha256: "c".repeat(64) }],
		packageDigest: "a".repeat(64),
	},
	targetPath: ".agents/skills/workspace-summary",
	readOnly: true as const,
	grant: {
		schemaVersion: 1 as const,
		tools: [],
		connections: [],
		fileRoots: [],
		networkOrigins: [],
		scripts: false as const,
	},
};

describe("Skill Workload projection", () => {
	it("accepts an immutable read-only .agents projection", () => {
		expect(SkillWorkloadProjectionV1Schema.parse(projection)).toEqual(
			projection,
		);
	});

	it("rejects a projection whose target does not match its package", () => {
		expect(() =>
			SkillWorkloadProjectionV1Schema.parse({
				...projection,
				targetPath: ".agents/skills/other",
			}),
		).toThrow();
	});
});
