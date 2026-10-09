import { Link } from "@tanstack/react-router";
import {
	ArrowDownToLine,
	ArrowLeft,
	ArrowRight,
	BookOpen,
	Search,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { guideChapter, guideChapters, guideText } from "./content";
import "./guide.css";

export function ConnectionGuide({
	chapter,
	onChapterChange,
}: {
	chapter: string;
	onChapterChange: (id: string) => void;
}) {
	const [query, setQuery] = useState("");
	const heading = useRef<HTMLHeadingElement>(null);
	const previous = useRef("01");
	const selectedResult = useRef(false);
	const active = guideChapter(chapter);
	const index = guideChapters.indexOf(active);
	const term = query.trim().toLocaleLowerCase();
	const found = guideChapters.filter((item) =>
		guideText(item).toLocaleLowerCase().includes(term),
	);
	useEffect(() => {
		if (!query && (previous.current !== chapter || selectedResult.current)) {
			heading.current?.focus({ preventScroll: true });
			heading.current?.scrollIntoView({ block: "start" });
			previous.current = chapter;
			selectedResult.current = false;
		}
	}, [chapter, query]);
	const choose = (id: string) => {
		selectedResult.current = query.length > 0;
		setQuery("");
		onChapterChange(id);
	};
	return (
		<main className="connection-guide">
			<header className="connection-guide-masthead">
				<div className="connection-guide-wordmark">
					<BookOpen size={18} aria-hidden="true" />
					Connection 使用指南<span>THE FIELD GUIDE</span>
				</div>
				<nav className="connection-guide-download" aria-label="指南入口">
					<a href="/connection/">Codex 安装</a>
					<a href="/connection/agent/">Agent 接入</a>
					<Link to="/connection/login" search={{ returnTo: undefined }}>
						登录控制台
					</Link>
				</nav>
			</header>
			<section className="connection-guide-intro">
				<div>
					<p className="connection-guide-eyebrow">
						CONNECTION / ACCOUNTS & AUTHORIZATION
					</p>
					<h1>
						连接你的工作，
						<br />
						掌握每一份授权。
					</h1>
					<p>
						从连接账号，到安全使用外部能力。
						<br />
						一份面向员工、客户端接入者与管理员的工作指南。
					</p>
				</div>
				<div className="connection-guide-intro-side">
					<span className="connection-guide-volume">
						01—{guideChapters.length}
					</span>
					<p>
						个人与共享账号 · Consumer · Action
						<br />
						独立 Connection，直接服务你的客户端。
					</p>
					<a
						className="connection-guide-download"
						href="/connection/help/user-manual.md"
						download="Connection-使用说明书.md"
					>
						<ArrowDownToLine size={16} aria-hidden="true" />
						完整说明书
					</a>
				</div>
			</section>
			<div className="connection-guide-search">
				<Search size={18} aria-hidden="true" />
				<input
					aria-label="搜索 Connection 使用说明"
					placeholder="搜索步骤、授权或问题，例如：PAT"
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
			{term ? (
				<section className="connection-guide-results" aria-label="搜索结果">
					<p role="status">找到 {found.length} 个章节</p>
					{found.map((item) => {
						const text = guideText(item);
						const start = Math.max(
							0,
							text.toLocaleLowerCase().indexOf(term) - 40,
						);
						return (
							<Button
								key={item.id}
								variant="ghost"
								onClick={() => choose(item.id)}
							>
								<span>{item.id}</span>
								<span className="connection-guide-result-copy">
									<strong>{item.title}</strong>
									<span>
										{start ? "…" : ""}
										{text.slice(start, start + 160)}…
									</span>
								</span>
								<ArrowRight aria-hidden="true" />
							</Button>
						);
					})}
					{!found.length && <p>换一个关键词，或清空搜索浏览全部章节。</p>}
				</section>
			) : (
				<div className="connection-guide-reading">
					<aside>
						<p className="connection-guide-eyebrow">目录 / CONTENTS</p>
						<nav className="connection-guide-contents" aria-label="手册章节">
							{guideChapters.map((item) => (
								<Button
									key={item.id}
									variant="ghost"
									aria-current={item.id === active.id ? "page" : undefined}
									onClick={() => choose(item.id)}
								>
									<span>{item.id}</span>
									{item.title}
								</Button>
							))}
						</nav>
					</aside>
					<article
						className="connection-guide-article"
						aria-labelledby="connection-guide-chapter-title"
					>
						<header>
							<p className="connection-guide-eyebrow">
								USER MANUAL / {active.id}
							</p>
							<h2
								ref={heading}
								tabIndex={-1}
								id="connection-guide-chapter-title"
							>
								{active.title}
							</h2>
							<p className="connection-guide-subtitle">{active.summary}</p>
						</header>
						<div className="connection-guide-prose">
							{active.sections.map((section) => (
								<section key={section.title}>
									<h3>{section.title}</h3>
									{section.paragraphs.map((text) => (
										<p key={text}>{text}</p>
									))}
									{section.steps && (
										<ol>
											{section.steps.map((text) => (
												<li key={text}>{text}</li>
											))}
										</ol>
									)}
									{section.code && (
										<pre>
											<code>{section.code}</code>
										</pre>
									)}
								</section>
							))}
						</div>
						<footer className="connection-guide-article-footer">
							<Button
								variant="ghost"
								disabled={!index}
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
			<footer className="connection-guide-colophon">
				<span>CONNECTION · 账号、能力与授权</span>
				<span>以当前部署目录、资格及客户端验收为准</span>
			</footer>
		</main>
	);
}
