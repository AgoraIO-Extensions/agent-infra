import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	admissionSignatureBytesV1,
	canonicalSkillPackageScanReceiptV1,
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

const sourceProof = {
	schemaVersion: 1 as const,
	provider: "my_library",
	publisherId: "publisher-a",
	sourceVersion: "source-1",
	sourceDigest: "a".repeat(64),
	approvalRef: null,
	trustRevision: "trust-1",
};
const scanReceipt = {
	schemaVersion: 1 as const,
	scannerId: "scanner-a",
	engineVersion: "1",
	rulesetDigest: "a".repeat(64),
	policyRevision: "policy-1",
	scannedAt: "2026-01-01T00:00:00.000Z",
	expiresAt: "2026-01-01T00:01:00.000Z",
	packageDigest: "a".repeat(64),
	manifestDigest: "b".repeat(64),
	scannedFileCount: 1,
	scannedBytes: 5,
	verdict: "clean" as const,
};
const signingInput = {
	packageObjectVersion: "opaque/s3+version",
	skillId: "skill-a",
	skillVersionId: "version-a",
	ownerId: "owner-a",
	provider: "my_library",
	version: "1.0.0",
	packageDigest: "a".repeat(64),
	manifestDigest: "b".repeat(64),
	sourceProofDigest: "c".repeat(64),
	scanReceiptDigest: "d".repeat(64),
	trustRevision: "trust-1",
	policyRevision: "policy-1",
	signingKeyId: "key-a",
};

describe("Skill package admission", () => {
	it("refuses to sign malformed or extra fields", () => {
		expect(() =>
			admissionSignatureBytesV1({ ...signingInput, signingKeyId: "\ud800" }),
		).toThrow();
		expect(() =>
			admissionSignatureBytesV1({
				...signingInput,
				unexpected: "metadata",
			} as never),
		).toThrow();
	});
	it("rejects a signature from a different key algorithm", () => {
		const payload = admissionSignatureBytesV1(signingInput);
		const keys = generateKeyPairSync("rsa", { modulusLength: 1024 });
		expect(() =>
			verifyAdmissionSignatureV1(
				payload,
				sign(null, payload, keys.privateKey),
				keys.publicKey,
			),
		).toThrow();
	});
	it("rejects a scan purportedly completed in the future", () => {
		const prepared = prepareSkillPackageV1({
			archiveBytes: archive,
			name: "summary",
			version: "1.0.0",
		});
		expect(() =>
			verifySkillPackageScanReceiptV1(
				{
					...scanReceipt,
					packageDigest: prepared.packageDigest,
					manifestDigest: sha(prepared.manifestBytes),
					scannedFileCount: prepared.fileCount,
					scannedBytes: prepared.totalBytes,
					scannedAt: new Date(Date.now() + 60_000).toISOString(),
					expiresAt: new Date(Date.now() + 120_000).toISOString(),
				},
				prepared,
				"a".repeat(64),
				"policy-1",
			),
		).toThrow();
	});
	it("rejects invalid scan evidence instead of serializing it as JSON null", () => {
		expect(() =>
			canonicalSkillPackageScanReceiptV1({
				...scanReceipt,
				scannedBytes: Number.NaN,
			}),
		).toThrow();
		expect(() =>
			canonicalSkillPackageScanReceiptV1({
				...scanReceipt,
				engineVersion: "\ud800",
			}),
		).toThrow();
	});
	it("rejects non-data evidence without invoking accessors", () => {
		let accessed = false;
		const proof = { ...sourceProof };
		Object.defineProperty(proof, "publisherId", {
			enumerable: true,
			get() {
				accessed = true;
				return "publisher-a";
			},
		});
		expect(() => canonicalSkillPackageSourceProofV1(proof)).toThrow();
		expect(accessed).toBe(false);
	});
	it("does not coerce nested evidence values or invoke their code", () => {
		let coerced = false;
		const sourceDigest = {
			toString() {
				coerced = true;
				return "a".repeat(64);
			},
		};
		expect(() =>
			canonicalSkillPackageSourceProofV1({
				...sourceProof,
				sourceDigest,
			} as never),
		).toThrow();
		expect(coerced).toBe(false);
	});
	it("rejects payload hidden in a directory entry", () => {
		expect(() =>
			prepareSkillPackageV1({
				archiveBytes: zip([
					{ path: "SKILL.md", text: "# ok" },
					{ path: "references/", text: "unscanned" },
				]),
				name: "summary",
				version: "1.0.0",
			}),
		).toThrow();
	});
	it.each([false, true])(
		"rejects a file ancestor regardless of entry order (%s)",
		(reverse) => {
			const conflict = [
				{ path: "scripts/run.ts", text: "payload" },
				{ path: "scripts", text: "file" },
			];
			if (reverse) conflict.reverse();
			expect(() =>
				prepareSkillPackageV1({
					archiveBytes: zip([{ path: "SKILL.md", text: "# ok" }, ...conflict]),
					name: "summary",
					version: "1.0.0",
				}),
			).toThrow();
		},
	);
	it("accepts an explicit directory containing payload files", () => {
		const prepared = prepareSkillPackageV1({
			archiveBytes: zip([
				{ path: "SKILL.md", text: "# ok" },
				{ path: "references/", text: "" },
				{ path: "references/doc.md", text: "reference" },
			]),
			name: "summary",
			version: "1.0.0",
		});
		expect(prepared.manifest.files.map((file) => file.path)).toEqual([
			"SKILL.md",
			"references/doc.md",
		]);
	});
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
		const prefix = Buffer.from(
			"agent-infra:skill-package-admission:v1\n",
			"ascii",
		);
		expect(Buffer.from(payload).subarray(0, prefix.length)).toEqual(prefix);
		const record = JSON.parse(
			Buffer.from(payload).subarray(prefix.length).toString("utf8"),
		);
		expect(record.schemaVersion).toBe(1);
		expect(Object.keys(record)).toEqual([
			"schemaVersion",
			"skillId",
			"skillVersionId",
			"ownerId",
			"provider",
			"version",
			"packageObjectVersion",
			"packageDigest",
			"manifestDigest",
			"sourceProofDigest",
			"scanReceiptDigest",
			"trustRevision",
			"policyRevision",
			"signingKeyId",
		]);
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

it("rejects trailing bytes, unsupported flags and truncated EOCD comments", () => {
	expect(() =>
		prepareSkillPackageV1({
			archiveBytes: Buffer.concat([archive, Buffer.from([0])]),
			name: "summary",
			version: "1",
		}),
	).toThrow();
	const flags = Buffer.from(archive);
	flags.writeUInt16LE(0x808, 6);
	const central = flags.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
	flags.writeUInt16LE(0x808, central + 8);
	expect(() =>
		prepareSkillPackageV1({
			archiveBytes: flags,
			name: "summary",
			version: "1",
		}),
	).toThrow();
	const comment = Buffer.from(archive);
	comment.writeUInt16LE(1, comment.length - 2);
	expect(() =>
		prepareSkillPackageV1({
			archiveBytes: comment,
			name: "summary",
			version: "1",
		}),
	).toThrow();
});
