import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import {
	createTextContentDetectorV1,
	PLAIN_TEXT_MEDIA_TYPE_V1,
	resolveFileMediaTypeV1,
} from "./text.js";

export * from "./text.js";

/**
 * 按实际字节识别文件内容的唯一实现（工程 Spec §15.4.1、§15.4.4）。
 *
 * ObjectStorage Adapter 在写入完成时、Runtime Driver 在发布回答内 `sandbox:` 引用前都用它
 * 计算大小、SHA-256 与媒体类型，两边的识别规则因此完全一致：文件头由固定版本的 file-type
 * 识别，识别不出且整体是不含控制字符的 UTF-8 时为 `text/plain`，否则无法确认并拒绝。
 * 文件用途带声明类型时（Adapter 写入与完成确认），纯文本按 `resolveFileMediaTypeV1` 采用平台
 * 白名单内的声明子类型（#3257）；没有声明类型的调用（企微入站、结果发布）得到字节识别结果。
 */
export type ObjectContentPolicyV1 = "file" | "skill-package";

export interface FileContentFactsV1 {
	readonly sizeBytes: number;
	readonly mediaType: string;
	readonly sha256: string;
}

export function createContentProbe(
	maxBytes: number,
	declaredMediaType?: string,
	policy: ObjectContentPolicyV1 = "file",
) {
	const hash = createHash("sha256");
	const text = createTextContentDetectorV1();
	let sizeBytes = 0;
	let prefix = new Uint8Array();
	const evidenceJson: Uint8Array[] = [];
	return {
		write(chunk: Uint8Array) {
			sizeBytes += chunk.byteLength;
			if (sizeBytes > maxBytes) throw new Error("File content limit exceeded");
			hash.update(chunk);
			if (
				policy === "skill-package" &&
				declaredMediaType === "application/json"
			) {
				if (sizeBytes > 2_000_000)
					throw new Error("Package evidence limit exceeded");
				evidenceJson.push(chunk.slice());
			}
			if (prefix.byteLength < 8192)
				prefix = Buffer.concat([
					prefix,
					chunk.subarray(0, 8192 - prefix.byteLength),
				]);
			text.write(chunk);
		},
		async finish() {
			if (
				policy === "skill-package" &&
				declaredMediaType !== "application/zip" &&
				declaredMediaType !== "application/json" &&
				declaredMediaType !== "application/octet-stream"
			)
				throw new Error("Unsupported skill package media type");
			const plainText = text.finish();
			let evidenceType: string | undefined;
			if (
				policy === "skill-package" &&
				declaredMediaType === "application/json"
			) {
				JSON.parse(
					new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
						Buffer.concat(evidenceJson),
					),
				);
				evidenceType = "application/json";
			}
			// Detached Ed25519 bytes have no file magic. This purpose is selected only
			// by the server's separate package storage, after the supplier verifies the signature.
			if (
				policy === "skill-package" &&
				declaredMediaType === "application/octet-stream"
			) {
				if (sizeBytes !== 64)
					throw new Error("Invalid detached signature size");
				evidenceType = "application/octet-stream";
			}
			const detected =
				!evidenceType && prefix.length
					? await fileTypeFromBuffer(prefix)
					: undefined;
			const detectedMediaType =
				evidenceType ??
				detected?.mime ??
				(plainText ? PLAIN_TEXT_MEDIA_TYPE_V1 : null);
			if (
				policy === "skill-package" &&
				declaredMediaType === "application/zip" &&
				detectedMediaType !== "application/zip"
			)
				throw new Error("Invalid skill package archive type");
			if (!detectedMediaType) throw new Error("File format cannot be verified");
			// #3257：文件用途下，无法从字节确认子类型的纯文本以白名单内的声明类型为准（工程 Spec §15.4.1）。
			const mediaType =
				policy === "file"
					? resolveFileMediaTypeV1(detectedMediaType, declaredMediaType)
					: detectedMediaType;
			return { sizeBytes, mediaType, sha256: hash.digest("hex") };
		},
	};
}

/**
 * 对已在内存中的完整内容执行同一识别：超过 `maxBytes` 或格式无法确认时抛错。没有声明类型，
 * 因此纯文本得到 `text/plain`（Runtime 结果发布，工程 Spec §15.4.4）。
 */
export async function inspectFileContentV1(
	bytes: Uint8Array,
	maxBytes: number,
): Promise<FileContentFactsV1> {
	const probe = createContentProbe(maxBytes);
	probe.write(bytes);
	return probe.finish();
}
