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

export type CapabilityInvocationBody = Readonly<{
	capabilityId: string;
	directoryRevision: string;
	parameters: string;
}>;

/**
 * 提交前校验：Skill 需要用输入框补充目标与范围（与服务端 invalid_parameters 规则一致）；
 * 命令参数固定为空。返回错误文案或可提交的请求体。
 */
export function prepareCapabilityInvocation(
	selected: ConversationCapabilityV1,
	parameterText: string,
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
	return {
		body: {
			capabilityId: selected.identity,
			directoryRevision: selected.directoryRevision,
			parameters,
		},
	};
}
