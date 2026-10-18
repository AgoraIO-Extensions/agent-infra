import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Bot, History } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Button, buttonVariants } from "../../components/ui/button.js";
import { Label } from "../../components/ui/label.js";
import { Textarea } from "../../components/ui/textarea.js";
import { formatRelativeDate } from "../../lib/format-date.js";
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
								{item.title || "未命名对话"}
								<small>
									{current === item.conversationId && "当前对话 · "}
									{formatRelativeDate(item.updatedAt)}
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
	verifyAgent,
}: {
	agentId: string;
	identityKey: string;
	available: boolean;
	onCreated: (id: string) => void;
	onDenied: () => void;
	/** 见 ActiveConversation：true 表示 Agent 仍然可用，404 就是真的失去访问权限（#2570）。 */
	verifyAgent: () => Promise<boolean>;
}) {
	const createCommand = useConversationCommands({ agentId, identityKey });
	const [createdConversationId, setCreatedConversationId] = useState<string>();
	const [pendingDraft, setPendingDraft] = useState<string>();
	const [messageStarted, setMessageStarted] = useState(false);
	const [draft, setDraft] = useState("");
	const composerId = useId();
	const composing = useRef(false);
	const messageCommand = useConversationCommands({
		agentId,
		identityKey,
		conversationId: createdConversationId,
	});
	const queryClient = useQueryClient();
	const handledCreate = useRef<ConversationCommandResult | undefined>(
		undefined,
	);
	const handledMessage = useRef<ConversationCommandResult | undefined>(
		undefined,
	);
	const createResult = createCommand.result;
	const messageResult = messageCommand.result;
	useEffect(() => {
		if (createResult === handledCreate.current) return;
		handledCreate.current = createResult;
		if (createResult?.kind === "created") {
			setCreatedConversationId(createResult.conversationId);
		}
		if (createResult?.kind === "denied" && !createResult.ambiguous) onDenied();
	}, [createResult, onDenied]);
	useEffect(() => {
		if (messageResult?.kind === "denied" && !messageResult.ambiguous)
			onDenied();
	}, [messageResult, onDenied]);
	useEffect(() => {
		if (
			!createdConversationId ||
			!pendingDraft ||
			messageStarted ||
			createResult?.kind !== "created"
		)
			return;
		if (messageCommand.submitText(pendingDraft)) setMessageStarted(true);
	}, [
		createdConversationId,
		createResult,
		messageCommand.submitText,
		messageStarted,
		pendingDraft,
	]);
	useEffect(() => {
		if (messageResult === handledMessage.current) return;
		handledMessage.current = messageResult;
		if (messageResult?.kind !== "accepted" || !createdConversationId) return;
		void queryClient.resetQueries({
			queryKey: ["personal-recent", identityKey],
		});
		onCreated(createdConversationId);
	}, [
		createdConversationId,
		identityKey,
		messageResult,
		onCreated,
		queryClient,
	]);
	const ambiguousDenial =
		createResult?.kind === "denied" && createResult.ambiguous === true
			? createResult
			: messageResult?.kind === "denied" && messageResult.ambiguous === true
				? messageResult
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
	const command = createdConversationId ? messageCommand : createCommand;
	const commandLocked = command.isPending || command.result?.kind === "unknown";
	const canSend = available && !commandLocked && Boolean(draft.trim());
	function send() {
		if (!canSend) return;
		if (createdConversationId) {
			if (messageCommand.submitText(draft)) {
				setMessageStarted(true);
				return;
			}
			return;
		}
		if (createCommand.create()) setPendingDraft(draft);
	}
	return (
		<section className="chat-thread space-y-5" aria-label="新会话">
			<div className="chat-welcome space-y-3 py-8">
				<Bot aria-hidden="true" className="mx-auto size-10 text-primary" />
				<h2 className="text-center font-semibold text-xl">
					从一个明确的任务开始
				</h2>
				<p className="text-center text-muted-foreground">
					输入第一条消息即可创建个人会话并开始任务。
				</p>
			</div>
			<form
				className="composer-zone composer"
				onSubmit={(event) => {
					event.preventDefault();
					send();
				}}
			>
				<Label className="sr-only" htmlFor={composerId}>
					消息
				</Label>
				<Textarea
					id={composerId}
					rows={3}
					value={draft}
					disabled={commandLocked || !available}
					placeholder="输入消息，或 / 搜索命令与 Skill…"
					onChange={(event) => setDraft(event.target.value)}
					onCompositionStart={() => {
						composing.current = true;
					}}
					onCompositionEnd={() => {
						composing.current = false;
					}}
					onKeyDown={(event) => {
						if (
							event.key === "Enter" &&
							!event.shiftKey &&
							!event.nativeEvent.isComposing &&
							event.keyCode !== 229 &&
							!composing.current
						) {
							event.preventDefault();
							send();
						}
					}}
				/>
				<div className="composer-controls">
					<p className="text-muted-foreground text-xs">
						Enter 发送 · Shift + Enter 换行
					</p>
					<Button type="submit" data-c02-send-button="send" disabled={!canSend}>
						<ArrowUp aria-hidden="true" />
						发送
					</Button>
				</div>
			</form>
			<CommandNotice
				result={command.result}
				pending={command.isPending}
				retry={command.canRetry ? () => command.retry() : undefined}
				resend={
					command.canRetry && available
						? () => {
								if (createdConversationId) {
									if (messageCommand.submitText(draft)) setMessageStarted(true);
									return;
								}
								if (createCommand.create()) setPendingDraft(draft);
							}
						: undefined
				}
				resendDisabled={!draft.trim()}
			/>
		</section>
	);
}
