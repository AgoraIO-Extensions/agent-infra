import {
	ArrowDownToLine,
	ArrowLeft,
	ArrowRight,
	BookOpen,
	Search,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	guideChapter,
	guideChapters,
	guideExcerpt,
	manualUrl,
} from "./user-guide-content";
import "./user-guide.css";

function GuideArticle({ body }: { body: string }) {
	return (
		<div className="guide-prose">
			<Markdown
				remarkPlugins={[remarkGfm]}
				components={{
					a: ({ href, children }) => (
						<a
							href={
								href?.startsWith("../")
									? new URL(
											href,
											"https://github.com/AgoraIO-Extensions/agent-infra/blob/main/docs/guides/",
										).href
									: href
							}
							target="_blank"
							rel="noopener noreferrer"
						>
							{children}
						</a>
					),
					table: ({ children }) => (
						<div className="guide-table">
							<Table>{children}</Table>
						</div>
					),
					thead: ({ children }) => <TableHeader>{children}</TableHeader>,
					tbody: ({ children }) => <TableBody>{children}</TableBody>,
					tr: ({ children }) => <TableRow>{children}</TableRow>,
					th: ({ children }) => <TableHead>{children}</TableHead>,
					td: ({ children }) => <TableCell>{children}</TableCell>,
				}}
			>
				{body}
			</Markdown>
		</div>
	);
}

export function UserGuide({
	chapter,
	onChapterChange,
}: {
	chapter: string;
	onChapterChange: (chapter: string) => void;
}) {
	const [query, setQuery] = useState("");
	const heading = useRef<HTMLHeadingElement>(null);
	const previousChapter = useRef("01");
	const selectedSearchResult = useRef(false);
	const active = guideChapter(chapter);
	const index = guideChapters.indexOf(active);
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const found = guideChapters.filter((item) =>
		`${item.title} ${item.body}`.toLocaleLowerCase().includes(normalizedQuery),
	);
	useEffect(() => {
		if (
			!query &&
			(previousChapter.current !== chapter || selectedSearchResult.current)
		) {
			heading.current?.focus({ preventScroll: true });
			heading.current?.scrollIntoView({ block: "start" });
			previousChapter.current = chapter;
			selectedSearchResult.current = false;
		}
	}, [chapter, query]);
	const choose = (id: string) => {
		selectedSearchResult.current = query.length > 0;
		setQuery("");
		onChapterChange(id);
	};
	return (
		<main className="guide">
			<header className="guide-masthead">
				<div className="guide-wordmark">
					<BookOpen size={18} aria-hidden="true" />
					使用指南<span>THE FIELD GUIDE</span>
				</div>
				<a
					className="guide-download"
					href={manualUrl}
					download="Agent-Infra-使用说明书.md"
				>
					<ArrowDownToLine size={16} aria-hidden="true" />
					完整说明书
				</a>
			</header>
			<section className="guide-intro" aria-labelledby="guide-title">
				<div>
					<p className="guide-eyebrow">AGORA AGENT / KNOWLEDGE & PRACTICE</p>
					<h1 id="guide-title">
						从第一次对话，
						<br />
						到团队协作。
					</h1>
					<p>
						一份可以随时查阅的工作指南。
						<br />
						理解入口，完成任务，确认每一步的实际结果。
					</p>
				</div>
				<div className="guide-intro-side">
					<span className="guide-volume">01—{guideChapters.length}</span>
					<p>
						员工 · Owner · 系统管理员
						<br />
						Agent 平台 & 独立 Connection
					</p>
					<Badge variant="outline">按当前部署的实际可用能力操作</Badge>
				</div>
			</section>
			<div className="guide-search">
				<Search size={18} aria-hidden="true" />
				<Input
					aria-label="搜索使用说明"
					placeholder="搜索步骤、权限或问题，例如：Relay Key"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
				{query ? (
					<Button variant="ghost" onClick={() => setQuery("")}>
						清空搜索
					</Button>
				) : (
					<span>{guideChapters.length} 个章节</span>
				)}
			</div>
			{normalizedQuery ? (
				<section className="guide-results" aria-label="搜索结果">
					<p role="status">找到 {found.length} 个章节</p>
					{found.map((item) => (
						<Button
							key={item.id}
							variant="ghost"
							onClick={() => choose(item.id)}
						>
							<span>{item.id}</span>
							<span className="guide-result-copy">
								<strong>{item.title}</strong>
								<span>{guideExcerpt(item.body, query)}</span>
							</span>
							<ArrowRight aria-hidden="true" />
						</Button>
					))}
					{found.length === 0 && <p>换一个关键词，或清空搜索浏览全部章节。</p>}
				</section>
			) : (
				<div className="guide-reading">
					<aside>
						<p className="guide-eyebrow">目录 / CONTENTS</p>
						<nav aria-label="手册章节" className="guide-contents">
							{guideChapters.map((item) => (
								<Button
									key={item.id}
									variant="ghost"
									aria-current={active.id === item.id ? "page" : undefined}
									onClick={() => choose(item.id)}
								>
									<span>{item.id}</span>
									{item.title}
								</Button>
							))}
						</nav>
					</aside>
					<article
						className="guide-article"
						aria-labelledby="guide-chapter-title"
					>
						<header>
							<p className="guide-eyebrow">USER MANUAL / {active.id}</p>
							<h2 id="guide-chapter-title" ref={heading} tabIndex={-1}>
								{active.title}
							</h2>
							<p className="guide-subtitle">
								操作步骤、完成标志与权限边界，都在这一节。
							</p>
						</header>
						<GuideArticle body={active.body} />
						<footer className="guide-article-footer">
							<Button
								variant="ghost"
								disabled={index === 0}
								onClick={() => choose(guideChapters[index - 1].id)}
							>
								<ArrowLeft aria-hidden="true" />
								上一节
							</Button>
							<span>
								{index + 1} / {guideChapters.length}
							</span>
							<Button
								variant="ghost"
								disabled={index === guideChapters.length - 1}
								onClick={() => choose(guideChapters[index + 1].id)}
							>
								下一节
								<ArrowRight aria-hidden="true" />
							</Button>
						</footer>
					</article>
				</div>
			)}
			<footer className="guide-colophon">
				<span>AGORA AGENT · 使用指南</span>
				<span>以实际就绪状态、权限与验证结果为准</span>
			</footer>
		</main>
	);
}
