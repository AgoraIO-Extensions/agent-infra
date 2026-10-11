import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	createFilesystemRuntimeSkillDirectoryV1,
	RuntimeSkillDirectoryErrorV1,
} from "./skill-hub-directory.js";

const content = "# Workspace summary\n";
const digest = "a".repeat(64);
const projection = {
	schemaVersion: 1 as const,
	agentId: "agent-a",
	agentVersion: "version-a",
	skillVersion: {
		schemaVersion: 1 as const,
		skillId: "skill-a",
		skillVersionId: "skill-version-a",
		provider: "skillhub" as const,
		version: "1.0.0",
		packageObjectVersion: "object-a",
		packageDigest: digest,
		manifestDigest: "b".repeat(64),
		signatureDigest: "c".repeat(64),
	},
	manifest: {
		schemaVersion: 1 as const,
		name: "workspace-summary",
		version: "1.0.0",
		entryPath: "SKILL.md" as const,
		files: [
			{ path: "SKILL.md", sizeBytes: Buffer.byteLength(content), sha256: "" },
		],
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

async function fixture() {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "runtime-skill-root-")),
	);
	const skillRoot = join(root, ".agents", "skills", "workspace-summary");
	await mkdir(skillRoot, { recursive: true });
	await writeFile(join(skillRoot, "SKILL.md"), content, { mode: 0o444 });
	const fileDigest = await import("node:crypto").then(({ createHash }) =>
		createHash("sha256").update(content).digest("hex"),
	);
	const input = structuredClone(projection);
	const file = input.manifest.files[0];
	if (!file) throw new Error("Missing fixture file");
	file.sha256 = fileDigest;
	await chmod(root, 0o555);
	await chmod(join(root, ".agents"), 0o555);
	await chmod(join(root, ".agents", "skills"), 0o555);
	await chmod(skillRoot, 0o555);
	return { root, input };
}

async function removeFixture(root: string) {
	await chmod(
		join(root, ".agents", "skills", "workspace-summary"),
		0o755,
	).catch(() => {});
	await chmod(join(root, ".agents", "skills"), 0o755).catch(() => {});
	await chmod(join(root, ".agents"), 0o755).catch(() => {});
	await chmod(root, 0o755).catch(() => {});
	await rm(root, { recursive: true, force: true });
}

it("reads byte-identical verified Skill files from the mounted generation", async () => {
	const f = await fixture();
	try {
		const directory = createFilesystemRuntimeSkillDirectoryV1({
			root: f.root,
			agentId: "agent-a",
			agentVersion: "version-a",
			generationId: "e".repeat(64),
			projections: [f.input],
		});
		expect(directory.findSkills()).toHaveLength(1);
		await expect(
			directory.readSkill("workspace-summary", "SKILL.md"),
		).resolves.toEqual(new TextEncoder().encode(content));
	} finally {
		await removeFixture(f.root);
	}
});

it.each(["../SKILL.md", "/SKILL.md", "missing.txt"])(
	"rejects unsafe or unlisted path %s",
	async (relativePath) => {
		const f = await fixture();
		try {
			const directory = createFilesystemRuntimeSkillDirectoryV1({
				root: f.root,
				agentId: "agent-a",
				agentVersion: "version-a",
				generationId: "e".repeat(64),
				projections: [f.input],
			});
			await expect(
				directory.readSkill("workspace-summary", relativePath),
			).rejects.toThrow(RuntimeSkillDirectoryErrorV1);
		} finally {
			await removeFixture(f.root);
		}
	},
);

it("rejects a symlink at the manifest-listed SKILL.md", async () => {
	const f = await fixture();
	try {
		const directory = createFilesystemRuntimeSkillDirectoryV1({
			root: f.root,
			agentId: "agent-a",
			agentVersion: "version-a",
			generationId: "e".repeat(64),
			projections: [f.input],
		});
		const skillRoot = join(f.root, ".agents", "skills", "workspace-summary");
		const skillFile = join(skillRoot, "SKILL.md");
		const targetFile = join(f.root, "symlink-target");
		await chmod(f.root, 0o755);
		await writeFile(targetFile, content, { mode: 0o444 });
		await chmod(f.root, 0o555);
		await chmod(join(f.root, ".agents"), 0o755);
		await chmod(join(f.root, ".agents", "skills"), 0o755);
		await chmod(skillRoot, 0o755);
		await rm(skillFile);
		await symlink(targetFile, skillFile);
		await chmod(skillRoot, 0o555);
		await expect(
			directory.readSkill("workspace-summary", "SKILL.md"),
		).rejects.toThrow(RuntimeSkillDirectoryErrorV1);
	} finally {
		await removeFixture(f.root);
	}
});

it("rejects a hardlink at the manifest-listed SKILL.md", async () => {
	const f = await fixture();
	try {
		const directory = createFilesystemRuntimeSkillDirectoryV1({
			root: f.root,
			agentId: "agent-a",
			agentVersion: "version-a",
			generationId: "e".repeat(64),
			projections: [f.input],
		});
		const skillRoot = join(f.root, ".agents", "skills", "workspace-summary");
		const skillFile = join(skillRoot, "SKILL.md");
		const targetFile = join(f.root, "hardlink-target");
		await chmod(f.root, 0o755);
		await writeFile(targetFile, content, { mode: 0o444 });
		await chmod(f.root, 0o555);
		await chmod(join(f.root, ".agents"), 0o755);
		await chmod(join(f.root, ".agents", "skills"), 0o755);
		await chmod(skillRoot, 0o755);
		await rm(skillFile);
		await link(targetFile, skillFile);
		await chmod(skillRoot, 0o555);
		await expect(
			directory.readSkill("workspace-summary", "SKILL.md"),
		).rejects.toThrow(RuntimeSkillDirectoryErrorV1);
	} finally {
		await removeFixture(f.root);
	}
});

it("rejects a writable manifest-listed SKILL.md", async () => {
	const f = await fixture();
	try {
		const directory = createFilesystemRuntimeSkillDirectoryV1({
			root: f.root,
			agentId: "agent-a",
			agentVersion: "version-a",
			generationId: "e".repeat(64),
			projections: [f.input],
		});
		const skillRoot = join(f.root, ".agents", "skills", "workspace-summary");
		const skillFile = join(skillRoot, "SKILL.md");
		await chmod(skillFile, 0o644);
		await expect(
			directory.readSkill("workspace-summary", "SKILL.md"),
		).rejects.toThrow(RuntimeSkillDirectoryErrorV1);
	} finally {
		await removeFixture(f.root);
	}
});
