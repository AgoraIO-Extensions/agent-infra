import { SkillWorkloadProjectionV1Schema } from "@agent-infra/contracts";
import { describe, expect, it } from "vitest";
import {
	createRuntimeSkillHubDirectoryV1,
	readRuntimeSkillHubBindingV1,
	runtimeSkillHubMountRootV1,
} from "./skill-hub-configuration.js";

const projection = SkillWorkloadProjectionV1Schema.parse({
	schemaVersion: 1,
	agentId: "agent-a",
	agentVersion: "agent-version-1",
	skillVersion: {
		schemaVersion: 1,
		skillId: "skill-a",
		skillVersionId: "skill-version-a",
		provider: "system",
		version: "1.0.0",
		packageObjectVersion: "object-a",
		packageDigest: "a".repeat(64),
		manifestDigest: "b".repeat(64),
		signatureDigest: "c".repeat(64),
	},
	manifest: {
		schemaVersion: 1,
		name: "workspace-summary",
		version: "1.0.0",
		entryPath: "SKILL.md",
		files: [{ path: "SKILL.md", sizeBytes: 1, sha256: "a".repeat(64) }],
		packageDigest: "a".repeat(64),
	},
	targetPath: ".agents/skills/workspace-summary",
	readOnly: true,
	grant: {
		schemaVersion: 1,
		tools: [],
		connections: [],
		fileRoots: [],
		networkOrigins: [],
		scripts: false,
	},
});

function environment() {
	return {
		AGENT_INFRA_RUNTIME_AGENT_ID: "agent-a",
		AGENT_INFRA_RUNTIME_SKILL_HUB_BINDING: JSON.stringify({
			schemaVersion: 1,
			agentId: "agent-a",
			agentVersion: "agent-version-1",
			generationId: "d".repeat(64),
			projections: [projection],
		}),
	};
}

describe("Runtime Skill Hub configuration", () => {
	it("reads one verified binding and projects bounded capabilities from the fixed root", () => {
		const binding = readRuntimeSkillHubBindingV1(environment());
		if (!binding) throw new Error("Expected Skill Hub binding");
		const directory = createRuntimeSkillHubDirectoryV1(binding);
		expect(runtimeSkillHubMountRootV1).toBe("/opt/agent-infra-skill-hub");
		expect(directory.findSkills()).toEqual([
			expect.objectContaining({
				name: "workspace-summary",
				packageDigest: "a".repeat(64),
				manifestDigest: "b".repeat(64),
				readOnly: true,
			}),
		]);
	});

	it("rejects a binding for a different Runtime Agent", () => {
		expect(() =>
			readRuntimeSkillHubBindingV1({
				...environment(),
				AGENT_INFRA_RUNTIME_AGENT_ID: "agent-b",
			}),
		).toThrow("RUNTIME_CONFIGURATION_INVALID");
	});
});
