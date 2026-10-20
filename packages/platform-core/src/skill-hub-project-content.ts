import { createHash } from "node:crypto";
import {
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
} from "./agent-management-input.js";
import {
	type SkillHubVisibilityV1,
	SkillPackageValidationErrorV1,
	skillHubVisibilityV1,
	validateSkillPackageEntriesV1,
} from "./skill-hub.js";
import {
	parseSkillHubIdempotencyKeyV1,
	parseSkillHubIdV1,
	parseSkillHubRequestV1,
	SkillHubOperationErrorV1,
	type SkillHubRequestV1,
} from "./skill-hub-management.js";
import type { SkillHubProjectV1 } from "./skill-hub-project.js";
import type { SkillPackagePublicationResultV1 } from "./skill-package-publication.js";

/**
 * 网页编辑的项目内容上限（工程 Spec §11.6）：低于 §11.6.1 的包上限，并受 1 MiB JSON
 * 请求上限约束。与契约 skillHubProjectContentLimitsV1 一致。
 */
export const skillHubProjectContentLimitsV1 = Object.freeze({
	maxFiles: 100,
	maxFileBytes: 262_144,
	maxTotalBytes: 524_288,
});

export type SkillHubProjectFileV1 = Readonly<{
	path: string;
	bytes: Uint8Array;
}>;

/** 已校验的项目内容：按路径 UTF-8 字节序排序，摘要覆盖每个文件的路径、长度与 SHA-256。 */
export type SkillHubProjectContentDraftV1 = Readonly<{
	files: readonly SkillHubProjectFileV1[];
	fileCount: number;
	totalBytes: number;
	contentDigest: string;
}>;

const encoder = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
// SKILL.md 在根目录；其余文件只能放在规范目录 scripts/、references/、assets/ 下。
const projectPath =
	/^(?:SKILL\.md|(?:scripts|references|assets)\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+)$/;
const base64 =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function invalid(): never {
	throw new SkillHubOperationErrorV1("invalid_input");
}

/** 输入快照与键校验的底层错误统一按无效输入拒绝。 */
function parsed<T>(work: () => T): T {
	try {
		return work();
	} catch {
		invalid();
	}
}

function sha256(bytes: Uint8Array) {
	return createHash("sha256").update(bytes).digest("hex");
}

function compareBytes(left: string, right: string) {
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	for (let index = 0; index < Math.min(a.length, b.length); index++)
		if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
	return a.length - b.length;
}

function isUtf8(bytes: Uint8Array) {
	try {
		strictUtf8.decode(bytes);
		return true;
	} catch {
		return false;
	}
}

/**
 * 校验并规范化项目文件集合：路径、目录结构、数量与大小上限，以及根目录必须有非空的
 * UTF-8 SKILL.md。保存、读取与发布都经过这里，存储中的内容也按同一规则复核。
 */
export function normalizeSkillHubProjectFilesV1(
	input: readonly SkillHubProjectFileV1[],
): SkillHubProjectContentDraftV1 {
	const limits = skillHubProjectContentLimitsV1;
	if (input.length < 1 || input.length > limits.maxFiles) invalid();
	const files = input.map((file) => {
		if (
			typeof file.path !== "string" ||
			!projectPath.test(file.path) ||
			encoder.encode(file.path).byteLength > 512 ||
			file.path.split("/").some((part) => part === "." || part === "..") ||
			!(file.bytes instanceof Uint8Array) ||
			file.bytes.byteLength > limits.maxFileBytes
		)
			invalid();
		return Object.freeze({ path: file.path, bytes: file.bytes.slice() });
	});
	const paths = new Set(files.map((file) => file.path));
	// 文件与目录不能同名，例如同时出现 scripts/a 与 scripts/a/b。
	for (const file of files) {
		const parts = file.path.split("/");
		for (let index = 1; index < parts.length; index++)
			if (paths.has(parts.slice(0, index).join("/"))) invalid();
	}
	let validation: { fileCount: number; totalBytes: number };
	try {
		validation = validateSkillPackageEntriesV1(
			files.map((file) => ({
				path: file.path,
				kind: "file" as const,
				sizeBytes: file.bytes.byteLength,
			})),
			{ maxFiles: limits.maxFiles, maxBytes: limits.maxTotalBytes },
		);
	} catch (error) {
		if (error instanceof SkillPackageValidationErrorV1) invalid();
		throw error;
	}
	const entry = files.find((file) => file.path === "SKILL.md");
	if (!entry || entry.bytes.byteLength === 0 || !isUtf8(entry.bytes)) invalid();
	const sorted = files.toSorted((a, b) => compareBytes(a.path, b.path));
	const listing = sorted.map((file) => ({
		path: file.path,
		sizeBytes: file.bytes.byteLength,
		sha256: sha256(file.bytes),
	}));
	return Object.freeze({
		files: Object.freeze(sorted),
		fileCount: validation.fileCount,
		totalBytes: validation.totalBytes,
		contentDigest: sha256(encoder.encode(JSON.stringify(listing))),
	});
}

function decodeFile(input: unknown): SkillHubProjectFileV1 {
	const value = snapshotAgentManagementDataObject(input);
	requireAgentManagementExactKeys(value, ["path", "encoding", "content"]);
	if (typeof value.path !== "string" || typeof value.content !== "string")
		invalid();
	if (value.encoding === "utf8") {
		if (!value.content.isWellFormed()) invalid();
		return { path: value.path, bytes: encoder.encode(value.content) };
	}
	if (value.encoding !== "base64" || !base64.test(value.content)) invalid();
	const bytes = Buffer.from(value.content, "base64");
	// 只接受标准、带填充的 base64；重新编码必须与输入完全一致。
	if (bytes.toString("base64") !== value.content) invalid();
	return { path: value.path, bytes: new Uint8Array(bytes) };
}

export type SkillHubProjectContentUpdateV1 = Readonly<{
	baseRevision: number;
	content: SkillHubProjectContentDraftV1;
}>;

/** 整体替换项目内容；baseRevision 是调用方读取到的修订号（尚无内容时为 0）。 */
export function parseSkillHubProjectContentUpdateV1(
	input: unknown,
): SkillHubProjectContentUpdateV1 {
	return parsed(() => parseContentUpdate(input));
}

function parseContentUpdate(input: unknown): SkillHubProjectContentUpdateV1 {
	const value = snapshotAgentManagementDataObject(input);
	requireAgentManagementExactKeys(value, [
		"schemaVersion",
		"baseRevision",
		"files",
	]);
	if (
		value.schemaVersion !== 1 ||
		typeof value.baseRevision !== "number" ||
		!Number.isSafeInteger(value.baseRevision) ||
		value.baseRevision < 0 ||
		value.baseRevision > 2_147_483_646 ||
		!Array.isArray(value.files) ||
		value.files.length > skillHubProjectContentLimitsV1.maxFiles
	)
		invalid();
	return Object.freeze({
		baseRevision: value.baseRevision,
		content: normalizeSkillHubProjectFilesV1(value.files.map(decodeFile)),
	});
}

/** 读取投影：UTF-8 文本按原文返回，其余按标准 base64 返回。 */
export function projectSkillHubProjectContentV1(input: {
	readonly projectId: string;
	readonly revision: number;
	readonly updatedAt: string | null;
	readonly content: SkillHubProjectContentDraftV1 | null;
}) {
	return {
		schemaVersion: 1 as const,
		projectId: input.projectId,
		revision: input.revision,
		contentDigest: input.content?.contentDigest ?? null,
		fileCount: input.content?.fileCount ?? 0,
		totalBytes: input.content?.totalBytes ?? 0,
		updatedAt: input.updatedAt,
		files: (input.content?.files ?? []).map((file) =>
			isUtf8(file.bytes)
				? {
						path: file.path,
						encoding: "utf8" as const,
						content: strictUtf8.decode(file.bytes),
						sizeBytes: file.bytes.byteLength,
					}
				: {
						path: file.path,
						encoding: "base64" as const,
						content: Buffer.from(file.bytes).toString("base64"),
						sizeBytes: file.bytes.byteLength,
					},
		),
	};
}

export type SkillHubProjectPublicationRequestV1 = Readonly<{
	contentRevision: number;
	version: string;
	visibility: SkillHubVisibilityV1;
}>;

/** 网页发布只提交内容修订、版本号与发布范围；对象版本、摘要、签名与来源都由服务端生成。 */
export function parseSkillHubProjectPublicationRequestV1(
	input: unknown,
): SkillHubProjectPublicationRequestV1 {
	return parsed(() => parsePublicationRequest(input));
}

function parsePublicationRequest(
	input: unknown,
): SkillHubProjectPublicationRequestV1 {
	const value = snapshotAgentManagementDataObject(input);
	requireAgentManagementExactKeys(value, [
		"schemaVersion",
		"contentRevision",
		"version",
		"visibility",
	]);
	if (
		value.schemaVersion !== 1 ||
		typeof value.contentRevision !== "number" ||
		!Number.isSafeInteger(value.contentRevision) ||
		value.contentRevision < 1 ||
		!skillHubVisibilityV1.some((item) => item === value.visibility)
	)
		invalid();
	return Object.freeze({
		contentRevision: value.contentRevision,
		version: parseSkillHubIdV1(value.version),
		visibility: value.visibility as SkillHubVisibilityV1,
	});
}

/** Store 在当前授权下读出的发布来源：本人项目及其当前内容修订。 */
export type SkillHubProjectPublicationSourceV1 = Readonly<{
	project: SkillHubProjectV1;
	revision: number;
	content: SkillHubProjectContentDraftV1 | null;
	/** 当前主体是否仍属于项目所属组织，由 Store 在同一事务内按当前身份解析。 */
	organizationMember: boolean;
}>;

export type SkillHubProjectPublicationSelectionV1 = Readonly<{
	name: string;
	skillId: string;
	skillVersionId: string;
	visibility: SkillHubVisibilityV1;
	provider: "my_library";
	version: string;
	organizationId?: string;
}>;

export interface SkillHubProjectPublicationPortV1 {
	publish(
		context: SkillHubRequestV1,
		projectId: string,
		key: string,
		input: unknown,
	): Promise<SkillPackagePublicationResultV1>;
}

export type SkillHubProjectPublicationDependenciesV1 = Readonly<{
	/** 在当前授权的读取事务内调用 check；check 抛出的拒绝由 Store 记入拒绝审计。 */
	readSource: (
		context: SkillHubRequestV1,
		projectId: string,
		check: (source: SkillHubProjectPublicationSourceV1) => unknown,
	) => Promise<SkillHubProjectPublicationSourceV1>;
	/** 平台项目打包器：只把已校验的文件写成 ZIP，不执行任何内容。 */
	pack: (files: readonly SkillHubProjectFileV1[]) => Uint8Array;
	/** 沿既有 Skill 包供应（扫描、admission 签名、固定对象版本、原操作提交）登记版本。 */
	admit: (input: {
		context: SkillHubRequestV1;
		key: string;
		selection: SkillHubProjectPublicationSelectionV1;
		source: Readonly<{
			sourceVersion: string;
			sourceDigest: string;
			approvalRef: null;
		}>;
		archiveBytes: Uint8Array;
	}) => Promise<SkillPackagePublicationResultV1>;
}>;

/** 平台项目来源引用：项目与内容修订，供来源证明固定实际源版本。 */
export function skillHubProjectSourceVersionV1(
	projectId: string,
	revision: number,
) {
	return `project:${projectId}:r${revision}`;
}

/**
 * 网页项目发布：服务端读取本人项目指定修订的内容并打包，provider 固定为 my_library，
 * ORGANIZATION 的组织取项目所属组织；同一用户、项目与幂等键派生同一版本 ID。
 */
export function createSkillHubProjectPublicationV1(
	dependencies: SkillHubProjectPublicationDependenciesV1,
): SkillHubProjectPublicationPortV1 {
	return {
		async publish(context, projectIdInput, keyInput, input) {
			const request = parseSkillHubRequestV1(context);
			const projectId = parseSkillHubIdV1(projectIdInput);
			const key = parseSkillHubIdempotencyKeyV1(keyInput);
			const command = parseSkillHubProjectPublicationRequestV1(input);
			const check = (candidate: SkillHubProjectPublicationSourceV1) => {
				if (
					candidate.project.projectId !== projectId ||
					candidate.project.ownerId !== request.userId
				)
					throw new SkillHubOperationErrorV1("unavailable");
				if (candidate.project.status !== "active")
					throw new SkillHubOperationErrorV1("forbidden");
				// 内容已在别处修改（或尚未保存）时不发布调用方没有看到的内容。
				if (
					!candidate.content ||
					candidate.revision !== command.contentRevision
				)
					throw new SkillHubOperationErrorV1("version_conflict");
				if (
					command.visibility === "ORGANIZATION" &&
					!candidate.project.organizationId
				)
					invalid();
				// 组织共享须当前主体仍属于项目所属组织；在打包、上传与扫描前拒绝。
				if (
					command.visibility === "ORGANIZATION" &&
					candidate.organizationMember !== true
				)
					throw new SkillHubOperationErrorV1("forbidden");
				return candidate.content;
			};
			// Store 在读取事务内执行同一检查，拒绝随事务写入拒绝审计；返回后再核对一次。
			const source = await dependencies.readSource(request, projectId, check);
			const stored = check(source);
			const content = normalizeSkillHubProjectFilesV1(stored.files);
			if (content.contentDigest !== stored.contentDigest)
				throw new SkillHubOperationErrorV1("unavailable");
			const organizationId =
				command.visibility === "ORGANIZATION"
					? (source.project.organizationId ?? invalid())
					: undefined;
			const archiveBytes = dependencies.pack(content.files);
			return dependencies.admit({
				context: request,
				key,
				selection: Object.freeze({
					name: source.project.name,
					skillId: projectId,
					skillVersionId: `skill-version-${createHash("sha256")
						.update(`project:${projectId}:${request.userId}:${key}`)
						.digest("hex")
						.slice(0, 48)}`,
					visibility: command.visibility,
					provider: "my_library" as const,
					version: command.version,
					...(organizationId ? { organizationId } : {}),
				}),
				source: Object.freeze({
					sourceVersion: skillHubProjectSourceVersionV1(
						projectId,
						source.revision,
					),
					sourceDigest: sha256(archiveBytes),
					approvalRef: null,
				}),
				archiveBytes,
			});
		},
	};
}
