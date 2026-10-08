import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	admissionSignatureBytesV1,
	canonicalSkillPackageSourceProofV1,
	prepareSkillPackageV1,
	verifyAdmissionSignatureV1,
	verifySkillPackageScanReceiptV1,
} from "./skill-package-admission.js";

function crc32(bytes: Uint8Array) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++)
			crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}
function zip(
	entries: readonly { path: string; text: string; mode?: number }[],
) {
	const local: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = new TextEncoder().encode(entry.path);
		const content = new TextEncoder().encode(entry.text);
		const crc = crc32(content);
		const header = new Uint8Array(30 + name.length);
		new DataView(header.buffer).setUint32(0, 0x04034b50, true);
		new DataView(header.buffer).setUint16(4, 20, true);
		new DataView(header.buffer).setUint16(6, 0x800, true);
		new DataView(header.buffer).setUint32(14, crc, true);
		new DataView(header.buffer).setUint32(18, content.length, true);
		new DataView(header.buffer).setUint32(22, content.length, true);
		new DataView(header.buffer).setUint16(26, name.length, true);
		header.set(name, 30);
		local.push(header, content);
		const record = new Uint8Array(46 + name.length);
		const view = new DataView(record.buffer);
		view.setUint32(0, 0x02014b50, true);
		view.setUint16(4, 20, true);
		view.setUint16(6, 20, true);
		view.setUint16(8, 0x800, true);
		view.setUint32(16, crc, true);
		view.setUint32(20, content.length, true);
		view.setUint32(24, content.length, true);
		view.setUint16(28, name.length, true);
		view.setUint32(38, entry.mode ?? 0, true);
		view.setUint32(42, offset, true);
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
function sha(bytes: Uint8Array) {
	return createHash("sha256").update(bytes).digest("hex");
}

const archive = zip([
	{ path: "SKILL.md", text: "# Summary\n" },
	{ path: "references/readme.txt", text: "reference" },
]);

describe("Skill package admission", () => {
	it("opens a real ZIP, hashes actual files and emits a canonical manifest", () => {
		const prepared = prepareSkillPackageV1({
			archiveBytes: archive,
			name: "summary",
			version: "1.0.0",
		});
		expect(prepared.packageDigest).toBe(sha(archive));
		expect(prepared.fileCount).toBe(2);
		expect(prepared.manifest.files.map((entry) => entry.path)).toEqual([
			"SKILL.md",
			"references/readme.txt",
		]);
		expect(
			JSON.parse(new TextDecoder().decode(prepared.manifestBytes)),
		).toEqual(prepared.manifest);
	});

	it.each([
		["../escape", "invalid_path"],
		["SKILL.md", "duplicate_path"],
	])("rejects archive entry %s", (path, code) => {
		const entries = [
			{ path: "SKILL.md", text: "# ok" },
			{ path, text: "bad" },
		];
		try {
			prepareSkillPackageV1({
				archiveBytes: zip(entries),
				name: "summary",
				version: "1.0.0",
			});
			throw new Error("expected rejection");
		} catch (error) {
			expect(error).toMatchObject({ code });
		}
	});

	it("binds source evidence, scan evidence and Ed25519 signature to one package", () => {
		const prepared = prepareSkillPackageV1({
			archiveBytes: archive,
			name: "summary",
			version: "1.0.0",
		});
		const source = {
			schemaVersion: 1 as const,
			provider: "my_library",
			publisherId: "publisher-a",
			sourceVersion: "source-1",
			sourceDigest: "a".repeat(64),
			approvalRef: null,
			trustRevision: "trust-1",
		};
		const sourceDigest = sha(canonicalSkillPackageSourceProofV1(source));
		const manifestDigest = sha(prepared.manifestBytes);
		const receipt = {
			schemaVersion: 1 as const,
			scannerId: "scanner-a",
			engineVersion: "1",
			rulesetDigest: "b".repeat(64),
			policyRevision: "policy-1",
			scannedAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			packageDigest: prepared.packageDigest,
			manifestDigest,
			scannedFileCount: prepared.fileCount,
			scannedBytes: prepared.totalBytes,
			verdict: "clean" as const,
		};
		verifySkillPackageScanReceiptV1(
			receipt,
			prepared,
			sourceDigest,
			"policy-1",
		);
		const payload = admissionSignatureBytesV1({
			packageObjectVersion: "opaque/s3+version",
			skillId: "skill-a",
			skillVersionId: "version-a",
			ownerId: "owner-a",
			provider: source.provider,
			version: "1.0.0",
			packageDigest: prepared.packageDigest,
			manifestDigest,
			sourceProofDigest: sourceDigest,
			scanReceiptDigest: sha(new TextEncoder().encode(JSON.stringify(receipt))),
			trustRevision: source.trustRevision,
			policyRevision: receipt.policyRevision,
			signingKeyId: "key-a",
		});
		const keys = generateKeyPairSync("ed25519");
		const signature = sign(null, payload, keys.privateKey);
		verifyAdmissionSignatureV1(payload, signature, keys.publicKey);
		expect(() =>
			verifyAdmissionSignatureV1(
				new TextEncoder().encode("changed"),
				signature,
				keys.publicKey,
			),
		).toThrow();
	});
});
