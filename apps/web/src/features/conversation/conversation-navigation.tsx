import { useQueryClient } from "@tanstack/react-query";
import { Bot, History, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Button, buttonVariants } from "../../components/ui/button.js";
import { CommandNotice } from "./conversation-command-notice.js";
import type { ConversationCommandResult } from "./conversation-commands.js";
import { useConversationCommands } from "./use-conversation-commands.js";
import { useConversationHistory } from "./use-conversation-history.js";

export function PersonalHistory({
	agentId,
	identityKey,
	current,
	onSelect,
	onDenied,
}: {
	agentId: string;
	identityKey: string;
	current?: string;
	onSelect: (conversationId: string | undefined) => void;
	onDenied: () => void;
}) {
	const history = useConversationHistory({ agentId, identityKey });
	useLayoutEffect(() => {
		if (history.status === "denied") onDenied();
	}, [history.status, onDenied]);
	return (
		<section aria-label="个人历史" className="min-w-0 space-y-3">
			<h2 className="flex items-center gap-2 font-semibold">
				<History className="size-4" aria-hidden="true" />
				个人历史
			</h2>
			{history.status === "loading" && <p role="status">正在读取历史…</p>}
			{history.status === "error" && (
				<Alert>
					<AlertDescription>历史暂时无法读取。</AlertDescription>
				</Alert>
			)}
			{history.status === "ready" && !history.items.length && (
				<Empty>
					<EmptyDescription>暂无 Web 会话。</EmptyDescription>
				</Empty>
			)}
			<p className="text-muted-foreground text-xs">只显示你的会话</p>
			<ul className="space-y-1">
				{history.items.map((item) => (
					<li key={item.conversationId}>
						<a
							href={`/chat/${encodeURIComponent(agentId)}/${encodeURIComponent(item.conversationId)}`}
							aria-current={
								current === item.conversationId ? "page" : undefined
							}
							className={buttonVariants({
								variant:
									current === item.conversationId ? "secondary" : "ghost",
								className: "w-full justify-start text-left",
							})}
							onClick={(event) => {
								if (
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
								{item.title || "未命名会话"}
								<small>
									{current === item.conversationId && "当前对话 · "}
									{new Date(item.updatedAt).toLocaleString("zh-CN")}
								</small>
							</span>
						</a>
					</li>
				))}
			</ul>
			{history.canRetry && (
				<Button variant="outline" onClick={() => void history.retry()}>
					重试读取历史
				</Button>
			)}
			{history.hasNextPage && (
				<Button
					variant="outline"
					disabled={history.isFetching}
					onClick={() => void history.loadMore()}
				>
					加载更多
				</Button>
			)}
		</section>
	);
}

export function NewConversation({
	agentId,
	identityKey,
	available,
	onCreated,
	onDenied,
}: {
	agentId: string;
	identityKey: string;
	available: boolean;
	onCreated: (id: string) => void;
	onDenied: () => void;
}) {
	const command = useConversationCommands({ agentId, identityKey });
	const queryClient = useQueryClient();
	const handled = useRef<ConversationCommandResult | undefined>(undefined);
	useEffect(() => {
		if (command.result === handled.current) return;
		handled.current = command.result;
		if (command.result?.kind === "created") {
			void queryClient.resetQueries({
				queryKey: ["personal-recent", identityKey],
			});
			onCreated(command.result.conversationId);
		}
		if (command.result?.kind === "denied") onDenied();
	}, [command.result, identityKey, onCreated, onDenied, queryClient]);
	return (
		<Empty className="space-y-5 py-12">
			<Bot aria-hidden="true" className="mx-auto size-10 text-primary" />
			<h2 className="font-semibold text-xl">从一个明确的任务开始</h2>
			<p className="text-muted-foreground">
				新建个人会话，然后描述任务和期望结果。
			</p>
			<Button
				disabled={
					!available || command.isPending || command.result?.kind === "unknown"
				}
				onClick={() => command.create()}
			>
				<Plus aria-hidden="true" />
				创建会话
			</Button>
			<CommandNotice
				result={command.result}
				pending={command.isPending}
				retry={command.canRetry ? () => command.retry() : undefined}
			/>
		</Empty>
	);
}
