import { ExternalLink, KeyRound, RefreshCw } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { buttonVariants } from "../../components/ui/button.js";
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "../../components/ui/collapsible.js";
import { connectionNeedsAuthDescription } from "../connection-copy.js";
import type { ConversationUpload } from "./conversation-files.js";

/**
 * 设计 .chat-context / .chat-files（details + summary）：默认收起的 44px 摘要行，
 * 摘要为「标题 · 内容 · 按需查看」，末尾「展开 / 收起」只是视觉提示，不进入可访问名称。
 * 面板常驻 DOM（keepMounted），收起不丢失条内状态。
 */
function ChatDisclosure({
	className,
	title,
	summary,
	compact,
	open,
	onOpenChange,
	panelClassName,
	children,
}: {
	className: string;
	title: string;
	summary: ReactNode;
	/** 极短视口两条折叠条并排时代替摘要内容的简短提示（例如失败数）。 */
	compact?: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	panelClassName: string;
	children: ReactNode;
}) {
	const panelId = useId();
	return (
		<Collapsible className={className} open={open} onOpenChange={onOpenChange}>
			<CollapsibleTrigger
				className="chat-disclosure-summary"
				aria-controls={panelId}
			>
				<strong>{title}</strong>
				<span className="chat-disclosure-detail">{summary}</span>
				{compact && <span className="chat-disclosure-compact">{compact}</span>}
				<span className="chat-disclosure-hint">按需查看</span>
				<span className="chat-disclosure-toggle" aria-hidden="true">
					{open ? "收起" : "展开"}
				</span>
			</CollapsibleTrigger>
			<CollapsiblePanel id={panelId} className={panelClassName}>
				{children}
			</CollapsiblePanel>
		</Collapsible>
	);
}

/**
 * 设计 renderChatContext：只在 Agent 有 Connection 或浏览器能力时渲染，位于会话时间线之上。
 * 条内只放不需要用户立即处理的内容（Connection 提示、空闲的浏览器卡）；需要处理或进行中的
 * 浏览器卡在会话时间线里，不靠自动展开来保证可见（NI-83）。
 */
export function ConversationContextBar({
	connection,
	browser,
	children,
}: {
	connection: boolean;
	browser: boolean;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	if (!connection && !browser) return null;
	const labels = [connection && "Connection", browser && "浏览器操作"]
		.filter(Boolean)
		.join(" · ");
	return (
		<ChatDisclosure
			className="chat-context"
			title="会话上下文"
			summary={labels}
			open={open}
			onOpenChange={setOpen}
			panelClassName="chat-context-body"
		>
			{children}
		</ChatDisclosure>
	);
}

/**
 * 设计 renderChatFiles：消息列表之后、输入框之前的「会话文件」折叠条，只汇总本页上传的输入附件。
 * 上传失败或文件限制读取失败时，收起状态下的摘要直接反映失败（AC-2）。
 */
export function ConversationFilesBar({
	uploads,
	limitsError,
	children,
}: {
	uploads: readonly ConversationUpload[];
	limitsError: boolean;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const failed = uploads.filter(
		(item) => item.status === "failed" || item.status === "expired",
	).length;
	const summary = limitsError
		? `${uploads.length} 个文件 · 上传暂不可用`
		: `${uploads.length} 个文件 · ${failed} 个待重试`;
	return (
		<ChatDisclosure
			className="chat-files"
			title="会话文件"
			summary={summary}
			compact={
				limitsError ? "上传暂不可用" : failed ? `${failed} 个待重试` : undefined
			}
			open={open}
			onOpenChange={setOpen}
			panelClassName="chat-files-body"
		>
			{children}
		</ChatDisclosure>
	);
}

export type ConnectionNoticeState = "needs-auth" | "handoff";

/**
 * 浏览器卡不在条内时（当前 Execution 已有浏览器活动，或浏览器暂不可用）的说明：
 * 有请求、接管或进行中的操作时，浏览器卡显示在会话时间线里（不伪造状态）。
 */
export function BrowserContextHint() {
	return (
		<p className="chat-context-hint">
			浏览器操作：有请求、接管或进行中的操作时，浏览器卡显示在会话时间线里。
		</p>
	);
}

/**
 * 设计 renderConnectionNotice（.connection-notice）：会话级 Connection 授权提示，不依赖 Execution。
 * Platform 不保存 Connection 授权状态，这里只给出受控入口；「打开 Connection」后切到
 * handoff 态，入口仍指向同一个 Connection 地址。没有可用地址时不渲染按钮。
 */
export function ConversationConnectionNotice({
	url,
	state,
	onOpen,
}: {
	url?: string;
	state: ConnectionNoticeState;
	onOpen: () => void;
}) {
	const handoff = state === "handoff";
	return (
		<div
			className="connection-notice"
			data-state={handoff ? "handoff" : "needs-auth"}
		>
			<div className="connection-notice-main">
				<span className="connection-notice-icon" aria-hidden="true">
					<KeyRound className="size-4" />
				</span>
				<div className="connection-notice-copy">
					<strong className="connection-notice-title">
						{handoff ? "等待 Connection 授权返回" : "需要 Connection 授权"}
					</strong>
					<p className="connection-notice-text">
						{handoff
							? "已转到独立 Connection。请在那里选择具体 Action/版本并完成授权，完成后回到此会话继续原请求。"
							: connectionNeedsAuthDescription}
					</p>
					{!url && (
						<p className="connection-notice-text">Connection 入口暂不可用。</p>
					)}
					<div className="connection-notice-scope">
						<span>Action 范围</span>
						<strong>在 Connection 中确认</strong>
						<small>按当前主体 / Consumer / Actor 生效</small>
					</div>
				</div>
			</div>
			{url && (
				<div className="connection-notice-action">
					<a
						className={buttonVariants({ variant: "outline" })}
						href={url}
						target="_blank"
						rel="noopener noreferrer"
						onClick={onOpen}
					>
						{handoff ? (
							<RefreshCw aria-hidden="true" />
						) : (
							<ExternalLink aria-hidden="true" />
						)}
						{handoff ? "返回查看授权状态" : "打开 Connection"}
					</a>
				</div>
			)}
		</div>
	);
}
