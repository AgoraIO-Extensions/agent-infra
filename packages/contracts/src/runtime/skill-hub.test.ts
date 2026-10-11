import { describe, expect, it } from "vitest";
import { RuntimeSkillHubBindingV1Schema } from "./skill-hub.ts";

const projection = {
	schemaVersion: 1 as const,
	agentId: "agent-a",
	agentVersion: "agent-version-1",
	skillVersion: {
		schemaVersion: 1 as const,
		skillId: "skill-a",
		skillVersionId: "skill-version-a",
		provider: "system" as const,
		version: "1.0.0",
		packageObjectVersion: "object-a",
		packageDigest: "a".repeat(64),
		manifestDigest: "b".repeat(64),
		signatureDigest: "c".repeat(64),
	},
	manifest: {
		schemaVersion: 1 as const,
		name: "workspace-summary",
		version: "1.0.0",
		entryPath: "SKILL.md" as const,
		files: [{ path: "SKILL.md", sizeBytes: 1, sha256: "a".repeat(64) }],
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
} as const;

describe("Runtime Skill Hub binding", () => {
	it("accepts one bounded projection and rejects mixed identity", () => {
		expect(
			RuntimeSkillHubBindingV1Schema.parse({
				schemaVersion: 1,
				agentId: "agent-a",
				agentVersion: "agent-version-1",
				generationId: "d".repeat(64),
				projections: [projection],
			}),
		).toMatchObject({ generationId: "d".repeat(64) });
		expect(() =>
			RuntimeSkillHubBindingV1Schema.parse({
				schemaVersion: 1,
				agentId: "agent-a",
				agentVersion: "agent-version-1",
				generationId: "d".repeat(64),
				projections: [{ ...projection, agentId: "agent-b" }],
			}),
		).toThrow();
	});
});
