import { crc32, gunzipSync, inflateRawSync } from "node:zlib";
import type { ProviderExecutor } from "@agent-infra/connection-core";
import {
	StaticSpacesAdapter as ArchivedAdapter,
	staticSpacesConnectionCatalog as archived,
} from "./static-spaces.ts";
import { staticSpacesV6ExecutorDigest } from "./static-spaces-v6-integrity.ts";

export const staticSpacesStandardApproval = {
	approvalIssue: "1880",
	approvalReference:
		"https://github.com/AgoraIO-Extensions/agent-infra/pull/1878",
	lifecycle: "CONNECTION_UNRESOLVED_WRITE",
} as const;
const releaseId = "static-spaces-connection-v6-standard";
const pathPattern = String.raw`^(?!/)(?![\s\S]*//)(?![\s\S]*/$)(?![\s\S]*(?:^|/)(?:\.{1,2}|__staticspaces)(?:/|$))[^\\\u0000-\u001f\u007f]+$(?![\s\S])`;
export const staticSpacesConnectionCatalog = {
	...archived,
	providerReleaseId: releaseId,
	deploymentProfile: {
		...archived.deploymentProfile,
		standardApproval: staticSpacesStandardApproval,
	},
	executorDigest: staticSpacesV6ExecutorDigest,
	actions: archived.actions.map((action) => ({
		...action,
		id: `${action.name}@v6`,
		description: `${action.description} 普通使用：空间权限由上游判定；public 对所有登录用户可读，不是匿名公开。上游无持久幂等及终态查询；提交未知后冻结该 Connection 的新 WRITE，仍允许正常授权 READ 对账，不自动重试。${action.name.endsWith("publish_space") ? "发布可能初始化或修复组、ACL 和 Application，非原子；部分完成不能整批回滚。" : ""}`,
		inputSchema: action.name.endsWith("list_files")
			? {
					...action.inputSchema,
					properties: {
						...(action.inputSchema.properties as Record<string, object>),
						prefix: {
							type: "string",
							minLength: 1,
							maxLength: 512,
							pattern: pathPattern,
						},
					},
				}
			: action.inputSchema,
	})),
};
function denied(): never {
	throw Object.assign(
		new Error("StaticSpaces archive or invocation is invalid"),
		{ providerCode: "invalid_input", providerStatus: 400 },
	);
}
function safeArchivePath(path: string) {
	if (
		path.length > 512 ||
		!new RegExp(pathPattern).test(path) ||
		!/\.(html?|css|js|json|txt|md|markdown|pdf|csv|xml|ya?ml|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|eot|mp3|wav|ogg|mp4|webm)$/i.test(
			path,
		)
	)
		denied();
}
// Inspect every file before submission; bounded decompression and regular files only.
export function inspectStandardArchive(encoded: unknown, format: unknown) {
	if (
		typeof encoded !== "string" ||
		encoded.length > 1398104 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
	)
		denied();
	const archive = Buffer.from(encoded, "base64");
	if (
		!archive.length ||
		archive.length > 1048576 ||
		archive.toString("base64") !== encoded
	)
		denied();
	let count = 0;
	let total = 0;
	const names = new Set<string>();
	const accept = (name: string, data: Buffer) => {
		if (names.has(name)) denied();
		names.add(name);
		total += data.length;
		if (++count > 100 || total > 2097152) denied();
		safeArchivePath(name);
	};
	if (format === "zip") {
		let offset = 0;
		const localEntries: {
			name: string;
			offset: number;
			size: number;
			crc: number;
			flags: number;
			expected: number;
			method: number;
		}[] = [];
		while (
			offset + 30 <= archive.length &&
			archive.readUInt32LE(offset) === 0x04034b50
		) {
			const flags = archive.readUInt16LE(offset + 6);
			const method = archive.readUInt16LE(offset + 8);
			const size = archive.readUInt32LE(offset + 18);
			const expected = archive.readUInt32LE(offset + 22);
			const nameLength = archive.readUInt16LE(offset + 26);
			const extraLength = archive.readUInt16LE(offset + 28);
			const start = offset + 30 + nameLength + extraLength;
			const end = start + size;
			if (
				flags & ~0x800 ||
				extraLength !== 0 ||
				![0, 8].includes(method) ||
				end > archive.length ||
				expected > 2097152
			)
				denied();
			const name = archive
				.subarray(offset + 30, offset + 30 + nameLength)
				.toString("utf8");
			const compressed = archive.subarray(start, end);
			const bytes =
				method === 0
					? compressed
					: inflateRawSync(compressed, { maxOutputLength: 2097152 });
			if (
				bytes.length !== expected ||
				crc32(bytes) !== archive.readUInt32LE(offset + 14)
			)
				denied();
			localEntries.push({
				name,
				offset,
				size,
				crc: archive.readUInt32LE(offset + 14),
				flags,
				expected,
				method,
			});
			accept(name, bytes);
			offset = end;
		}
		// Reject absent directories or local entries hidden from the central directory.
		const directoryStart = offset;
		let entries = 0;
		while (
			offset + 46 <= archive.length &&
			archive.readUInt32LE(offset) === 0x02014b50
		) {
			const local = localEntries[entries];
			const centralName = archive
				.subarray(offset + 46, offset + 46 + archive.readUInt16LE(offset + 28))
				.toString("utf8");
			if (
				!local ||
				archive.readUInt16LE(offset + 30) !== 0 ||
				centralName !== local.name ||
				archive.readUInt32LE(offset + 42) !== local.offset ||
				archive.readUInt32LE(offset + 20) !== local.size ||
				archive.readUInt32LE(offset + 16) !== local.crc ||
				archive.readUInt16LE(offset + 10) !== local.method ||
				archive.readUInt16LE(offset + 34) !== 0 ||
				archive.readUInt16LE(offset + 8) !== local.flags ||
				archive.readUInt32LE(offset + 24) !== local.expected
			)
				denied();
			const external = archive.readUInt32LE(offset + 38) >>> 16;
			if ((external & 0xf000) !== 0 && (external & 0xf000) !== 0x8000) denied();
			offset +=
				46 +
				archive.readUInt16LE(offset + 28) +
				archive.readUInt16LE(offset + 30) +
				archive.readUInt16LE(offset + 32);
			entries++;
		}
		if (
			entries !== count ||
			offset + 22 > archive.length ||
			archive.readUInt32LE(offset) !== 0x06054b50 ||
			offset + 22 + archive.readUInt16LE(offset + 20) !== archive.length ||
			archive.readUInt16LE(offset + 4) !== 0 ||
			archive.readUInt16LE(offset + 6) !== 0 ||
			archive.readUInt16LE(offset + 8) !== count ||
			archive.readUInt16LE(offset + 10) !== count ||
			archive.readUInt32LE(offset + 16) !== directoryStart ||
			archive.readUInt32LE(offset + 12) !== offset - directoryStart
		)
			denied();
	} else if (format === "tgz" || format === "tar.gz") {
		const tar = gunzipSync(archive, { maxOutputLength: 2162688 });
		let offset = 0;
		while (
			offset + 512 <= tar.length &&
			tar.subarray(offset, offset + 512).some((byte) => byte !== 0)
		) {
			const header = tar.subarray(offset, offset + 512);
			const field = (start: number, length: number) =>
				header
					.subarray(start, start + length)
					.toString("utf8")
					.replace(/\0.*$/s, "");
			const checksum = field(148, 8).trim();
			if (
				!/^[0-7]+$/.test(checksum) ||
				Number.parseInt(checksum, 8) !==
					header.reduce(
						(sum, byte, index) =>
							sum + (index >= 148 && index < 156 ? 32 : byte),
						0,
					)
			)
				denied();
			const sizeText = field(124, 12).trim();
			if (
				!/^[0-7]+$/.test(sizeText) ||
				![0, 48].includes(header[156] ?? -1) ||
				field(345, 155)
			)
				denied();
			const size = Number.parseInt(sizeText, 8);
			const start = offset + 512;
			if (start + size > tar.length) denied();
			accept(field(0, 100), tar.subarray(start, start + size));
			offset = start + Math.ceil(size / 512) * 512;
		}
		if (
			tar.length - offset < 1024 ||
			tar.subarray(offset).some((byte) => byte !== 0)
		)
			denied();
	} else denied();
	if (!count) denied();
}

export class StaticSpacesAdapter {
	readonly providerId = "static-spaces";
	readonly providerReleaseId = releaseId;
	private readonly archived: ArchivedAdapter;
	constructor(fetcher: typeof fetch) {
		this.archived = new ArchivedAdapter(fetcher);
	}
	async validateCredential(accessToken: string) {
		return {
			...(await this.archived.validateCredential(accessToken)),
			providerReleaseId: releaseId,
		};
	}
	async execute(
		input: Parameters<ProviderExecutor["execute"]>[0],
	): Promise<Record<string, unknown>> {
		if (
			input.providerId !== this.providerId ||
			input.providerReleaseId !== releaseId ||
			input.actionVersionId !== `${input.action}@v6`
		)
			denied();
		if (input.action === "static-spaces.upload_static_package")
			inspectStandardArchive(
				input.input.archive_base64,
				input.input.archive_format,
			);
		return this.archived.execute({
			...input,
			providerReleaseId: archived.providerReleaseId,
			actionVersionId: `${input.action}@v1`,
		});
	}
}
