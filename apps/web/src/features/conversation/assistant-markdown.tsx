import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	SandboxImageReference,
	SandboxLinkReference,
	type SandboxReferences,
	SandboxReferencesContext,
} from "./sandbox-reference-views.js";
import {
	hastText,
	rehypeSandboxReferences,
	sandboxNestedProperty,
	sandboxReferenceProperty,
	sandboxRepeatProperty,
} from "./sandbox-references.js";

function safeExternalUrl(href: string | undefined) {
	if (!href) return undefined;
	try {
		const url = new URL(href);
		if (url.protocol !== "https:" || url.username || url.password)
			return undefined;
		const fragment = decodeURIComponent(url.hash.slice(1));
		if (
			/(?:access[_-]?token|refresh[_-]?token|id[_-]?token|bearer|password|secret|api[_-]?key|signature|sig)\s*=/i.test(
				fragment,
			) ||
			/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/.test(
				fragment,
			)
		)
			return undefined;
		// Normal documentation links often use query parameters and fragments. Keep
		// those, while refusing the parameter names most commonly used to carry
		// bearer credentials or one-time authorization material.
		for (const key of url.searchParams.keys()) {
			if (
				/(?:token|secret|password|passwd|api[_-]?key|access[_-]?token|auth|signature|sig|code)/i.test(
					key,
				)
			)
				return undefined;
		}
		for (const value of url.searchParams.values()) {
			if (
				/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/.test(
					value,
				) ||
				/^(?:Bearer\s+)?[A-Za-z0-9_-]{32,}$/.test(value)
			)
				return undefined;
		}
		return url.href;
	} catch {
		return undefined;
	}
}

/** 组件表保持稳定引用：内联图片的读取状态不因回答重新渲染而重建。 */
const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeSandboxReferences];

function sandboxMarks(
	node: { properties?: Record<string, unknown> } | undefined,
) {
	const reference = node?.properties?.[sandboxReferenceProperty];
	if (typeof reference !== "string") return undefined;
	return {
		reference,
		repeat: node?.properties?.[sandboxRepeatProperty] === "true",
		nested: node?.properties?.[sandboxNestedProperty] === "true",
	};
}

const components: Components = {
	a: ({ node, href, children }) => {
		const sandbox = sandboxMarks(node);
		if (sandbox)
			return (
				<SandboxLinkReference
					reference={sandbox.reference}
					text={hastText(node)}
					repeat={sandbox.repeat}
				>
					{children}
				</SandboxLinkReference>
			);
		const safeHref = safeExternalUrl(href);
		return safeHref ? (
			<a href={safeHref} target="_blank" rel="noopener noreferrer">
				{children}
			</a>
		) : (
			<span>{children}</span>
		);
	},
	// 模型给出的图片 URL 不进入浏览器加载路径；唯一例外是命中同一执行结果文件的 `sandbox:`
	// 引用，经当前 File Grant 读取内存 Blob 后显示（工程 Spec §15.4.3）。
	img: ({ node, alt }) => {
		const sandbox = sandboxMarks(node);
		return sandbox ? (
			<SandboxImageReference
				reference={sandbox.reference}
				alt={alt}
				repeat={sandbox.repeat}
				nested={sandbox.nested}
			/>
		) : (
			<span>[图片：{alt || "未提供说明"}]</span>
		);
	},
	pre: ({ children }) => (
		// biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable code must be reachable by keyboard.
		<section className="markdown-code" tabIndex={0} aria-label="代码块">
			<pre>{children}</pre>
		</section>
	),
	table: ({ children }) => (
		// biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable tables must be reachable by keyboard.
		<section className="markdown-table" tabIndex={0} aria-label="表格">
			<Table>{children}</Table>
		</section>
	),
	thead: ({ children }) => <TableHeader>{children}</TableHeader>,
	tbody: ({ children }) => <TableBody>{children}</TableBody>,
	tr: ({ children }) => <TableRow>{children}</TableRow>,
	th: ({ style, children }) => <TableHead style={style}>{children}</TableHead>,
	td: ({ style, children }) => <TableCell style={style}>{children}</TableCell>,
};

/** Model output is untrusted text, including links and image destinations. */
export function AssistantMarkdown({
	children,
	references,
}: {
	children: string;
	/** #3228：同一执行的结果文件映射；缺省时所有 `sandbox:` 引用都按未发送显示。 */
	references?: SandboxReferences;
}) {
	const markdown = (
		<div className="assistant-markdown min-w-0 max-w-full">
			<Markdown
				remarkPlugins={remarkPlugins}
				rehypePlugins={rehypePlugins}
				components={components}
			>
				{children}
			</Markdown>
		</div>
	);
	return references ? (
		<SandboxReferencesContext.Provider value={references}>
			{markdown}
		</SandboxReferencesContext.Provider>
	) : (
		markdown
	);
}
