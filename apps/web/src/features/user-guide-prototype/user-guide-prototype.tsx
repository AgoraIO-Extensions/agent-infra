import {
	ArrowDownToLine,
	ArrowLeft,
	ArrowRight,
	BookOpen,
	Compass,
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
import manual from "../../../../../docs/guides/user-manual.md?raw";
import manualUrl from "../../../../../docs/guides/user-manual.md?url";
import "./user-guide-prototype.css";

// Primary source: Issue #1599. Read-only, no fixtures, persistence or business mutations.
const chapters = manual
	.split(/^## /m)
	.slice(1)
	.map((text) => {
		const [heading, ...body] = text.split("\n");
		const [id, title] = heading.split(" · ");
		return { id: id.trim(), title: title.trim(), body: body.join("\n").trim() };
	});
const variants = ["A", "B", "C"];
const names: Record<string, string> = {
	A: "知识手册",
	B: "任务导航",
	C: "阅读长卷",
};
const missions = [
	{
		chapter: "02",
		title: "开始第一轮对话",
		detail: "登录、选择 Agent、发送任务与检查结果",
		audience: "首次使用",
	},
	{
		chapter: "04",
		title: "创建自己的 Agent",
		detail: "模板选择、使用范围与审批进度",
		audience: "申请人",
	},
	{
		chapter: "08",
		title: "管理团队的 Agent",
		detail: "共同 Owner、配置与生命周期",
		audience: "Agent Owner",
	},
	{
		chapter: "10",
		title: "连接外部工作系统",
		detail: "账号连接、明确授权与调用核实",
		audience: "Connection 用户",
	},
	{
		chapter: "13",
		title: "审批与治理",
		detail: "创建审批、运行资格与操作审计",
		audience: "系统管理员",
	},
];
function Article({ body }: { body: string }) {
	return (
		<div className="guide-prose">
			<Markdown
				remarkPlugins={[remarkGfm]}
				components={{
					a: ({ href, children }) => {
						const destination = href?.startsWith("../")
							? new URL(
									href,
									"https://github.com/AgoraIO-Extensions/agent-infra/blob/main/docs/guides/",
								).href
							: href;
						return (
							<a href={destination} target="_blank" rel="noopener noreferrer">
								{children}
							</a>
						);
					},
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
export function UserGuidePrototype({
	variant,
	chapter,
	onChange,
}: {
	variant: string;
	chapter: string;
	onChange: (next: { variant?: string; chapter?: string }) => void;
}) {
	const [query, setQuery] = useState("");
	const articleRef = useRef<HTMLElement>(null);
	const previousChapter = useRef(chapter);
	useEffect(() => {
		if (previousChapter.current !== chapter)
			articleRef.current?.scrollIntoView({ block: "start" });
		previousChapter.current = chapter;
	}, [chapter]);
	const active = chapters.find((item) => item.id === chapter) ?? chapters[0];
	const found = chapters.filter((item) =>
		`${item.title} ${item.body}`
			.toLocaleLowerCase()
			.includes(query.trim().toLocaleLowerCase()),
	);
	const index = chapters.indexOf(active);
	const cycle = (direction: number) =>
		onChange({
			variant:
				variants[
					(variants.indexOf(variant) + direction + variants.length) %
						variants.length
				],
		});
	useEffect(() => {
		const listener = (event: KeyboardEvent) => {
			if (
				!(event.target instanceof HTMLElement) ||
				event.target.closest(
					"input,textarea,select,[contenteditable=true],[role=tablist]",
				)
			)
				return;
			if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
				event.preventDefault();
				onChange({
					variant:
						variants[
							(variants.indexOf(variant) +
								(event.key === "ArrowRight" ? 1 : 2)) %
								3
						],
				});
			}
		};
		window.addEventListener("keydown", listener);
		return () => window.removeEventListener("keydown", listener);
	}, [variant, onChange]);
	const choose = (id: string) => {
		onChange({ chapter: id });
		setQuery("");
	};
	const contents = (
		<nav aria-label="手册章节" className="guide-contents">
			{chapters.map((item) => (
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
	);
	const renderArticle = (section: (typeof chapters)[number]) => (
		<article
			key={section.id}
			ref={section.id === active.id ? articleRef : undefined}
			className="guide-article"
			aria-label={section.title}
		>
			<header>
				<p className="guide-eyebrow">USER MANUAL / {section.id}</p>
				<h2>{section.title}</h2>
				<p className="guide-subtitle">
					操作步骤、完成标志与权限边界，都在这一节。
				</p>
			</header>
			<Article body={section.body} />
			<footer className="guide-article-footer">
				<Button
					variant="ghost"
					disabled={index === 0}
					onClick={() => choose(chapters[index - 1].id)}
				>
					<ArrowLeft />
					上一节
				</Button>
				<span>
					{index + 1} / {chapters.length}
				</span>
				<Button
					variant="ghost"
					disabled={index === chapters.length - 1}
					onClick={() => choose(chapters[index + 1].id)}
				>
					下一节
					<ArrowRight />
				</Button>
			</footer>
		</article>
	);
	return (
		<main className={`guide guide-${variant}`}>
			<header className="guide-masthead">
				<div className="guide-wordmark">
					<BookOpen size={18} />
					使用指南<span>THE FIELD GUIDE</span>
				</div>
				<a
					className="guide-download"
					href={manualUrl}
					download="Agent-Infra-使用说明书.md"
				>
					<ArrowDownToLine size={16} />
					完整说明书
				</a>
			</header>
			<section className="guide-intro">
				<div>
					<p className="guide-eyebrow">AGORA AGENT / KNOWLEDGE & PRACTICE</p>
					<h1>
						{variant === "B" ? (
							<>
								你想完成
								<br />
								什么工作？
							</>
						) : variant === "C" ? (
							<>
								让工作，
								<br />
								有迹可循。
							</>
						) : (
							<>
								从第一次对话，
								<br />
								到团队协作。
							</>
						)}
					</h1>
					<p>
						一份可以随时查阅的工作指南。
						<br />
						理解入口，完成任务，确认每一步的实际结果。
					</p>
				</div>
				<div className="guide-intro-side">
					<span className="guide-volume">
						{variant === "B" ? "→" : "01—15"}
					</span>
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
				<span>{chapters.length} 个章节</span>
			</div>
			{query.trim() ? (
				<section className="guide-results" aria-label="搜索结果">
					<p role="status">找到 {found.length} 个章节</p>
					{found.map((item) => (
						<Button
							key={item.id}
							variant="ghost"
							onClick={() => choose(item.id)}
						>
							<span>{item.id}</span>
							<div>
								<strong>{item.title}</strong>
								<p>{item.body.replace(/[#*|>`]/g, "").slice(0, 100)}…</p>
							</div>
							<ArrowRight />
						</Button>
					))}
					{found.length === 0 && <p>换一个关键词，或清空搜索浏览全部章节。</p>}
				</section>
			) : (
				<>
					{variant === "B" && (
						<section className="guide-missions" aria-label="按任务开始">
							{missions.map((mission, i) => (
								<Button
									key={mission.chapter}
									variant="ghost"
									onClick={() => choose(mission.chapter)}
								>
									<span className="guide-mission-number">0{i + 1}</span>
									<div>
										<small>{mission.audience}</small>
										<h2>{mission.title}</h2>
										<p>{mission.detail}</p>
									</div>
									<ArrowRight />
								</Button>
							))}
						</section>
					)}
					{variant === "C" && (
						<div className="guide-editorial-band">
							<Compass size={24} />
							<p>先找到你的任务，再看清它的边界。</p>
							<span>READ · ACT · VERIFY</span>
						</div>
					)}
					<div className="guide-reading">
						<aside>
							<p className="guide-eyebrow">
								{variant === "C" ? "本册索引 / INDEX" : "目录 / CONTENTS"}
							</p>
							{contents}
						</aside>
						{variant === "C" ? (
							<div className="guide-longform">
								{chapters.map(renderArticle)}
							</div>
						) : (
							renderArticle(active)
						)}
					</div>
				</>
			)}
			<footer className="guide-colophon">
				<span>AGORA AGENT · 使用指南</span>
				<span>以实际就绪状态、权限与验证结果为准</span>
			</footer>
			{import.meta.env.DEV && (
				<nav className="guide-switcher" aria-label="原型设计切换器">
					<Button
						variant="ghost"
						size="icon"
						aria-label="上一种设计"
						onClick={() => cycle(-1)}
					>
						<ArrowLeft />
					</Button>
					<div role="status">
						<small>只读设计原型 · 使用 ← → 比较</small>
						<strong>
							{variant} / {names[variant]}
						</strong>
						<span>
							章节 {active.id} · {query ? `搜索：${query}` : "全部内容"}
						</span>
					</div>
					<Button
						variant="ghost"
						size="icon"
						aria-label="下一种设计"
						onClick={() => cycle(1)}
					>
						<ArrowRight />
					</Button>
				</nav>
			)}
		</main>
	);
}
