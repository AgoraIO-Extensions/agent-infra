import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareSkillPackageV1 } from "./skill-package-admission.js";
import { SkillPackageMaterializerV1 } from "./skill-package-materializer.js";

function crc32(bytes: Uint8Array) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1)
			crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: readonly { path: string; text: string }[]) {
	const local: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = new TextEncoder().encode(entry.path);
		const content = new TextEncoder().encode(entry.text);
		const crc = crc32(content);
		const header = new Uint8Array(30 + name.length);
		const view = new DataView(header.buffer);
		view.setUint32(0, 0x04034b50, true);
		view.setUint16(4, 20, true);
		view.setUint16(6, 0x800, true);
		view.setUint32(14, crc, true);
		view.setUint32(18, content.length, true);
		view.setUint32(22, content.length, true);
		view.setUint16(26, name.length, true);
		header.set(name, 30);
		local.push(header, content);
		const record = new Uint8Array(46 + name.length);
		const centralView = new DataView(record.buffer);
		centralView.setUint32(0, 0x02014b50, true);
		centralView.setUint16(4, 20, true);
		centralView.setUint16(6, 20, true);
		centralView.setUint16(8, 0x800, true);
		centralView.setUint32(16, crc, true);
		centralView.setUint32(20, content.length, true);
		centralView.setUint32(24, content.length, true);
		centralView.setUint16(28, name.length, true);
		centralView.setUint32(42, offset, true);
		record.set(name, 46);
		central.push(record);
		offset += header.length + content.length;
	}
	const centralBytes = central.reduce((sum, value) => sum + value.length, 0);
	const end = new Uint8Array(22);
	const endView = new DataView(end.buffer);
	endView.setUint32(0, 0x06054b50, true);
	endView.setUint16(8, entries.length, true);
	endView.setUint16(10, entries.length, true);
	endView.setUint32(12, centralBytes, true);
	endView.setUint32(16, offset, true);
	return Buffer.concat([...local, ...central, end]);
}

function sha256(bytes: Uint8Array) {
	return createHash("sha256").update(bytes).digest("hex");
}

function packageObject(
	archiveBytes: Uint8Array,
	objectRef = "11111111-1111-4111-8111-111111111111",
) {
	return {
		objectRef,
		version: "object-version-1",
		etag: "etag-1",
		sizeBytes: archiveBytes.byteLength,
		mediaType: "application/zip" as const,
		sha256: sha256(archiveBytes),
	};
}

function storedObject(archiveBytes: Uint8Array) {
	return { ...packageObject(archiveBytes), bytes: archiveBytes };
}

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) {
		const makeWritable = async (path: string): Promise<void> => {
			for (const entry of await readdir(path, { withFileTypes: true })) {
				if (entry.isDirectory()) await makeWritable(join(path, entry.name));
			}
			await chmod(path, 0o755);
		};
		await makeWritable(root);
		await rm(root, { recursive: true, force: true });
	}
});

describe("Skill package materializer", () => {
	it("stages a verified package, writes the index, and makes files read-only", async () => {
		const root = await mkdtemp(join(tmpdir(), "skill-materializer-"));
		roots.push(root);
		const archiveBytes = zip([
			{ path: "SKILL.md", text: "# Summary\n" },
			{ path: "references/readme.txt", text: "reference\n" },
		]);
		const prepared = prepareSkillPackageV1({
			archiveBytes,
			name: "workspace-summary",
			version: "1.0.0",
		});
		const result = await new SkillPackageMaterializerV1({
			projectRoot: root,
			readPackage: async () => storedObject(archiveBytes),
			verifyAdmission: async () => {},
		}).materialize({
			packages: [
				{
					name: "workspace-summary",
					version: "1.0.0",
					packageObject: packageObject(archiveBytes),
					packageDigest: prepared.packageDigest,
					manifestDigest: sha256(prepared.manifestBytes),
				},
			],
		});
		expect(result).toEqual({
			schemaVersion: 1,
			readOnly: true,
			packages: [
				{
					name: "workspace-summary",
					version: "1.0.0",
					packageDigest: prepared.packageDigest,
					manifestDigest: sha256(prepared.manifestBytes),
				},
			],
		});
		expect(
			await readFile(
				join(root, ".agents/skills/workspace-summary/SKILL.md"),
				"utf8",
			),
		).toBe("# Summary\n");
		expect(await readFile(join(root, ".agents/SKILLS.md"), "utf8")).toContain(
			"workspace-summary@1.0.0",
		);
		expect(
			(await stat(join(root, ".agents/skills/workspace-summary/SKILL.md")))
				.mode & 0o777,
		).toBe(0o444);
	});

	it("leaves the previous materialization intact when a later package fails verification", async () => {
		const root = await mkdtemp(join(tmpdir(), "skill-materializer-"));
		roots.push(root);
		const archiveBytes = zip([{ path: "SKILL.md", text: "# Stable\n" }]);
		const prepared = prepareSkillPackageV1({
			archiveBytes,
			name: "stable",
			version: "1.0.0",
		});
		const materializer = new SkillPackageMaterializerV1({
			projectRoot: root,
			readPackage: async () => storedObject(archiveBytes),
			verifyAdmission: async () => {},
		});
		await materializer.materialize({
			packages: [
				{
					name: "stable",
					version: "1.0.0",
					packageObject: packageObject(archiveBytes),
					packageDigest: prepared.packageDigest,
					manifestDigest: sha256(prepared.manifestBytes),
				},
			],
		});
		await expect(
			materializer.materialize({
				packages: [
					{
						name: "stable",
						version: "1.0.0",
						packageObject: packageObject(archiveBytes),
						packageDigest: "f".repeat(64),
						manifestDigest: sha256(prepared.manifestBytes),
					},
				],
			}),
		).rejects.toThrow();
		expect(
			await readFile(join(root, ".agents/skills/stable/SKILL.md"), "utf8"),
		).toBe("# Stable\n");
	});

	it("accepts an empty desired set to clear previously materialized skills", async () => {
		const root = await mkdtemp(join(tmpdir(), "skill-materializer-"));
		roots.push(root);
		const archiveBytes = zip([{ path: "SKILL.md", text: "# Clear\n" }]);
		const prepared = prepareSkillPackageV1({
			archiveBytes,
			name: "clearable",
			version: "1.0.0",
		});
		const materializer = new SkillPackageMaterializerV1({
			projectRoot: root,
			readPackage: async () => storedObject(archiveBytes),
			verifyAdmission: async () => {},
		});
		await materializer.materialize({
			packages: [
				{
					name: "clearable",
					version: "1.0.0",
					packageObject: packageObject(archiveBytes),
					packageDigest: prepared.packageDigest,
					manifestDigest: sha256(prepared.manifestBytes),
				},
			],
		});
		const result = await materializer.materialize({ packages: [] });
		expect(result.packages).toEqual([]);
		expect(await readFile(join(root, ".agents/SKILLS.md"), "utf8")).toBe(
			"# Skills\n\n",
		);
	});

	it("rejects an existing skills symlink before moving or traversing it", async () => {
		const root = await mkdtemp(join(tmpdir(), "skill-materializer-"));
		const outside = await mkdtemp(
			join(tmpdir(), "skill-materializer-outside-"),
		);
		roots.push(root, outside);
		await mkdir(join(root, ".agents"), { recursive: true });
		await writeFile(join(outside, "sentinel"), "keep");
		await symlink(outside, join(root, ".agents/skills"));
		const materializer = new SkillPackageMaterializerV1({
			projectRoot: root,
			readPackage: async () => storedObject(new Uint8Array()),
			verifyAdmission: async () => {},
		});
		await expect(materializer.materialize({ packages: [] })).rejects.toThrow();
		expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("keep");
	});
});
