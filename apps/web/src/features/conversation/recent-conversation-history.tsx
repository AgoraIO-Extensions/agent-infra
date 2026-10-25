import { useRef } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { LoadingLine } from "@/components/ui/spinner";
import { listLinks, useLoadMoreFocus } from "@/hooks/use-load-more-focus";
import { Button } from "../../components/ui/button.js";
import { RecoveryButton } from "../recovery-button.js";
import { RecentUnavailableAgentsNotice } from "../workbench/recent-unavailable-agents-notice.js";
import { useRecentPersonalConversations } from "../workbench/use-recent-personal-conversations.js";
import {
	ConversationHistoryHeading,
	ConversationHistoryLink,
} from "./conversation-history-item.js";

export function RecentConversationHistory({
	agentId,
	conversationId,
	identityKey,
	onSelect,
}: {
	agentId: string;
	conversationId?: string;
	identityKey: string;
	onSelect: (id: string) => void;
}) {
	const recent = useRecentPersonalConversations({ identityKey });
	const { state } = recent;
	const list = useRef<HTMLUListElement>(null);
	// 「加载更多对话」读取中可聚焦，读完没有更多时焦点移到新加载的第一条（#3242 K7-02）。
	const armLoadMore = useLoadMoreFocus(recent.isFetching, listLinks(list));
	return (
		<section aria-label="最近对话" className="space-y-3">
			<ConversationHistoryHeading
				count={state.kind === "ready" ? state.conversations.length : undefined}
				hasMore={state.kind === "ready" && state.nextCursor !== null}
			/>
			{state.kind === "loading" && <LoadingLine>正在读取最近对话…</LoadingLine>}
			{state.kind === "unavailable" && (
				<Alert tone="danger" role="alert">
					<AlertDescription>
						{state.reason === "authentication-required"
							? "最近对话无法读取，请重新登录。"
							: state.reason === "denied"
								? "当前无权读取最近对话。"
								: state.reason === "not-found"
									? "最近对话读取入口不可用。"
									: state.reason === "invalid-response"
										? "最近对话返回的数据无法读取。"
										: "最近对话暂时无法读取。"}
					</AlertDescription>
				</Alert>
			)}
			{state.kind === "ready" && (
				<>
					<RecentUnavailableAgentsNotice agentIds={state.unavailableAgentIds} />
					{state.conversations.length === 0 && <p>暂无个人对话。</p>}
					<ul ref={list} className="conversation-history-list">
						{state.conversations.map((item) => {
							const current =
								item.agentId === agentId &&
								item.conversationId === conversationId;
							return (
								<li key={JSON.stringify([item.agentId, item.conversationId])}>
									<ConversationHistoryLink
										agentId={item.agentId}
										conversationId={item.conversationId}
										title={item.title}
										updatedAt={item.updatedAt}
										current={current}
										unavailable={item.status === "unavailable"}
										onNavigate={() => {
											// 跨 Agent 的记录交给路由 Link 跳转，进入原 Agent 的会话页（会话页按
											// Agent 重新挂载，不整页重新加载）。
											if (item.agentId !== agentId) return false;
											onSelect(item.conversationId);
											return true;
										}}
									/>
								</li>
							);
						})}
					</ul>
					{state.nextCursor !== null && (
						<Button
							variant="outline"
							disabled={recent.isFetching}
							focusableWhenDisabled
							onClick={() => {
								armLoadMore();
								void recent.loadMore();
							}}
						>
							加载更多对话
						</Button>
					)}
				</>
			)}
			{state.kind === "unavailable" && state.retryable && (
				<RecoveryButton
					variant="outline"
					recoveryKey="重试读取最近对话"
					busy={recent.isFetching}
					onClick={() => void recent.refresh()}
				>
					重试读取最近对话
				</RecoveryButton>
			)}
		</section>
	);
}
