import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeObjectStorageV1 } from "./index.ts";
import {
	packSkillProjectSnapshotV1,
	prepareSkillPackageV1,
} from "./skill-package-admission.ts";
import { readAdmittedSkillPackageEntryV1 } from "./skill-package-content.ts";

const encoder = new TextEncoder();
const sha256 = (value: Uint8Array) =>
	createHash("sha256").update(value).digest("hex");
const archive = packSkillProjectSnapshotV1([
	{ path: "references/info.txt", bytes: encoder.encode("resource") },
	{ path: "SKILL.md", bytes: encoder.encode("# summary\n<script>x</script>") },
]);
const prepared = prepareSkillPackageV1({
	archiveBytes: archive,
	name: "summary",
	version: "1.0.0",
});
const objectRef = "00000000-0000-4000-8000-000000000001";

async function stored(bytes: Uint8Array = archive) {
	const storage = new FakeObjectStorageV1({ contentPolicy: "skill-package" });
	const metadata = await storage.upload({
		objectRef,
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		descriptor: {
			name: "skill.zip",
			mediaType: "application/zip",
			sizeBytes: bytes.byteLength,
			sha256: sha256(bytes),
		},
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}),
	});
	return { storage, zip: { objectRef, ...metadata } };
}

function input(
	value: Awaited<ReturnType<typeof stored>>,
	overrides: Partial<
		Parameters<typeof readAdmittedSkillPackageEntryV1>[0]
	> = {},
) {
	return {
		storage: value.storage,
		zip: value.zip,
		name: "summary",
		version: "1.0.0",
		packageDigest: prepared.packageDigest,
		manifestDigest: sha256(prepared.manifestBytes),
		...overrides,
	};
}

describe("admitted Skill package content read", () => {
	it("returns SKILL.md bytes and the full verified file list from the fixed object version", async () => {
		const value = await stored();
		const result = await readAdmittedSkillPackageEntryV1(input(value));
		expect(new TextDecoder().decode(result.entry)).toBe(
			"# summary\n<script>x</script>",
		);
		expect(result.files).toEqual([
			{ path: "SKILL.md", sizeBytes: 28 },
			{ path: "references/info.txt", sizeBytes: 8 },
		]);
	});

	it.each([
		["a different package digest", { packageDigest: "f".repeat(64) }],
		["a different manifest digest", { manifestDigest: "f".repeat(64) }],
		["another package name", { name: "other" }],
	])("fails closed for %s", async (_label, overrides) => {
		const value = await stored();
		await expect(
			readAdmittedSkillPackageEntryV1(input(value, overrides)),
		).rejects.toMatchObject({ code: "digest_mismatch" });
	});

	it("never reads another object version, a non-ZIP descriptor or bytes past the descriptor length", async () => {
		const value = await stored();
		await expect(
			readAdmittedSkillPackageEntryV1(
				input(value, { zip: { ...value.zip, version: "another-version" } }),
			),
		).rejects.toBeTruthy();
		await expect(
			readAdmittedSkillPackageEntryV1(
				input(value, { zip: { ...value.zip, mediaType: "application/json" } }),
			),
		).rejects.toMatchObject({ code: "digest_mismatch" });
		await expect(
			readAdmittedSkillPackageEntryV1(
				input(value, {
					zip: { ...value.zip, sizeBytes: value.zip.sizeBytes - 1 },
				}),
			),
		).rejects.toMatchObject({ code: "digest_mismatch" });
	});
});
