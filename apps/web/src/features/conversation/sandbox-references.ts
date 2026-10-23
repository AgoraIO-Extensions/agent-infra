import { parseSandboxReferenceUrlV1 } from "@agent-infra/contracts/files";
import type { ResultFile } from "./conversation-files.js";
import type { ConversationTimelineEventV2 } from "./conversation-timeline.js";

/**
 * #3228：回答内 `sandbox:` 引用与同一执行结果文件的对应（ADR-0032 决策 4，工程 Spec §15.4.3、
 * §15.4.4）。引用的规范化与 Runtime 发布时共用 contracts 的 `parseSandboxReferenceUrlV1`；
 * Web 只按 `result.file` V2 的 `workspaceReference` 精确匹配，不推测、不加载其他 URL。
 */

/** 同一执行中已确认的结果文件：按 fileId 去重，保持事件顺序。 */
export function executionResultFiles(
	events: readonly ConversationTimelineEventV2[],
	executionId: string,
): ResultFile[] {
	const files = new Map<string, ResultFile>();
	for (const event of events) {
		if (
			event.type !== "result.file" ||
			event.executionId !== executionId ||
			files.has(event.payload.fileId)
		)
			continue;
		files.set(event.payload.fileId, {
			...event.payload,
			executionId: event.executionId,
		});
	}
	return [...files.values()];
}

/**
 * 规范化 `workspaceReference` → 结果文件。值由 Runtime 规范化并经 Worker 与 File 记录核对后
 * 持久化，这里原样作为键；V1 事件与 null（例如 ACP image 块）不参与对应。同一路径只取第一个。
 */
export function sandboxReferenceIndex(
	files: readonly ResultFile[],
): ReadonlyMap<string, ResultFile> {
	const index = new Map<string, ResultFile>();
	for (const file of files) {
		const reference = file.workspaceReference;
		if (reference && !index.has(reference)) index.set(reference, file);
	}
	return index;
}

/** Markdown 渲染时附在 `a`/`img` 元素上的引用标注（hast 属性名）。 */
export const sandboxReferenceProperty = "dataSandboxReference";
export const sandboxRepeatProperty = "dataSandboxRepeat";
export const sandboxNestedProperty = "dataSandboxNested";

type HastNode = {
	type: string;
	tagName?: string;
	value?: string;
	properties?: Record<string, unknown>;
	children?: HastNode[];
};

/**
 * rehype 插件：按文档顺序标注 URL 以 `sandbox:` 开头的链接与图片（含引用式定义解析后的元素）。
 *
 * - `dataSandboxReference`：规范化路径；无效引用为空字符串。
 * - `dataSandboxRepeat`：同一引用的第二次及之后出现，只显示说明文字，不重复渲染图片、文件卡
 *   或「未发送」占位。
 * - `dataSandboxNested`：位于链接内的图片，只显示、不作为按钮，避免交互元素嵌套。
 *
 * 代码块与行内代码在 hast 中只是文本，不会被标注；标注发生在 urlTransform 之前，组件不会把
 * `sandbox:` URL 写进 DOM。
 */
export function rehypeSandboxReferences() {
	return (tree: HastNode) => {
		const seen = new Set<string>();
		const visit = (node: HastNode, insideLink: boolean) => {
			if (node.type === "element" && node.properties) {
				const url =
					node.tagName === "a"
						? node.properties.href
						: node.tagName === "img"
							? node.properties.src
							: undefined;
				if (typeof url === "string") {
					const parsed = parseSandboxReferenceUrlV1(url);
					if (parsed.kind !== "none") {
						const reference =
							parsed.kind === "reference" ? parsed.workspaceReference : "";
						const key = reference || `invalid:${url}`;
						node.properties[sandboxReferenceProperty] = reference;
						if (seen.has(key)) node.properties[sandboxRepeatProperty] = "true";
						else seen.add(key);
						if (node.tagName === "img" && insideLink)
							node.properties[sandboxNestedProperty] = "true";
					}
				}
			}
			const nested = insideLink || node.tagName === "a";
			for (const child of node.children ?? []) visit(child, nested);
		};
		visit(tree, false);
	};
}

/** hast 节点的纯文本（文件卡判断说明文字是否与文件名相同）。 */
export function hastText(node: HastNode | undefined): string {
	if (!node) return "";
	if (node.type === "text") return node.value ?? "";
	return (node.children ?? []).map(hastText).join("");
}
