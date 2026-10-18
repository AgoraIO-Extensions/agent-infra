import { useQueryClient } from "@tanstack/react-query";
import { Bot, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { useToast } from "@/components/ui/toast";
import { Button } from "../../components/ui/button.js";
import { CommandNotice } from "./conversation-command-notice.js";
import type { ConversationCommandResult } from "./conversation-commands.js";
import {
	ConversationHistoryHeading,
	ConversationHistoryLink,
} from "./conversation-history-item.js";
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
			<ConversationHistoryHeading
				count={history.status === "ready" ? history.items.length : undefined}
				hasMore={history.hasNextPage}
			/>
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
			<ul className="conversation-history-list">
				{history.items.map((item) => (
					<li key={item.conversationId}>
						<ConversationHistoryLink
							href={`/chat/${encodeURIComponent(agentId)}/${encodeURIComponent(item.conversationId)}`}
							title={item.title}
							updatedAt={item.updatedAt}
							current={current === item.conversationId}
							onNavigate={() => {
								onSelect(item.conversationId);
								return true;
							}}
						/>
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

/** 创建会话的唯一入口：页头「新会话」与无会话参数的入口页共用，沿用幂等键与 404 二次确认（#2570）。 */
export function useCreateConversation({
	agentId,
	identityKey,
	onCreated,
	onDenied,
	verifyAgent,
}: {
	agentId: string;
	identityKey: string;
	onCreated: (id: string) => void;
	onDenied: () => void;
	/** 见 ActiveConversation：true 表示 Agent 仍然可用，404 就是真的失去访问权限（#2570）。 */
	verifyAgent: () => Promise<boolean>;
}) {
	const command = useConversationCommands({ agentId, identityKey });
	const queryClient = useQueryClient();
	const toast = useToast();
	const handled = useRef<ConversationCommandResult | undefined>(undefined);
	useEffect(() => {
		if (command.result === handled.current) return;
		handled.current = command.result;
		if (command.result?.kind === "created") {
			void queryClient.resetQueries({
				queryKey: ["personal-recent", identityKey],
			});
			toast("新会话已创建，已出现在最近对话");
			onCreated(command.result.conversationId);
		}
		if (command.result?.kind === "denied" && !command.result.ambiguous)
			onDenied();
	}, [command.result, identityKey, onCreated, onDenied, queryClient, toast]);
	const ambiguousDenial =
		command.result?.kind === "denied" && command.result.ambiguous === true
			? command.result
			: undefined;
	useEffect(() => {
		if (!ambiguousDenial) return;
		let current = true;
		void verifyAgent().then((denialStands) => {
			if (current && denialStands) onDenied();
		});
		return () => {
			current = false;
		};
	}, [ambiguousDenial, verifyAgent, onDenied]);
	return {
		command,
		busy: command.isPending || command.result?.kind === "unknown",
		create: () => command.create(),
	};
}

export type CreateConversation = ReturnType<typeof useCreateConversation>;

/** 创建结果的反馈：受理中、待核实与被拒绝只在这里说明一次。 */
export function CreateConversationNotice({
	creation,
}: {
	creation: CreateConversation;
}) {
	const { command } = creation;
	return (
		<CommandNotice
			result={command.result}
			pending={command.isPending}
			retry={command.canRetry ? () => command.retry() : undefined}
		/>
	);
}

/** 不带会话参数直接进入 /chat/:agentId 时不自动创建会话（导航不产生业务写入），由用户明确创建。 */
export function NewConversation({
	available,
	creation,
}: {
	available: boolean;
	creation: CreateConversation;
}) {
	return (
		<Empty className="space-y-5 py-12">
			<Bot aria-hidden="true" className="mx-auto size-10 text-primary" />
			<h2 className="font-semibold text-xl">从一个明确的任务开始</h2>
			<p className="text-muted-foreground">
				新建个人会话，然后描述任务和期望结果。
			</p>
			<Button
				disabled={!available || creation.busy}
				onClick={() => creation.create()}
			>
				<Plus aria-hidden="true" />
				创建会话
			</Button>
			<CreateConversationNotice creation={creation} />
		</Empty>
	);
}
