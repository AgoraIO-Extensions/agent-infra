import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "../../components/ui/button.js";
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
	return (
		<section aria-label="最近对话" className="space-y-3">
			<ConversationHistoryHeading
				count={state.kind === "ready" ? state.conversations.length : undefined}
				hasMore={state.kind === "ready" && state.nextCursor !== null}
			/>
			{state.kind === "loading" && <p role="status">正在读取最近对话…</p>}
			{state.kind === "unavailable" && (
				<Alert>
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
					{state.conversations.length === 0 && <p>暂无个人对话。</p>}
					<ul className="conversation-history-list">
						{state.conversations.map((item) => {
							const current =
								item.agentId === agentId &&
								item.conversationId === conversationId;
							return (
								<li key={JSON.stringify([item.agentId, item.conversationId])}>
									<ConversationHistoryLink
										href={`/chat/${encodeURIComponent(item.agentId)}/${encodeURIComponent(item.conversationId)}`}
										title={item.title}
										updatedAt={item.updatedAt}
										current={current}
										unavailable={item.status === "unavailable"}
										onNavigate={() => {
											// 跨 Agent 的记录走浏览器默认跳转，进入原 Agent 的会话页。
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
							onClick={() => void recent.loadMore()}
						>
							加载更多对话
						</Button>
					)}
				</>
			)}
			{state.kind === "unavailable" && state.retryable && (
				<Button
					variant="outline"
					disabled={recent.isFetching}
					onClick={() => void recent.refresh()}
				>
					重试读取最近对话
				</Button>
			)}
		</section>
	);
}
