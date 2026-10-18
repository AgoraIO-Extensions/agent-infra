import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "../../components/ui/badge.js";
import { Button, buttonVariants } from "../../components/ui/button.js";
import { formatRelativeDate } from "../../lib/format-date.js";
import { useRecentPersonalConversations } from "../workbench/use-recent-personal-conversations.js";

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
	const recent = useRecentPersonalConversations({ identityKey, limit: 50 });
	const { state } = recent;
	return (
		<section aria-label="最近对话" className="space-y-3">
			<div>
				<h2 className="flex items-center gap-2 font-semibold">
					个人历史{" "}
					{state.kind === "ready" ? (
						<Badge variant="outline">{state.conversations.length}</Badge>
					) : null}
				</h2>
				<p className="text-muted-foreground text-xs">只显示你的会话</p>
			</div>
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
					<ul className="space-y-1">
						{state.conversations.map((item) => {
							const current =
								item.agentId === agentId &&
								item.conversationId === conversationId;
							return (
								<li key={JSON.stringify([item.agentId, item.conversationId])}>
									<a
										href={`/chat/${encodeURIComponent(item.agentId)}/${encodeURIComponent(item.conversationId)}`}
										aria-current={current ? "page" : undefined}
										className={buttonVariants({
											variant: current ? "secondary" : "ghost",
											className:
												"h-auto min-h-11 w-full justify-start whitespace-normal text-left",
										})}
										onClick={(event) => {
											if (
												item.agentId !== agentId ||
												event.button !== 0 ||
												event.metaKey ||
												event.ctrlKey ||
												event.shiftKey ||
												event.altKey
											)
												return;
											event.preventDefault();
											onSelect(item.conversationId);
										}}
									>
										<span className="min-w-0 break-words">
											{item.title || "未命名对话"}
											<small>
												{current && "当前对话 · "}
												<time dateTime={item.updatedAt}>
													{formatRelativeDate(item.updatedAt)}
												</time>
												{item.status === "unavailable" && " · 会话不可用"}
											</small>
										</span>
									</a>
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
