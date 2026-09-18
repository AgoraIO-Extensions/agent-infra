import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

function safeExternalUrl(href: string | undefined) {
	if (!href) return undefined;
	try {
		const url = new URL(href);
		return url.protocol === "https:" && !url.username && !url.password
			? url.href
			: undefined;
	} catch {
		return undefined;
	}
}

/** Model output is untrusted text, including links and image destinations. */
export function AssistantMarkdown({ children }: { children: string }) {
	return (
		<div className="assistant-markdown min-w-0 max-w-full">
			<Markdown
				remarkPlugins={[remarkGfm]}
				components={{
					a: ({ href, children }) => {
						const safeHref = safeExternalUrl(href);
						return safeHref ? (
							<a href={safeHref} target="_blank" rel="noopener noreferrer">
								{children}
							</a>
						) : (
							<span>{children}</span>
						);
					},
					// Text-only Pilot: do not fetch model-supplied image URLs.
					img: ({ alt }) => <span>[图片：{alt || "未提供说明"}]</span>,
					pre: ({ children }) => (
						// biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable code must be reachable by keyboard.
						<section className="markdown-code" tabIndex={0} aria-label="代码块">
							<pre>{children}</pre>
						</section>
					),
					table: ({ children }) => (
						// biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable tables must be reachable by keyboard.
						<section className="markdown-table" tabIndex={0} aria-label="表格">
							<table>{children}</table>
						</section>
					),
				}}
			>
				{children}
			</Markdown>
		</div>
	);
}
