import { SkillWorkloadProjectionV1Schema } from "@agent-infra/contracts";
import { expect, it } from "vitest";
import {
	createRuntimeSkillDirectoryV1,
	RuntimeSkillDirectoryErrorV1,
} from "./skill-hub-directory.js";

const digest = "a".repeat(64);
const projection = SkillWorkloadProjectionV1Schema.parse({
	schemaVersion: 1,
	agentId: "agent-a",
	agentVersion: "version-a",
	skillVersion: {
		schemaVersion: 1,
		skillId: "skill-a",
		skillVersionId: "skill-version-a",
		provider: "skillhub",
		version: "1.0.0",
		packageObjectVersion: "object-a",
		packageDigest: digest,
		manifestDigest: "b".repeat(64),
		signatureDigest: "c".repeat(64),
	},
	manifest: {
		schemaVersion: 1,
		name: "workspace-summary",
		version: "1.0.0",
		entryPath: "SKILL.md",
		files: [{ path: "SKILL.md", sizeBytes: 12, sha256: "d".repeat(64) }],
		packageDigest: digest,
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

it("projects verified bindings into bounded Skill metadata and reads resources", async () => {
	const directory = createRuntimeSkillDirectoryV1({
		agentId: "agent-a",
		agentVersion: "version-a",
		generationId: "e".repeat(64),
		projections: [projection],
	});
	const entries = directory.findSkills();
	expect(entries).toHaveLength(1);
	expect(entries[0]).toMatchObject({
		name: "workspace-summary",
		readOnly: true,
	});
	const seen: unknown[] = [];
	const bytes = await directory.readSkill(
		"workspace-summary",
		"SKILL.md",
		async (request) => {
			seen.push(request);
			return new TextEncoder().encode("summary");
		},
	);
	expect(new TextDecoder().decode(bytes)).toBe("summary");
	expect(seen[0]).toMatchObject({
		relativePath: "SKILL.md",
		maximumBytes: 1_048_576,
	});
});

it.each([
	["foreign agent", { ...projection, agentId: "agent-b" }],
	["foreign target", { ...projection, targetPath: ".agents/skills/other" }],
	["duplicate name", [projection, projection]],
])("rejects %s projections", (_name, value) => {
	expect(() =>
		createRuntimeSkillDirectoryV1({
			agentId: "agent-a",
			agentVersion: "version-a",
			generationId: "e".repeat(64),
			projections: Array.isArray(value) ? value : [value],
		}),
	).toThrow(RuntimeSkillDirectoryErrorV1);
});

it.each(["/SKILL.md", "../SKILL.md", "nested/../SKILL.md", "nested\\SKILL.md"])(
	"rejects unsafe resource path %s",
	async (relativePath) => {
		const directory = createRuntimeSkillDirectoryV1({
			agentId: "agent-a",
			agentVersion: "version-a",
			generationId: "e".repeat(64),
			projections: [projection],
		});
		await expect(
			directory.readSkill(
				"workspace-summary",
				relativePath,
				async () => new Uint8Array(),
			),
		).rejects.toThrow(RuntimeSkillDirectoryErrorV1);
	},
);

it("rejects an oversized resource returned by the adapter", async () => {
	const directory = createRuntimeSkillDirectoryV1({
		agentId: "agent-a",
		agentVersion: "version-a",
		generationId: "e".repeat(64),
		projections: [projection],
		maximumResourceBytes: 4,
	});
	await expect(
		directory.readSkill(
			"workspace-summary",
			"SKILL.md",
			async () => new Uint8Array(5),
		),
	).rejects.toThrow(RuntimeSkillDirectoryErrorV1);
});
