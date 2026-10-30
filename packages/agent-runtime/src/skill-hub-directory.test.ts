import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillWorkloadProjectionV1Schema } from "@agent-infra/contracts";
import { expect, it } from "vitest";
import {
	createAppliedRuntimeSkillDirectoryV1,
	createFilesystemRuntimeSkillDirectoryV1,
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

const appliedBinding = {
	schemaVersion: 1 as const,
	agentId: "agent-a",
	agentVersion: "version-a",
	skillName: "workspace-summary",
	skillVersion: projection.skillVersion,
	grant: projection.grant,
	configurationRevision: 4,
	syncRevision: 2,
	state: "synced" as const,
	failureReason: null,
	appliedReceipt: {
		schemaVersion: 1 as const,
		agentId: "agent-a",
		agentVersion: "version-a",
		skillName: "workspace-summary",
		configurationRevision: 4,
		syncRevision: 2,
		skillVersionId: projection.skillVersion.skillVersionId,
		generationId: "e".repeat(64),
		packageDigest: projection.skillVersion.packageDigest,
		manifestDigest: projection.skillVersion.manifestDigest,
		targetPath: ".agents/skills/workspace-summary",
		readOnly: true as const,
	},
};

it("requires current Applied binding facts before exposing Runtime skills", () => {
	const directory = createAppliedRuntimeSkillDirectoryV1({
		agentId: "agent-a",
		agentVersion: "version-a",
		configurationRevision: 4,
		generationId: "e".repeat(64),
		projections: [projection],
		appliedBindings: [appliedBinding],
	});
	expect(directory.findSkills()).toHaveLength(1);
});

it.each([
	[
		"pending",
		{ ...appliedBinding, state: "pending_sync", appliedReceipt: null },
	],
	["foreign config", { ...appliedBinding, configurationRevision: 3 }],
	[
		"foreign generation",
		{
			...appliedBinding,
			appliedReceipt: {
				...appliedBinding.appliedReceipt,
				generationId: "f".repeat(64),
			},
		},
	],
	["cross agent", { ...appliedBinding, agentId: "agent-b" }],
	["duplicate Applied version", [appliedBinding, appliedBinding]],
])("rejects %s Applied facts", (_label, binding) => {
	expect(() =>
		createAppliedRuntimeSkillDirectoryV1({
			agentId: "agent-a",
			agentVersion: "version-a",
			configurationRevision: 4,
			generationId: "e".repeat(64),
			projections: [projection],
			appliedBindings: Array.isArray(binding) ? binding : [binding],
		}),
	).toThrow(RuntimeSkillDirectoryErrorV1);
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

it("derives fixed native Skill entry paths from the verified filesystem root", async () => {
	const root = realpathSync(
		await mkdtemp(join(tmpdir(), "native-skill-root-")),
	);
	const directories = [
		root,
		join(root, ".agents"),
		join(root, ".agents/skills"),
		join(root, ".agents/skills/workspace-summary"),
	];
	const bytes = new TextEncoder().encode("summary");
	try {
		await mkdir(join(root, ".agents/skills/workspace-summary"), {
			recursive: true,
		});
		await writeFile(
			join(root, ".agents/skills/workspace-summary/SKILL.md"),
			bytes,
			{ mode: 0o444 },
		);
		for (const path of directories) await chmod(path, 0o555);
		const nativeProjection = SkillWorkloadProjectionV1Schema.parse({
			...projection,
			manifest: {
				...projection.manifest,
				files: [
					{
						path: "SKILL.md",
						sizeBytes: bytes.byteLength,
						sha256: createHash("sha256").update(bytes).digest("hex"),
					},
				],
			},
		});
		const directory = createFilesystemRuntimeSkillDirectoryV1({
			root,
			agentId: "agent-a",
			agentVersion: "version-a",
			generationId: "e".repeat(64),
			projections: [nativeProjection],
		});
		expect(directory.nativeRoot).toBe(root);
		expect(directory.nativeSkillPaths?.()).toEqual([
			join(realpathSync(root), ".agents/skills/workspace-summary/SKILL.md"),
		]);
	} finally {
		for (const path of directories) await chmod(path, 0o755);
		await rm(root, { recursive: true });
	}
});
