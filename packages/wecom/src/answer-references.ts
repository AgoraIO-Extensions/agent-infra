import { parseSandboxReferenceUrlV1 } from "@agent-infra/contracts/files";
import type { WecomAnswerReferenceV1 } from "@agent-infra/platform-core";
import { fromMarkdown } from "mdast-util-from-markdown";

interface MarkdownNode {
	readonly type: string;
	readonly url?: string;
	readonly identifier?: string;
	readonly alt?: string | null;
	readonly value?: string;
	readonly children?: readonly MarkdownNode[];
	readonly position?: {
		readonly start: { readonly offset?: number };
		readonly end: { readonly offset?: number };
	};
}

function label(node: MarkdownNode): string {
	if (node.type === "image" || node.type === "imageReference")
		return node.alt ?? "";
	if (node.type === "text" || node.type === "inlineCode")
		return node.value ?? "";
	return (node.children ?? []).map(label).join("");
}

/**
 * #3229：按 CommonMark 找出最终回答中的 `sandbox:` 链接、图片（含引用式）与引用式定义，供 Core
 * 改写回复文本（工程 Spec §14.2.3）。解析与 Runtime 发布引用使用同一版本的解析器、同一套规则与
 * 契约中的路径规范化：代码块、行内代码、原始 HTML、普通相对链接和裸路径都不是引用；同一标签的
 * 第一个定义生效。按文档顺序返回，偏移是回答字符串的 UTF-16 下标。
 */
export function parseWecomAnswerReferencesV1(
	markdown: string,
): WecomAnswerReferenceV1[] {
	if (!markdown) return [];
	const root = fromMarkdown(markdown) as unknown as MarkdownNode;
	const definitions = new Map<string, string>();
	const collect = (node: MarkdownNode) => {
		if (
			node.type === "definition" &&
			node.identifier !== undefined &&
			node.url !== undefined &&
			!definitions.has(node.identifier)
		)
			definitions.set(node.identifier, node.url);
		for (const child of node.children ?? []) collect(child);
	};
	collect(root);
	const found: WecomAnswerReferenceV1[] = [];
	const visit = (node: MarkdownNode) => {
		const url =
			node.type === "link" ||
			node.type === "image" ||
			node.type === "definition"
				? node.url
				: (node.type === "linkReference" || node.type === "imageReference") &&
						node.identifier !== undefined
					? definitions.get(node.identifier)
					: undefined;
		if (url !== undefined) {
			const parsed = parseSandboxReferenceUrlV1(url);
			if (parsed.kind !== "none") {
				const start = node.position?.start.offset;
				const end = node.position?.end.offset;
				if (start === undefined || end === undefined)
					throw new Error("WeCom answer reference has no position");
				found.push({
					start,
					end,
					kind:
						node.type === "definition"
							? "definition"
							: node.type === "image" || node.type === "imageReference"
								? "image"
								: "link",
					workspaceReference:
						parsed.kind === "reference" ? parsed.workspaceReference : null,
					label: node.type === "definition" ? "" : label(node),
				});
			}
		}
		for (const child of node.children ?? []) visit(child);
	};
	visit(root);
	return found;
}
