import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeObjectStorageV1 } from "./index.ts";
import type { SkillPackageScanReceiptV1 } from "./skill-package-admission.js";
import { prepareSkillPackageV1 } from "./skill-package-admission.js";
import { SkillPackageSupplierV1 } from "./skill-package-supplier.js";

function crc32(bytes: Uint8Array) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++)
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
		const body = new TextEncoder().encode(entry.text);
		const header = new Uint8Array(30 + name.length);
		const view = new DataView(header.buffer);
		view.setUint32(0, 0x04034b50, true);
		view.setUint16(4, 20, true);
		view.setUint16(6, 0x800, true);
		view.setUint32(14, crc32(body), true);
		view.setUint32(18, body.length, true);
		view.setUint32(22, body.length, true);
		view.setUint16(26, name.length, true);
		header.set(name, 30);
		local.push(header, body);
		const record = new Uint8Array(46 + name.length);
		const centralView = new DataView(record.buffer);
		centralView.setUint32(0, 0x02014b50, true);
		centralView.setUint16(4, 20, true);
		centralView.setUint16(6, 20, true);
		centralView.setUint16(8, 0x800, true);
		centralView.setUint32(16, crc32(body), true);
		centralView.setUint32(20, body.length, true);
		centralView.setUint32(24, body.length, true);
		centralView.setUint16(28, name.length, true);
		centralView.setUint32(42, offset, true);
		record.set(name, 46);
		central.push(record);
		offset += header.length + body.length;
	}
	const centralLength = central.reduce((sum, item) => sum + item.length, 0);
	const end = new Uint8Array(22);
	const view = new DataView(end.buffer);
	view.setUint32(0, 0x06054b50, true);
	view.setUint16(8, entries.length, true);
	view.setUint16(10, entries.length, true);
	view.setUint32(12, centralLength, true);
	view.setUint32(16, offset, true);
	return Buffer.concat([...local, ...central, end]);
}
const archive = zip([{ path: "SKILL.md", text: "# summary" }]);
const identity = {
	actor: {
		schemaVersion: 1 as const,
		userId: "owner-a",
		accountStatus: "active" as const,
		organizationIds: ["org-a"],
		isAdministrator: false,
	},
	authorizationRevision: "identity-1",
};

describe("Skill package supplier", () => {
	it("verifies, stores and registers an immutable package bundle", async () => {
		const storage = new FakeObjectStorageV1();
		const keys = generateKeyPairSync("ed25519");
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
		const lifecycle = {
			async registerVersion(_context: unknown, _key: string, input: unknown) {
				return {
					replayed: false,
					version: {
						...(input as Record<string, unknown>),
						state: "published",
					},
				};
			},
		};
		let scans = 0;
		const supplier = new SkillPackageSupplierV1({
			storage,
			lifecycle,
			resolveIdentity: async () => identity,
			resolvePolicyRevision: async () => "policy-1",
			sourceVerifier: { verify: async () => source },
			scanner: {
				async scan(input) {
					scans += 1;
					const receipt: SkillPackageScanReceiptV1 = {
						schemaVersion: 1,
						scannerId: "scanner-a",
						engineVersion: "1",
						rulesetDigest: "b".repeat(64),
						policyRevision: input.policyRevision,
						scannedAt: new Date().toISOString(),
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
						packageDigest: input.packageDigest,
						manifestDigest: input.manifestDigest,
						scannedFileCount: input.fileCount,
						scannedBytes: input.totalBytes,
						verdict: "clean",
					};
					return receipt;
				},
			},
			signer: {
				keyId: "key-a",
				trustRevision: "trust-1",
				privateKey: keys.privateKey,
				publicKey: keys.publicKey,
			},
		});
		const result = await supplier.admitVersion(
			{ userId: "owner-a", requestId: "request-a", traceId: "trace-a" },
			{
				name: "summary",
				skillId: "skill-a",
				skillVersionId: "version-a",
				visibility: "PRIVATE",
				provider: "my_library",
				version: "1.0.0",
				sourceVersion: "source-1",
				sourceDigest: "a".repeat(64),
				approvalRef: null,
				trustRevision: "trust-1",
				policyRevision: "policy-1",
				archiveBytes: archive,
			},
		);
		expect(result.artifacts.packageObjectVersion).toBeTypeOf("string");
		expect(
			await storage.inspect(result.artifacts.packageObjectRef),
		).toMatchObject({ sha256: prepared.packageDigest });
		await supplier.admitVersion(
			{ userId: "owner-a", requestId: "request-a", traceId: "trace-a" },
			{
				name: "summary",
				skillId: "skill-a",
				skillVersionId: "version-a",
				visibility: "PRIVATE",
				provider: "my_library",
				version: "1.0.0",
				sourceVersion: "source-1",
				sourceDigest: "a".repeat(64),
				approvalRef: null,
				trustRevision: "trust-1",
				policyRevision: "policy-1",
				archiveBytes: archive,
			},
		);
		expect(scans).toBe(1);
	});
});
