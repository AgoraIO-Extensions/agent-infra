import { describe, expect, it } from "vitest";
import {
	MagicSkillProviderOrderV1,
	SkillAgentVersionBindingV1Schema,
	SkillPackageManifestV1Schema,
	SkillWorkloadProjectionV1Schema,
} from "./skill-hub.ts";

const digest = "a".repeat(64);

const manifest = {
	schemaVersion: 1 as const,
	name: "workspace-summary",
	version: "1.0.0",
	entryPath: "SKILL.md" as const,
	files: [{ path: "SKILL.md", sizeBytes: 12, sha256: digest }],
	packageDigest: digest,
};

const ref = {
	schemaVersion: 1 as const,
	skillId: "skill-1",
	skillVersionId: "skill-version-1",
	provider: "system" as const,
	version: "1.0.0",
	packageObjectVersion: "object-1",
	packageDigest: digest,
	manifestDigest: digest,
	signatureDigest: digest,
};

describe("Skill Hub contracts", () => {
	it("pins Magic provider order", () => {
		expect(MagicSkillProviderOrderV1).toEqual([
			"system",
			"my_library",
			"market",
			"clawhub",
			"skillhub",
			"npx",
			"github",
		]);
	});

	it("accepts an immutable package and matching workload projection", () => {
		expect(SkillPackageManifestV1Schema.parse(manifest)).toEqual(manifest);
		expect(
			SkillWorkloadProjectionV1Schema.parse({
				schemaVersion: 1,
				agentId: "agent-1",
				agentVersion: "agent-version-1",
				skillVersion: ref,
				manifest,
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
			}).targetPath,
		).toBe(".agents/skills/workspace-summary");
	});

	it("rejects path traversal and mismatched materialization", () => {
		expect(() =>
			SkillPackageManifestV1Schema.parse({
				...manifest,
				files: [{ ...manifest.files[0], path: "../SKILL.md" }],
			}),
		).toThrow();
		expect(() =>
			SkillWorkloadProjectionV1Schema.parse({
				schemaVersion: 1,
				agentId: "agent-1",
				agentVersion: "agent-version-1",
				skillVersion: ref,
				manifest,
				targetPath: ".agents/skills/other",
				readOnly: true,
				grant: {
					schemaVersion: 1,
					tools: [],
					connections: [],
					fileRoots: [],
					networkOrigins: [],
					scripts: false,
				},
			}),
		).toThrow();
	});

	it("rejects unsafe grants", () => {
		expect(() =>
			SkillAgentVersionBindingV1Schema.parse({
				schemaVersion: 1,
				agentId: "agent-1",
				agentVersion: "agent-version-1",
				skillVersion: ref,
				grant: {
					schemaVersion: 1,
					tools: [],
					connections: [],
					fileRoots: ["/workspace/../secret"],
					networkOrigins: ["http://example.com/"],
					scripts: false,
				},
				syncRevision: 1,
			}),
		).toThrow();
	});

	it("rejects an enabled script grant and unknown fields", () => {
		expect(() =>
			SkillAgentVersionBindingV1Schema.parse({
				schemaVersion: 1,
				agentId: "agent-1",
				agentVersion: "agent-version-1",
				skillVersion: ref,
				grant: {
					schemaVersion: 1,
					tools: [],
					connections: [],
					fileRoots: [],
					networkOrigins: [],
					scripts: true,
				},
				syncRevision: 1,
				extra: true,
			}),
		).toThrow();
	});
});
