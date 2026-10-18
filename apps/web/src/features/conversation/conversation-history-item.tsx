import type { MouseEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Timestamp } from "@/components/ui/timestamp";
import { conversationDisplayTitle } from "./conversation-display-title.js";

/** 设计 .history-panel .section-head：h2「个人历史」+「只显示你的会话」+ 已加载条数 chip。 */
export function ConversationHistoryHeading({
	count,
	hasMore,
}: {
	/** 历史接口没有总数：只显示已加载条数，还有下一页时显示「N+」。未加载完成时不显示。 */
	count?: number;
	hasMore?: boolean;
}) {
	return (
		<div className="conversation-history-head">
			<div>
				<h2>个人历史</h2>
				<p className="conversation-history-hint">只显示你的会话</p>
			</div>
			{count !== undefined && (
				<Badge variant="chip" tone="gray">
					{hasMore ? `${count}+` : count}
					<span className="sr-only"> 个会话</span>
				</Badge>
			)}
		</div>
	);
}

/** 设计 .history-item：标题单行省略，副文「{时间} · 当前」。可访问名称保留完整标题。 */
export function ConversationHistoryLink({
	href,
	title,
	updatedAt,
	current,
	unavailable,
	onNavigate,
}: {
	href: string;
	title: string | null | undefined;
	updatedAt: string;
	current: boolean;
	unavailable?: boolean;
	/** 普通左键点击时在页内切换；返回 false 时保留浏览器默认跳转。 */
	onNavigate: () => boolean;
}) {
	return (
		<a
			href={href}
			aria-current={current ? "page" : undefined}
			className="conversation-history-item"
			onClick={(event: MouseEvent<HTMLAnchorElement>) => {
				if (
					event.button !== 0 ||
					event.metaKey ||
					event.ctrlKey ||
					event.shiftKey ||
					event.altKey
				)
					return;
				if (onNavigate()) event.preventDefault();
			}}
		>
			<strong>{conversationDisplayTitle(title)}</strong>
			<small>
				<Timestamp value={updatedAt} />
				{current && " · 当前"}
				{unavailable && " · 会话不可用"}
			</small>
		</a>
	);
}
