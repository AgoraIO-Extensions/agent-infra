import type { AgentManagementActorContextV1 } from "./agent-management.js";
import type { SkillHubVersionV1 } from "./skill-hub.js";
import {
	canViewSkillHubVersionV1,
	type SkillHubInstallationV1,
} from "./skill-hub-installation.js";
import {
	parseSkillHubIdV1,
	SkillHubOperationErrorV1,
} from "./skill-hub-management.js";

/** SKILL.md 正文返回的 UTF-8 字节上限，与契约 skillHubVersionBodyMaxBytesV1 一致。 */
const skillHubVersionBodyMaxBytesV1 = 65_536;

type NamedVersion = SkillHubVersionV1 & { readonly name: string };

/**
 * 版本详情与本人版本目录的可见性：已发布版本沿用发布范围（canView）；
 * 发布者本人还能回读自己审核中、已驳回和已撤销的版本。安装、绑定与审核仍只认 canView。
 */
export function canViewSkillHubVersionDetailV1(
	version: SkillHubVersionV1,
	actor: AgentManagementActorContextV1,
	organizationId: string | null = null,
	parentStatus = "active",
): boolean {
	if (canViewSkillHubVersionV1(version, actor, organizationId, parentStatus))
		return true;
	return (
		actor.accountStatus === "active" &&
		parentStatus === "active" &&
		version.ownerId === actor.userId
	);
}

/** 本人版本目录的一页查询；游标是上一页最后一个版本 ID。 */
export type SkillHubOwnedVersionQueryV1 = Readonly<{
	cursor?: string;
	limit: number;
}>;

export function parseSkillHubOwnedVersionQueryV1(query: {
	readonly cursor?: unknown;
	readonly limit?: unknown;
}): SkillHubOwnedVersionQueryV1 {
	const limit = query.limit ?? 50;
	if (
		typeof limit !== "number" ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 100
	)
		throw new SkillHubOperationErrorV1("invalid_input");
	return Object.freeze({
		limit,
		...(query.cursor === undefined
			? {}
			: { cursor: parseSkillHubIdV1(query.cursor) }),
	});
}

function metadata(version: NamedVersion) {
	return {
		schemaVersion: version.schemaVersion,
		skillId: version.skillId,
		skillVersionId: version.skillVersionId,
		name: version.name,
		visibility: version.visibility,
		provider: version.provider,
		version: version.version,
		packageDigest: version.packageDigest,
		manifestDigest: version.manifestDigest,
		signatureDigest: version.signatureDigest,
		state: version.state,
	};
}

/** 只投影请求者本人的版本；混入他人版本时按依赖不可用失败关闭。 */
export function pageSkillHubOwnedVersionsV1(
	page: {
		readonly versions: readonly NamedVersion[];
		readonly nextCursor: string | null;
	},
	ownerId: string,
) {
	return {
		items: page.versions.map((version) => {
			if (version.ownerId !== ownerId)
				throw new SkillHubOperationErrorV1("unavailable");
			return metadata(version);
		}),
		nextCursor: page.nextCursor,
	};
}

export type SkillHubVersionResourceKindV1 =
	| "script"
	| "reference"
	| "asset"
	| "file";

export type SkillHubVersionContentV1 =
	| Readonly<{
			state: "available";
			body: string;
			bodyTruncated: boolean;
			resources: readonly Readonly<{
				path: string;
				kind: SkillHubVersionResourceKindV1;
				sizeBytes: number;
			}>[];
	  }>
	| Readonly<{ state: "unavailable" }>;

function resourceKind(path: string): SkillHubVersionResourceKindV1 {
	if (path.startsWith("scripts/")) return "script";
	if (path.startsWith("references/")) return "reference";
	if (path.startsWith("assets/")) return "asset";
	return "file";
}

/**
 * 由已核对摘要的包内容构造详情内容：SKILL.md 截到字节上限且不切断 UTF-8 字符，
 * 其余文件只给路径、类别与大小，不带内容。
 */
export function projectSkillHubVersionContentV1(input: {
	readonly entry: Uint8Array;
	readonly files: readonly Readonly<{ path: string; sizeBytes: number }>[];
}): SkillHubVersionContentV1 {
	let end = Math.min(input.entry.byteLength, skillHubVersionBodyMaxBytesV1);
	// 截断点落在多字节字符中间时退到该字符起点（UTF-8 续字节为 10xxxxxx）。
	for (
		let step = 0;
		end < input.entry.byteLength &&
		step < 3 &&
		((input.entry[end] ?? 0) & 0xc0) === 0x80;
		step++
	)
		end--;
	return Object.freeze({
		state: "available",
		body: new TextDecoder().decode(input.entry.subarray(0, end)),
		bodyTruncated: end < input.entry.byteLength,
		resources: Object.freeze(
			input.files
				.filter((file) => file.path !== "SKILL.md")
				.map((file) =>
					Object.freeze({
						path: file.path,
						kind: resourceKind(file.path),
						sizeBytes: file.sizeBytes,
					}),
				),
		),
	});
}

/** 详情只反映当前用户本人的安装；未安装、已移除或失败都按未在我的库处理。 */
export function projectSkillHubVersionDetailV1(input: {
	readonly version: NamedVersion;
	readonly installation: SkillHubInstallationV1 | null;
	readonly content: SkillHubVersionContentV1;
}) {
	return {
		...metadata(input.version),
		ownerId: input.version.ownerId,
		installation:
			input.installation?.state === "installed"
				? {
						state: "installed" as const,
						installationId: input.installation.installationId,
					}
				: { state: "not_installed" as const },
		content: input.content,
	};
}
