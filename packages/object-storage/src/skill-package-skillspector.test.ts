import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSkillSpectorSkillPackageScannerV1 } from "./skill-package-skillspector.js";
import { prepareSkillPackageV1 } from "./skill-package-admission.js";

function archive(): Uint8Array {
	// Stored ZIP with one SKILL.md entry; the scanner revalidates the package bytes.
	const name = Buffer.from("SKILL.md");
	const body = Buffer.from("# test\n");
	let crc = 0xffffffff;
	for (const byte of body) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	crc = (crc ^ 0xffffffff) >>> 0;
	const local = Buffer.alloc(30 + name.length + body.length);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(0x800, 6);
	local.writeUInt32LE(crc, 14);
	local.writeUInt32LE(body.length, 18);
	local.writeUInt32LE(body.length, 22);
	local.writeUInt16LE(name.length, 26);
	name.copy(local, 30);
	body.copy(local, 30 + name.length);
	const central = Buffer.alloc(46 + name.length);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(0x800, 8);
	central.writeUInt32LE(crc, 16);
	central.writeUInt32LE(body.length, 20);
	central.writeUInt32LE(body.length, 24);
	central.writeUInt16LE(name.length, 28);
	central.writeUInt32LE(0, 42);
	name.copy(central, 46);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length, 12);
	end.writeUInt32LE(local.length, 16);
	return Buffer.concat([local, central, end]);
}

describe("SkillSpector scanner adapter", () => {
	it("maps a controlled SAFE JSON report to automatic publication", async () => {
		const root = await mkdtemp(join(tmpdir(), "skill-spector-test-"));
		try {
			const executable = join(root, "scanner.mjs");
			await writeFile(
				executable,
				'#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({risk_assessment:{recommendation:"SAFE"},components:[]}));',
			);
			await chmod(executable, 0o700);
			const bytes = archive();
			const prepared = prepareSkillPackageV1({ archiveBytes: bytes, name: "demo", version: "1" });
			const scanner = createSkillSpectorSkillPackageScannerV1({
				executable,
				scannerId: "nvidia-skillspector",
				engineVersion: "pinned",
				rulesetDigest: "a".repeat(64),
				policyRevision: "policy-1",
				maximumReceiptAgeMs: 60_000,
				timeoutMs: 10_000,
				reviewPolicy: {
					schemaVersion: 1,
					policyRevision: "policy-1",
					autoPublishMaxSeverity: "LOW",
					fatalRuleIds: [],
					dynamicProbeCategories: [],
				},
			});
			const receipt = await scanner.scan({
				name: "demo",
				version: "1",
				packageDigest: prepared.packageDigest,
				manifestDigest: createHash("sha256").update(prepared.manifestBytes).digest("hex"),
				fileCount: prepared.fileCount,
				totalBytes: prepared.totalBytes,
				sourceProofDigest: "b".repeat(64),
				policyRevision: "policy-1",
				packageObject: { objectRef: "zip", version: "v1", etag: "e", sizeBytes: bytes.byteLength, sha256: prepared.packageDigest },
				openPackage: async () => new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
			});
			expect(receipt.admissionDecision).toBe("auto_published");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
