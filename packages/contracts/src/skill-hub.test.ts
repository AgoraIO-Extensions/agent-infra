import { describe, expect, it } from "vitest";
import {
	createSkillWorkloadProjectionV1,
	MagicSkillProviderOrderV1,
	SkillAgentVersionBindingV1Schema,
	SkillPackageManifestV1Schema,
	SkillVersionRefV1Schema,
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
	it.each([
		"https://opaque.example/version",
		"  opaque/s3+version  ",
		"null\n",
		"é".repeat(512),
	])("keeps opaque S3 versions byte-for-byte", (packageObjectVersion) => {
		expect(
			SkillVersionRefV1Schema.parse({ ...ref, packageObjectVersion })
				.packageObjectVersion,
		).toBe(packageObjectVersion);
	});
	it.each(["", "null", "é".repeat(513), "\ud800"])(
		"refuses invalid S3 versions",
		(packageObjectVersion) => {
			expect(
				SkillVersionRefV1Schema.safeParse({ ...ref, packageObjectVersion })
					.success,
			).toBe(false);
		},
	);
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

	it("builds a projection only for the verified manifest digest", () => {
		const projection = createSkillWorkloadProjectionV1({
			agentId: "agent-1",
			agentVersion: "agent-version-1",
			skillVersion: { ...ref, manifestDigest: digest },
			manifest,
			manifestDigest: digest,
			grant: {
				schemaVersion: 1,
				tools: [],
				connections: [],
				fileRoots: [],
				networkOrigins: [],
				scripts: false,
			},
		});
		expect(projection.targetPath).toBe(".agents/skills/workspace-summary");
		expect(() =>
			createSkillWorkloadProjectionV1({
				agentId: "agent-1",
				agentVersion: "agent-version-1",
				skillVersion: { ...ref, manifestDigest: "b".repeat(64) },
				manifest,
				manifestDigest: digest,
				grant: projection.grant,
			}),
		).toThrow("manifest digest mismatch");
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
		const invalidOrigin = SkillAgentVersionBindingV1Schema.safeParse({
			schemaVersion: 1,
			agentId: "agent-1",
			agentVersion: "agent-version-1",
			skillVersion: ref,
			grant: {
				schemaVersion: 1,
				tools: [],
				connections: [],
				fileRoots: [],
				networkOrigins: ["not-a-url"],
				scripts: false,
			},
			syncRevision: 1,
		});
		expect(invalidOrigin.success).toBe(false);
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
