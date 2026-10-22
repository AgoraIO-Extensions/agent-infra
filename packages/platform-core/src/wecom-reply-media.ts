import type { WecomResultFileReferenceV1 } from "./wecom-channel.js";

/**
 * #3229：企微回复中的结果文件（工程 Spec §14.2.3「长连接出站」「不支持媒体的模式」）。
 *
 * Core 在组装回复时决定每个结果文件是否随本次回复发送，并把回答中的 `sandbox:` 链接和图片改写为
 * 文件名与说明；持久事件不变。字节只在 Worker 中读取，Core 只处理文件元数据。
 */

/** 智能机器人长连接被动回复的媒体消息类型。 */
export type WecomOutboundMediaKindV1 = "image" | "video" | "file";
/** 一个将随本次回复发送的结果文件。 */
export interface WecomOutboundMediaV1 extends WecomResultFileReferenceV1 {
	readonly kind: WecomOutboundMediaKindV1;
}
/**
 * sender 对候选文件的规划：`send` 表示会发送并已占用频率额度；其余是不发送的原因。
 * - `unsupported_type`：类型不在该企微 Channel 当前的 FileLimits 内；
 * - `exceeds_limit`：超过 FileLimits 的大小上限；
 * - `rate_limited`：超出企微每会话或每机器人的频率限制。
 */
export type WecomOutboundMediaPlanV1 =
	| "send"
	| "unsupported_type"
	| "exceeds_limit"
	| "rate_limited";
/** 结果文件不随本次回复发送的原因；`unsupported_channel` 指当前回复方式不支持媒体。 */
export type WecomOutboundMediaSkipReasonV1 =
	| Exclude<WecomOutboundMediaPlanV1, "send">
	| "unsupported_channel";
/** 单个媒体的发送进度，按文件持久记录（工程 Spec §14.2.3）。 */
export type WecomMediaProgressStatusV1 = "sending" | "sent" | "failed" | "unknown";

/**
 * 回答中按 CommonMark 解析出的一处 `sandbox:` 引用（与 Runtime 的解析一致：代码、原始 HTML、
 * 普通相对链接和裸路径都不是引用）。偏移是回答字符串的 UTF-16 下标，左闭右开。
 */
export interface WecomAnswerReferenceV1 {
	readonly start: number;
	readonly end: number;
	/** `definition` 是引用式定义，改写时整段去掉；其余是链接或图片（含引用式）。 */
	readonly kind: "link" | "image" | "definition";
	/** 规范化的工作区引用；无效引用（越界、NUL、反斜杠等）为 null。 */
	readonly workspaceReference: string | null;
	/** 链接文字或图片说明，只在无效引用的改写中显示。 */
	readonly label: string;
}
/** 由企微 Adapter 提供的 CommonMark 解析；Core 不依赖 Markdown 解析库。 */
export type WecomAnswerReferenceParserV1 = (
	markdown: string,
) => readonly WecomAnswerReferenceV1[];

/** 每次回复最多发送的媒体数（ADR-0032 决策 6）。 */
export const wecomReplyMediaMaxCountV1 = 10;
const mebibyte = 1024 * 1024;
const imageMediaTypes = new Set(["image/png", "image/jpeg", "image/gif"]);

/**
 * 按企微官方限额映射媒体消息类型（WECOM-text-deployment.md「媒体」）：png、jpeg、gif 且不超过
 * 10MB 为图片，mp4 且不超过 10MB 为视频，其他文件不超过 20MB 为文件；小于 5 字节或超过上限的
 * 不发送（返回 null）。超过 10MB 的图片和视频按普通文件发送。
 */
export function wecomOutboundMediaKindV1(
	file: Pick<WecomResultFileReferenceV1, "mediaType" | "sizeBytes">,
): WecomOutboundMediaKindV1 | null {
	if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 5) return null;
	if (imageMediaTypes.has(file.mediaType) && file.sizeBytes <= 10 * mebibyte)
		return "image";
	if (file.mediaType === "video/mp4" && file.sizeBytes <= 10 * mebibyte)
		return "video";
	return file.sizeBytes <= 20 * mebibyte ? "file" : null;
}

const skipNotes: Readonly<Record<WecomOutboundMediaSkipReasonV1, string>> = {
	unsupported_channel: "当前渠道不支持发送文件",
	unsupported_type: "类型不支持，未发送",
	exceeds_limit: "超出企微限制，未发送",
	rate_limited: "超出企微发送频率限制，未发送",
};
const sendNote = "见下方文件";
const unpublishedNote = "未发布";

/** 校验解析结果：区间在回答之内、类型与字段合法；不合法时抛错，调用方不发送。 */
export function parseWecomAnswerReferencesV1(
	answer: string,
	parse: WecomAnswerReferenceParserV1,
): readonly WecomAnswerReferenceV1[] {
	const references = parse(answer);
	if (!Array.isArray(references) || references.length > 10_000)
		throw new Error("Invalid WeCom answer references");
	for (const reference of references)
		if (
			!reference ||
			!Number.isSafeInteger(reference.start) ||
			!Number.isSafeInteger(reference.end) ||
			reference.start < 0 ||
			reference.end <= reference.start ||
			reference.end > answer.length ||
			!["link", "image", "definition"].includes(reference.kind) ||
			(reference.workspaceReference !== null &&
				(typeof reference.workspaceReference !== "string" ||
					!reference.workspaceReference)) ||
			typeof reference.label !== "string"
		)
			throw new Error("Invalid WeCom answer references");
	// 按位置排序；同一起点时外层（更长的）在前，嵌套在已改写区间内的引用不再单独改写。
	return [...references].sort(
		(left, right) => left.start - right.start || right.end - left.end,
	);
}

/**
 * 发送顺序：回答中引用的文件按首次出现的顺序在前（与 Runtime 发布顺序一致），没有出现在回答中的
 * 文件（ACP image 块、resource_link）按事件顺序排在后面。
 */
export function orderWecomResultFilesV1(
	files: readonly WecomResultFileReferenceV1[],
	references: readonly WecomAnswerReferenceV1[],
): readonly WecomResultFileReferenceV1[] {
	const position = new Map<string, number>();
	for (const reference of references)
		if (
			reference.kind !== "definition" &&
			reference.workspaceReference !== null &&
			!position.has(reference.workspaceReference)
		)
			position.set(reference.workspaceReference, position.size);
	const rank = (file: WecomResultFileReferenceV1) =>
		file.workspaceReference === null
			? Number.POSITIVE_INFINITY
			: (position.get(file.workspaceReference) ?? Number.POSITIVE_INFINITY);
	return files
		.map((file, index) => ({ file, index }))
		.sort(
			(left, right) =>
				rank(left.file) - rank(right.file) || left.index - right.index,
		)
		.map(({ file }) => file);
}

function basename(reference: string) {
	return reference.split("/").at(-1) ?? reference;
}

/**
 * 把回答中的 `sandbox:` 链接和图片改写为文件名与说明，去掉 `sandbox:` 引用式定义；没有出现在
 * 回答中的结果文件逐行附在末尾，不静默丢弃。`skipped` 中没有的文件会随本次回复发送。
 */
export function rewriteWecomAnswerV1(input: {
	readonly answer: string;
	readonly references: readonly WecomAnswerReferenceV1[];
	readonly files: readonly WecomResultFileReferenceV1[];
	readonly skipped: ReadonlyMap<string, WecomOutboundMediaSkipReasonV1>;
}): string {
	const byReference = new Map<string, WecomResultFileReferenceV1>();
	for (const file of input.files)
		if (
			file.workspaceReference !== null &&
			!byReference.has(file.workspaceReference)
		)
			byReference.set(file.workspaceReference, file);
	const describe = (file: WecomResultFileReferenceV1) => {
		const reason = input.skipped.get(file.fileId);
		return `${file.name}（${reason ? skipNotes[reason] : sendNote}）`;
	};
	const mentioned = new Set<string>();
	let text = "";
	let cursor = 0;
	for (const reference of input.references) {
		if (reference.start < cursor) continue;
		text += input.answer.slice(cursor, reference.start);
		cursor = reference.end;
		if (reference.kind === "definition") {
			// 引用式定义独占一行时连同换行一起去掉。
			if (input.answer.startsWith("\r\n", cursor)) cursor += 2;
			else if (input.answer[cursor] === "\n") cursor += 1;
			continue;
		}
		const file =
			reference.workspaceReference === null
				? undefined
				: byReference.get(reference.workspaceReference);
		if (file) {
			mentioned.add(file.fileId);
			text += describe(file);
		} else
			text += `${
				reference.workspaceReference === null
					? reference.label.trim() || "文件"
					: basename(reference.workspaceReference)
			}（${unpublishedNote}）`;
	}
	text += input.answer.slice(cursor);
	const rest = input.files
		.filter((file) => !mentioned.has(file.fileId))
		.map(describe);
	if (rest.length === 0) return text;
	return text.trim() ? `${text}\n\n${rest.join("\n")}` : rest.join("\n");
}
