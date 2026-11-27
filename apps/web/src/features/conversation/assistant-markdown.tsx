import { createContext, useContext } from "react";
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

export const ConnectionEntryContext = createContext<string | undefined>(
	undefined,
);

const connectionUuid =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The Connection website interprets these public references when showing its consent form. */
function hasPublicConnectionReferences(url: URL, entry: string | undefined) {
	if (!entry || url.origin + url.pathname !== entry || url.hash) return false;
	const params = url.searchParams;
	const provider = params.get("provider") ?? "";
	const consumer = params.get("consumerId") ?? "";
	const action = params.get("actionVersionId");
	const account = params.get("connectionId");
	if (
		(params.get("intent") !== "authorize" &&
			params.get("intent") !== "permissions") ||
		!/^[a-z][a-z0-9-]{0,63}$/.test(provider) ||
		!consumer.startsWith("agent-") ||
		!connectionUuid.test(consumer.slice("agent-".length))
	)
		return false;
	if (
		action !== null &&
		(!action.startsWith(`${provider}.`) ||
			!/^[a-z][a-z0-9_.-]*@v[1-9][0-9]*$/.test(
				action.slice(provider.length + 1),
			) ||
			action.length > 160)
	)
		return false;
	if (
		account !== null &&
		(!account.startsWith("connection-") ||
			!connectionUuid.test(account.slice("connection-".length)))
	)
		return false;
	// Every required field was found. Extra or repeated parameters invalidate the exception.
	return params.size === 3 + Number(action !== null) + Number(account !== null);
}

function safeExternalUrl(
	href: string | undefined,
	connectionEntry: string | undefined,
) {
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
		for (const [key, value] of url.searchParams) {
			if (
				/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/.test(
					value,
				) ||
				(/^(?:Bearer\s+)?[A-Za-z0-9_-]{32,}$/.test(value) &&
					!(
						(key === "consumerId" || key === "connectionId") &&
						hasPublicConnectionReferences(url, connectionEntry)
					))
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
	a: function AssistantLink({ node, href, children }) {
		const connectionEntry = useContext(ConnectionEntryContext);
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
		const safeHref = safeExternalUrl(href, connectionEntry);
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
