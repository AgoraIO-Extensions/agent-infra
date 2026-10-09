import { describe, expect, it } from "vitest";
import {
	createObjectStorageWorkloadSkillMaterializerV1,
	validateWorkloadSkillMaterializationV1,
} from "./skill-materialization.js";

const digest = "a".repeat(64);
const skill = {
	schemaVersion: 1 as const,
	agentId: "agent-a",
	agentVersion: "agent-version-1",
	skillVersion: {
		schemaVersion: 1 as const,
		skillId: "skill-a",
		skillVersionId: "skill-version-a",
		provider: "system" as const,
		version: "1.0.0",
		packageObjectVersion: "object-version-a",
		packageDigest: digest,
		manifestDigest: digest,
		signatureDigest: digest,
	},
	manifest: {
		schemaVersion: 1 as const,
		name: "workspace-summary",
		version: "1.0.0",
		entryPath: "SKILL.md" as const,
		files: [{ path: "SKILL.md", sizeBytes: 10, sha256: digest }],
		packageDigest: digest,
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

describe("Workload Skill materialization receipt", () => {
	it("accepts a verified generation bound to the Agent", () => {
		const result = validateWorkloadSkillMaterializationV1(
			{
				agentId: "agent-a",
				configurationRevision: 2,
				workloadRevision: 3,
				fence: 4,
			},
			{ generationId: digest, skills: [skill] },
		);
		expect(result.skills[0]?.targetPath).toBe(
			".agents/skills/workspace-summary",
		);
	});

	it.each([
		{ generationId: "bad", skills: [skill] },
		{ generationId: digest, skills: [{ ...skill, agentId: "other-agent" }] },
		{
			generationId: digest,
			skills: [skill, { ...skill, targetPath: ".agents/skills/other" }],
		},
	])("rejects an unverifiable materialization receipt", (result) => {
		expect(() =>
			validateWorkloadSkillMaterializationV1(
				{
					agentId: "agent-a",
					configurationRevision: 1,
					workloadRevision: 1,
					fence: 1,
				},
				result,
			),
		).toThrow();
	});

	it("maps the physical generation manifest to the Worker projection", async () => {
		const materializer = {
			async materialize() {
				return {
					schemaVersion: 1 as const,
					status: "materialized" as const,
					generationId: digest,
					packages: [],
				};
			},
			async readCurrentDetails() {
				return {
					result: {
						schemaVersion: 1 as const,
						status: "materialized" as const,
						generationId: digest,
						packages: [],
					},
					packages: [
						{
							input: {
								name: "workspace-summary",
								version: "1.0.0",
								packageObject: {
									objectRef: "11111111-1111-4111-8111-111111111111",
									version: "object-version-a",
									etag: "etag-a",
									sizeBytes: 1,
									mediaType: "application/zip",
									sha256: digest,
								},
								packageDigest: digest,
								manifestDigest: digest,
							},
							manifest: skill.manifest,
							manifestDigest: digest,
						},
					],
				};
			},
		};
		const worker = createObjectStorageWorkloadSkillMaterializerV1({
			materializer,
			resolveBindings: async () => [
				{
					name: "workspace-summary",
					agentVersion: "agent-version-1",
					skillVersion: skill.skillVersion,
					packageObject: materializerOutput().packageObject,
					grant: skill.grant,
				},
			],
		});
		const result = await worker.materialize({
			agentId: "agent-a",
			configurationRevision: 1,
			workloadRevision: 1,
			fence: 1,
		});
		expect(result.skills[0]?.targetPath).toBe(
			".agents/skills/workspace-summary",
		);
	});
});

function materializerOutput() {
	return {
		packageObject: {
			objectRef: "11111111-1111-4111-8111-111111111111",
			version: "object-version-a",
			etag: "etag-a",
			sizeBytes: 1,
			mediaType: "application/zip",
			sha256: digest,
		},
	};
}
