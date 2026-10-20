import { skillControlFileLimitV1 } from "./conversation-skill-control-file-model.js";

export type ConversationCapabilityV1 = Readonly<{
	kind: "command" | "skill";
	name: string;
	description: string;
	source: string;
	version?: string;
	/** Stable service-provided identity used to invalidate replaced metadata. */
	identity?: string;
	directoryRevision?: string;
}>;

const maximumCapabilities = 150;
const maximumQueryBytes = 512;
const maximumParameterBytes = 4096;
const maximumControlFiles = skillControlFileLimitV1.maxFiles;

function bounded(value: string, maximum: number) {
	return (
		value.isWellFormed() &&
		new TextEncoder().encode(value).byteLength <= maximum
	);
}

/** 草稿以 / 开头时，「/」之后的全部文本是目录搜索词；否则不是命令查询。 */
export function capabilityQuery(draft: string): string | undefined {
	return draft.startsWith("/") ? draft.slice(1) : undefined;
}

export function filterConversationCapabilities(
	capabilities: readonly ConversationCapabilityV1[],
	query: string,
) {
	if (
		capabilities.length > maximumCapabilities ||
		!bounded(query, maximumQueryBytes)
	)
		return [] as readonly ConversationCapabilityV1[];
	const normalized = query.trim().replace(/^\/+/, "").toLocaleLowerCase();
	return capabilities.filter((capability) => {
		const haystack =
			`${capability.name} ${capability.description} ${capability.source}`.toLocaleLowerCase();
		return normalized.length === 0 || haystack.includes(normalized);
	});
}

/** ↑↓ 在首尾停住，不循环（设计 skill-interactions）。 */
export function moveCapabilityIndex(
	index: number,
	delta: -1 | 1,
	length: number,
) {
	if (length === 0) return 0;
	return Math.min(length - 1, Math.max(0, index + delta));
}

export function sameCapability(
	left: ConversationCapabilityV1,
	right: ConversationCapabilityV1,
) {
	return (
		left.kind === right.kind &&
		left.name === right.name &&
		left.source === right.source &&
		left.version === right.version &&
		left.identity === right.identity &&
		left.directoryRevision === right.directoryRevision
	);
}

/** Invocation V1：命令与不带控制文件的 Skill 使用的既有请求体，字段保持原样。 */
export type CapabilityInvocationBodyV1 = Readonly<{
	capabilityId: string;
	directoryRevision: string;
	parameters: string;
}>;

/** Invocation V2：仅 Skill 可选，按选择顺序携带已上传的 text/plain 文件 id。 */
export type CapabilityInvocationBodyV2 = Readonly<{
	capabilityId: string;
	directoryRevision: string;
	parameters: string;
	schemaVersion: 2;
	attachments: readonly string[];
}>;

export type CapabilityInvocationBody =
	| CapabilityInvocationBodyV1
	| CapabilityInvocationBodyV2;

/**
 * 提交前校验：Skill 需要用输入框补充目标与范围（与服务端 invalid_parameters 规则一致）；
 * 命令参数固定为空。带控制文件时升级为 Invocation V2；没有文件时保持 V1 请求体不变。
 * 命令不接受控制文件，页面也不会为命令提供上传入口。
 */
export function prepareCapabilityInvocation(
	selected: ConversationCapabilityV1,
	parameterText: string,
	controlFileIds: readonly string[] = [],
): { error: string } | { body: CapabilityInvocationBody } {
	if (!selected.identity || !selected.directoryRevision)
		return { error: "所选版本已失效，请重新选择；不会作为普通消息发送。" };
	if (selected.kind === "skill" && parameterText.trim() === "")
		return { error: "请在输入框补充这次任务的目标与范围。" };
	// 只读命令没有参数：输入框里有内容时不静默丢弃，请用户先清空。
	if (selected.kind === "command" && parameterText.trim() !== "")
		return { error: "这项只读命令不需要额外参数，请清空输入框后再发送。" };
	const parameters = selected.kind === "command" ? "" : parameterText;
	if (!bounded(parameters, maximumParameterBytes))
		return { error: "补充内容过长，请缩短后再发送。" };
	const body: CapabilityInvocationBodyV1 = {
		capabilityId: selected.identity,
		directoryRevision: selected.directoryRevision,
		parameters,
	};
	if (controlFileIds.length === 0) return { body };
	if (selected.kind === "command") return { error: "只读命令不接受控制文件。" };
	if (controlFileIds.length > maximumControlFiles)
		return { error: `最多只能附加 ${maximumControlFiles} 个控制文件。` };
	if (
		controlFileIds.some((fileId) => fileId.trim() === "") ||
		new Set(controlFileIds).size !== controlFileIds.length
	)
		return { error: "控制文件无效，请重新上传后再发送。" };
	return {
		body: { ...body, schemaVersion: 2, attachments: [...controlFileIds] },
	};
}
