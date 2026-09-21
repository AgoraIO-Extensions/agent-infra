import { Bot, History, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
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
		<section aria-label="个人历史" className="min-w-0 space-y-3 pb-4">
			<h2 className="flex items-center gap-2 font-semibold">
				<History className="size-4" aria-hidden="true" />
				个人历史
			</h2>
			{history.status === "loading" && <p role="status">正在读取历史…</p>}
			{history.status === "error" && <p role="alert">历史暂时无法读取。</p>}
			{history.status === "ready" && !history.items.length && (
				<p className="text-muted-foreground text-sm">暂无 Web 会话。</p>
			)}
			<ul className="space-y-1">
				{history.items.map((item) => (
					<li
						className="record-row border-border border-b py-3"
						key={item.conversationId}
					>
						<a
							href={`/agents/${encodeURIComponent(agentId)}/conversations?conversation=${encodeURIComponent(item.conversationId)}`}
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
								<span className="block text-muted-foreground text-xs">
									{new Date(item.updatedAt).toLocaleString()}
								</span>
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
	const handled = useRef<ConversationCommandResult | undefined>(undefined);
	useEffect(() => {
		if (command.result === handled.current) return;
		handled.current = command.result;
		if (command.result?.kind === "created")
			onCreated(command.result.conversationId);
		if (command.result?.kind === "denied") onDenied();
	}, [command.result, onCreated, onDenied]);
	return (
		<div className="space-y-5 py-12 text-center">
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
		</div>
	);
}
