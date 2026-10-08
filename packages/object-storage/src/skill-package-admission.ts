import { createHash, type sign, verify } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import {
	type SkillPackageEntryV1,
	SkillPackageValidationErrorV1,
	validateSkillPackageEntriesV1,
} from "@agent-infra/platform-core";

const MAX_ARCHIVE_BYTES = 50_000_000;
const MAX_FILES = 2_000;
const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type SkillPackageAdmissionErrorCodeV1 =
	| "invalid_archive"
	| "archive_limit"
	| "invalid_path"
	| "duplicate_path"
	| "path_conflict"
	| "symlink"
	| "missing_entry"
	| "digest_mismatch"
	| "source_untrusted"
	| "scan_unavailable"
	| "scan_rejected"
	| "signature_invalid";

export class SkillPackageAdmissionErrorV1 extends Error {
	constructor(readonly code: SkillPackageAdmissionErrorCodeV1) {
		super("Skill package admission rejected");
		this.name = "SkillPackageAdmissionErrorV1";
	}
}

export type SkillPackageSourceProofV1 = Readonly<{
	schemaVersion: 1;
	provider: string;
	publisherId: string;
	sourceVersion: string;
	sourceDigest: string;
	approvalRef: string | null;
	trustRevision: string;
}>;

export type SkillPackageScanReceiptV1 = Readonly<{
	schemaVersion: 1;
	scannerId: string;
	engineVersion: string;
	rulesetDigest: string;
	policyRevision: string;
	scannedAt: string;
	expiresAt: string;
	packageDigest: string;
	manifestDigest: string;
	scannedFileCount: number;
	scannedBytes: number;
	verdict: "clean";
}>;

export interface SkillPackageSourceVerifierV1 {
	verify(
		input: Readonly<{
			provider: string;
			sourceVersion: string;
			sourceDigest: string;
			trustRevision: string;
			approvalRef: string | null;
		}>,
	): Promise<SkillPackageSourceProofV1>;
}

export interface SkillPackageScannerV1 {
	scan(
		input: Readonly<{
			packageDigest: string;
			manifestDigest: string;
			fileCount: number;
			totalBytes: number;
			sourceProofDigest: string;
			policyRevision: string;
		}>,
	): Promise<SkillPackageScanReceiptV1>;
}

export interface SkillPackageAdmissionSignerV1 {
	readonly keyId: string;
	readonly trustRevision: string;
	readonly privateKey: Parameters<typeof sign>[2];
	readonly publicKey: Parameters<typeof verify>[2];
}

export type SkillPackageFileV1 = Readonly<{
	path: string;
	bytes: Uint8Array;
}>;

export type PreparedSkillPackageV1 = Readonly<{
	packageDigest: string;
	manifest: Readonly<{
		schemaVersion: 1;
		name: string;
		version: string;
		entryPath: "SKILL.md";
		files: readonly Readonly<{
			path: string;
			sizeBytes: number;
			sha256: string;
		}>[];
		packageDigest: string;
	}>;
	manifestBytes: Uint8Array;
	files: readonly SkillPackageFileV1[];
	archiveBytes: Uint8Array;
	fileCount: number;
	totalBytes: number;
}>;

function reject(code: SkillPackageAdmissionErrorCodeV1): never {
	throw new SkillPackageAdmissionErrorV1(code);
}
function u16(bytes: Uint8Array, offset: number) {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}
function u32(bytes: Uint8Array, offset: number) {
	return (
		((bytes[offset] ?? 0) |
			((bytes[offset + 1] ?? 0) << 8) |
			((bytes[offset + 2] ?? 0) << 16) |
			((bytes[offset + 3] ?? 0) << 24)) >>>
		0
	);
}
function slice(bytes: Uint8Array, start: number, length: number) {
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(length) ||
		start < 0 ||
		length < 0 ||
		start + length > bytes.length
	)
		reject("invalid_archive");
	return bytes.subarray(start, start + length);
}
function digest(bytes: Uint8Array) {
	return createHash("sha256").update(bytes).digest("hex");
}
function crc32(bytes: Uint8Array) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++)
			crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}
function pathFromBytes(bytes: Uint8Array, utf8: boolean) {
	try {
		if (!utf8 && bytes.some((value) => value > 0x7f)) reject("invalid_path");
		const path = decoder.decode(bytes);
		const logicalPath = path.endsWith("/") ? path.slice(0, -1) : path;
		if (
			logicalPath.length === 0 ||
			logicalPath.length > 512 ||
			path.includes("\\") ||
			path.includes("\0") ||
			path.startsWith("/") ||
			logicalPath
				.split("/")
				.some((part) => part === "" || part === "." || part === "..")
		)
			reject("invalid_path");
		return path;
	} catch (error) {
		if (error instanceof SkillPackageAdmissionErrorV1) throw error;
		reject("invalid_path");
	}
}
function canonical(value: unknown) {
	const result = JSON.stringify(value);
	if (result === undefined) reject("digest_mismatch");
	return encoder.encode(result);
}
function validText(value: unknown, maximum = 1024): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maximum &&
		[...value].every((character) => {
			const code = character.codePointAt(0) ?? 0;
			return (
				code > 0x1f && code !== 0x7f && !(code >= 0xd800 && code <= 0xdfff)
			);
		})
	);
}
function findEndOfCentralDirectory(bytes: Uint8Array) {
	const start = Math.max(0, bytes.length - 22 - 65_535);
	for (let offset = bytes.length - 22; offset >= start; offset--) {
		if (u32(bytes, offset) === ZIP_EOCD) return offset;
	}
	reject("invalid_archive");
}
function hasSymlink(mode: number) {
	return (mode & 0xf000) === 0xa000;
}

function parseZip(bytes: Uint8Array) {
	if (bytes.length === 0 || bytes.length > MAX_ARCHIVE_BYTES)
		reject("archive_limit");
	const eocd = findEndOfCentralDirectory(bytes);
	const disk = u16(bytes, eocd + 4);
	const centralDisk = u16(bytes, eocd + 6);
	const entries = u16(bytes, eocd + 10);
	const centralBytes = u32(bytes, eocd + 12);
	const centralOffset = u32(bytes, eocd + 16);
	if (
		disk !== 0 ||
		centralDisk !== 0 ||
		entries > MAX_FILES ||
		u16(bytes, eocd + 8) !== entries ||
		centralOffset + centralBytes > bytes.length ||
		centralOffset + centralBytes > eocd
	)
		reject("invalid_archive");
	const files: SkillPackageFileV1[] = [];
	const seen = new Set<string>();
	const filePaths = new Set<string>();
	const directoryPaths = new Set<string>();
	const localRanges: { start: number; end: number }[] = [];
	let offset = centralOffset;
	let totalBytes = 0;
	for (let index = 0; index < entries; index++) {
		if (u32(bytes, offset) !== ZIP_CENTRAL) reject("invalid_archive");
		const flags = u16(bytes, offset + 8);
		const method = u16(bytes, offset + 10);
		const crc = u32(bytes, offset + 16);
		const compressedSize = u32(bytes, offset + 20);
		const uncompressedSize = u32(bytes, offset + 24);
		const nameLength = u16(bytes, offset + 28);
		const extraLength = u16(bytes, offset + 30);
		const commentLength = u16(bytes, offset + 32);
		const externalAttributes = u32(bytes, offset + 38);
		const localOffset = u32(bytes, offset + 42);
		if (
			compressedSize === 0xffffffff ||
			uncompressedSize === 0xffffffff ||
			localOffset === 0xffffffff ||
			(flags & 1) !== 0 ||
			(method !== 0 && method !== 8)
		)
			reject("invalid_archive");
		if (
			uncompressedSize > MAX_ARCHIVE_BYTES ||
			totalBytes + uncompressedSize > MAX_ARCHIVE_BYTES
		)
			reject("archive_limit");
		const name = pathFromBytes(
			slice(bytes, offset + 46, nameLength),
			(flags & 0x800) !== 0,
		);
		const directory =
			name.endsWith("/") ||
			(externalAttributes & 0x10) !== 0 ||
			((externalAttributes >>> 16) & 0xf000) === 0x4000;
		const normalized = directory ? name.slice(0, -1) : name;
		if (!normalized || seen.has(normalized)) reject("duplicate_path");
		const mode = externalAttributes >>> 16;
		if (hasSymlink(mode)) reject("symlink");
		const fileType = mode & 0xf000;
		if (fileType !== 0 && fileType !== 0x4000 && fileType !== 0x8000)
			reject("invalid_archive");
		if (directory) {
			if (filePaths.has(normalized)) reject("path_conflict");
			directoryPaths.add(normalized);
			seen.add(normalized);
			offset += 46 + nameLength + extraLength + commentLength;
			continue;
		}
		for (let parent = normalized; parent.includes("/"); ) {
			parent = parent.slice(0, parent.lastIndexOf("/"));
			if (seen.has(parent)) reject("path_conflict");
		}
		if (
			localOffset + 30 > bytes.length ||
			u32(bytes, localOffset) !== ZIP_LOCAL
		)
			reject("invalid_archive");
		if (directoryPaths.has(normalized)) reject("path_conflict");
		const localNameLength = u16(bytes, localOffset + 26);
		const localExtraLength = u16(bytes, localOffset + 28);
		const localFlags = u16(bytes, localOffset + 6);
		const localMethod = u16(bytes, localOffset + 8);
		const localCrc = u32(bytes, localOffset + 14);
		const localCompressedSize = u32(bytes, localOffset + 18);
		const localUncompressedSize = u32(bytes, localOffset + 22);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const dataEnd = dataStart + compressedSize;
		if (
			Buffer.compare(
				slice(bytes, localOffset + 30, localNameLength),
				slice(bytes, offset + 46, nameLength),
			) !== 0 ||
			localFlags !== flags ||
			localMethod !== method ||
			((flags & 8) === 0 &&
				(localCrc !== crc ||
					localCompressedSize !== compressedSize ||
					localUncompressedSize !== uncompressedSize)) ||
			dataEnd > centralOffset
		) {
			reject("invalid_archive");
		}
		for (const range of localRanges) {
			if (localOffset < range.end && range.start < dataEnd)
				reject("invalid_archive");
		}
		localRanges.push({ start: localOffset, end: dataEnd });
		const compressed = slice(bytes, dataStart, compressedSize);
		let content: Uint8Array;
		try {
			content =
				method === 0
					? compressed.slice()
					: inflateRawSync(compressed, { maxOutputLength: uncompressedSize });
		} catch {
			reject("invalid_archive");
		}
		if (content.length !== uncompressedSize || crc32(content) !== crc)
			reject("digest_mismatch");
		totalBytes += content.length;
		if (totalBytes > MAX_ARCHIVE_BYTES) reject("archive_limit");
		seen.add(normalized);
		filePaths.add(normalized);
		files.push({ path: normalized, bytes: content });
		offset += 46 + nameLength + extraLength + commentLength;
	}
	if (offset !== centralOffset + centralBytes) reject("invalid_archive");
	if (!files.some((file) => file.path === "SKILL.md")) reject("missing_entry");
	return { files, totalBytes };
}

export function prepareSkillPackageV1(
	input: Readonly<{
		archiveBytes: Uint8Array;
		name: string;
		version: string;
	}>,
): PreparedSkillPackageV1 {
	if (
		!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(input.name) ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.version)
	)
		reject("invalid_archive");
	const parsed = parseZip(input.archiveBytes);
	const entries: SkillPackageEntryV1[] = parsed.files.map((file) => ({
		path: file.path,
		kind: "file",
		sizeBytes: file.bytes.byteLength,
	}));
	try {
		validateSkillPackageEntriesV1(entries);
	} catch (error) {
		if (error instanceof SkillPackageValidationErrorV1)
			reject(
				error.code === "symlink"
					? "symlink"
					: error.code === "missing_entry"
						? "missing_entry"
						: "invalid_archive",
			);
		reject("invalid_archive");
	}
	const files = [...parsed.files].sort((a, b) => {
		const left = encoder.encode(a.path);
		const right = encoder.encode(b.path);
		for (let index = 0; index < Math.min(left.length, right.length); index++) {
			if (left[index] !== right[index])
				return (left[index] ?? 0) - (right[index] ?? 0);
		}
		return left.length - right.length;
	});
	const manifest = {
		schemaVersion: 1 as const,
		name: input.name,
		version: input.version,
		entryPath: "SKILL.md" as const,
		files: files.map((file) => ({
			path: file.path,
			sizeBytes: file.bytes.byteLength,
			sha256: digest(file.bytes),
		})),
		packageDigest: digest(input.archiveBytes),
	};
	const manifestBytes = canonical(manifest);
	return Object.freeze({
		packageDigest: manifest.packageDigest,
		manifest: Object.freeze(manifest),
		manifestBytes,
		files: Object.freeze(
			files.map((file) =>
				Object.freeze({ path: file.path, bytes: file.bytes.slice() }),
			),
		),
		archiveBytes: input.archiveBytes.slice(),
		fileCount: files.length,
		totalBytes: parsed.totalBytes,
	});
}

export function canonicalSkillPackageSourceProofV1(
	proof: SkillPackageSourceProofV1,
) {
	const value = {
		schemaVersion: proof.schemaVersion,
		provider: proof.provider,
		publisherId: proof.publisherId,
		sourceVersion: proof.sourceVersion,
		sourceDigest: proof.sourceDigest,
		approvalRef: proof.approvalRef,
		trustRevision: proof.trustRevision,
	};
	if (
		Object.keys(proof).toSorted().join(",") !==
		Object.keys(value).toSorted().join(",")
	)
		reject("source_untrusted");
	return canonical(value);
}
export function canonicalSkillPackageScanReceiptV1(
	receipt: SkillPackageScanReceiptV1,
) {
	const value = {
		schemaVersion: receipt.schemaVersion,
		scannerId: receipt.scannerId,
		engineVersion: receipt.engineVersion,
		rulesetDigest: receipt.rulesetDigest,
		policyRevision: receipt.policyRevision,
		scannedAt: receipt.scannedAt,
		expiresAt: receipt.expiresAt,
		packageDigest: receipt.packageDigest,
		manifestDigest: receipt.manifestDigest,
		scannedFileCount: receipt.scannedFileCount,
		scannedBytes: receipt.scannedBytes,
		verdict: receipt.verdict,
	};
	if (
		Object.keys(receipt).toSorted().join(",") !==
		Object.keys(value).toSorted().join(",")
	)
		reject("scan_rejected");
	return canonical(value);
}
export function verifySkillPackageScanReceiptV1(
	receipt: SkillPackageScanReceiptV1,
	prepared: PreparedSkillPackageV1,
	sourceProofDigest: string,
	policyRevision: string,
) {
	if (
		receipt.schemaVersion !== 1 ||
		!validText(receipt.scannerId) ||
		!validText(receipt.engineVersion) ||
		!/^[a-f0-9]{64}$/.test(receipt.rulesetDigest) ||
		!validText(receipt.policyRevision) ||
		receipt.verdict !== "clean" ||
		receipt.packageDigest !== prepared.packageDigest ||
		receipt.manifestDigest !== digest(prepared.manifestBytes) ||
		receipt.policyRevision !== policyRevision ||
		receipt.scannedFileCount !== prepared.fileCount ||
		receipt.scannedBytes !== prepared.totalBytes ||
		!Number.isSafeInteger(receipt.scannedFileCount) ||
		!Number.isSafeInteger(receipt.scannedBytes) ||
		!Number.isFinite(Date.parse(receipt.scannedAt)) ||
		!Number.isFinite(Date.parse(receipt.expiresAt)) ||
		Date.parse(receipt.expiresAt) - Date.parse(receipt.scannedAt) >
			86_400_000 ||
		Date.parse(receipt.expiresAt) <= Date.now() ||
		!/^[a-f0-9]{64}$/.test(sourceProofDigest)
	)
		reject("scan_rejected");
}

export function admissionSignatureBytesV1(
	input: Readonly<{
		packageObjectVersion: string;
		skillId: string;
		skillVersionId: string;
		ownerId: string;
		provider: string;
		version: string;
		packageDigest: string;
		manifestDigest: string;
		sourceProofDigest: string;
		scanReceiptDigest: string;
		trustRevision: string;
		policyRevision: string;
		signingKeyId: string;
	}>,
): Uint8Array {
	const value = {
		packageObjectVersion: input.packageObjectVersion,
		skillId: input.skillId,
		skillVersionId: input.skillVersionId,
		ownerId: input.ownerId,
		provider: input.provider,
		version: input.version,
		packageDigest: input.packageDigest,
		manifestDigest: input.manifestDigest,
		sourceProofDigest: input.sourceProofDigest,
		scanReceiptDigest: input.scanReceiptDigest,
		trustRevision: input.trustRevision,
		policyRevision: input.policyRevision,
		signingKeyId: input.signingKeyId,
	};
	return Buffer.concat([
		Buffer.from("agent-infra:skill-package-admission:v1\n", "ascii"),
		Buffer.from(canonical(value)),
	]);
}

export function verifyAdmissionSignatureV1(
	payload: Uint8Array,
	signature: Uint8Array,
	publicKey: Parameters<typeof verify>[2],
) {
	if (!verify(null, payload, publicKey, signature)) reject("signature_invalid");
}
