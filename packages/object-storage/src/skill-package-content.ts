import { createHash } from "node:crypto";
import type { SkillPackagePublicationObjectV1 } from "@agent-infra/platform-core";
import {
	prepareSkillPackageV1,
	SkillPackageAdmissionErrorV1,
} from "./skill-package-admission.js";
import type { ObjectStorageDataV1 } from "./types.js";

const MAX_ARCHIVE_BYTES = 50_000_000;
const sha256 = (value: Uint8Array) =>
	createHash("sha256").update(value).digest("hex");

/**
 * 按已准入包描述的固定对象版本读取 ZIP，核对实际字节与版本记录的
 * packageDigest、重建 manifest 的 manifestDigest 后，返回 SKILL.md 字节与文件清单。
 * 只做读取与核对，不执行包内任何内容；正文的截断与投影由调用方完成。
 */
export async function readAdmittedSkillPackageEntryV1(input: {
	readonly storage: Pick<ObjectStorageDataV1, "download">;
	readonly zip: SkillPackagePublicationObjectV1;
	readonly name: string;
	readonly version: string;
	readonly packageDigest: string;
	readonly manifestDigest: string;
	readonly signal?: AbortSignal;
}): Promise<
	Readonly<{
		entry: Uint8Array;
		files: readonly Readonly<{ path: string; sizeBytes: number }>[];
	}>
> {
	const { zip } = input;
	if (
		zip.mediaType !== "application/zip" ||
		zip.sha256 !== input.packageDigest ||
		!Number.isSafeInteger(zip.sizeBytes) ||
		zip.sizeBytes < 1 ||
		zip.sizeBytes > MAX_ARCHIVE_BYTES
	)
		throw new SkillPackageAdmissionErrorV1("digest_mismatch");
	const stream = await input.storage.download({
		objectRef: zip.objectRef,
		version: zip.version,
		etag: zip.etag,
		expiresAt: new Date(Date.now() + 300_000).toISOString(),
		...(input.signal ? { signal: input.signal } : {}),
	});
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			length += next.value.byteLength;
			// 超过包描述的长度就停止读取，不缓冲多余字节。
			if (length > zip.sizeBytes)
				throw new SkillPackageAdmissionErrorV1("digest_mismatch");
			chunks.push(next.value);
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	const archiveBytes = Buffer.concat(chunks);
	if (length !== zip.sizeBytes || sha256(archiveBytes) !== input.packageDigest)
		throw new SkillPackageAdmissionErrorV1("digest_mismatch");
	const prepared = prepareSkillPackageV1({
		archiveBytes,
		name: input.name,
		version: input.version,
	});
	const entry = prepared.files.find((file) => file.path === "SKILL.md");
	if (
		prepared.packageDigest !== input.packageDigest ||
		sha256(prepared.manifestBytes) !== input.manifestDigest ||
		!entry
	)
		throw new SkillPackageAdmissionErrorV1("digest_mismatch");
	return Object.freeze({
		entry: entry.bytes,
		files: Object.freeze(
			prepared.manifest.files.map((file) =>
				Object.freeze({ path: file.path, sizeBytes: file.sizeBytes }),
			),
		),
	});
}
