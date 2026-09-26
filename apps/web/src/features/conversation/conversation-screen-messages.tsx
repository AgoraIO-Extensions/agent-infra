import {
	Bot,
	ChevronLeft,
	ChevronRight,
	RefreshCw,
	SlidersHorizontal,
} from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import type {
	ConversationDetailProjectionV2,
	PersistedConversationEventV2,
} from "../../pilot/generated-v2/types.gen.js";
import { AssistantMarkdown } from "./assistant-markdown.js";
import {
	answerText,
	commandFailure,
	executionStatus,
	executionStatusLabels,
} from "./conversation-screen-state.js";

export function ConversationMessages({
	history,
	events,
	onExecution,
	onRegenerate,
	canRegenerate,
	onResend,
}: {
	history: ConversationDetailProjectionV2;
	events: readonly PersistedConversationEventV2[];
	onExecution: (id: string) => void;
	onRegenerate: (messageId: string) => void;
	canRegenerate: boolean;
	onResend: (text: string) => void;
}) {
	const [versions, setVersions] = useState<Record<string, string>>({});
	const userMessages = history.messages.filter((item) => item.role === "user");
	const answers = history.messages.filter((item) => item.role === "assistant");
	const renderedExecutions = new Set(answers.map((item) => item.executionId));
	const liveExecutions = [
		...new Set(
			events
				.filter((item) => !renderedExecutions.has(item.executionId))
				.map((item) => item.executionId),
		),
	];
	return (
		<section className="timeline min-h-48 space-y-8" aria-label="会话时间线">
			{!userMessages.length && !events.length && (
				<Empty className="chat-welcome space-y-3 py-8">
					<Bot className="mx-auto size-8 text-primary" aria-hidden="true" />
					<EmptyTitle className="text-xl">从一个明确的任务开始</EmptyTitle>
					<EmptyDescription>
						描述需要检查的内容和期望结果。对话仅对你可见。
					</EmptyDescription>
				</Empty>
			)}
			{userMessages.map((message) => {
				const candidates = answers.filter(
					(answer) => answer.replyToMessageId === message.messageId,
				);
				const selected =
					candidates.find(
						(answer) => answer.messageId === versions[message.messageId],
					) ??
					candidates.find((answer) => answer.isCurrentAnswer) ??
					candidates.at(-1);
				const index = selected ? candidates.indexOf(selected) : -1;
				const selectedStatus = selected
					? executionStatus(events, selected.executionId, selected.status)
					: undefined;
				return (
					<article
						className="exchange space-y-4 border-border border-b pb-6"
						key={message.messageId}
					>
						<div className="message-heading font-semibold">你</div>
						<p className="message-text whitespace-pre-wrap break-words">
							{message.text}
						</p>
						{message.status === "failed" && (
							<Alert variant="destructive" className="supplement space-y-2">
								<AlertDescription>
									{commandFailure(message.error.code)}
								</AlertDescription>
								<Button
									variant="outline"
									onClick={() => onResend(message.text)}
								>
									准备重新发送
								</Button>
							</Alert>
						)}
						{selected ? (
							<>
								<div className="message-heading flex items-center gap-2 font-semibold">
									<Bot aria-hidden="true" className="size-5" />
									Agent
								</div>
								<div className="answer space-y-3">
									<AssistantMarkdown>
										{selected.executionId
											? answerText(
													history,
													events,
													selected.executionId,
													selected.text,
												) || "尚未输出正文。"
											: selected.text || "尚未输出正文。"}
									</AssistantMarkdown>
									<Badge
										variant={
											selectedStatus === "failed" ? "destructive" : "secondary"
										}
									>
										{selectedStatus
											? executionStatusLabels[selectedStatus]
											: "等待处理"}
									</Badge>
									{selected.status === "failed" && (
										<p>{commandFailure(selected.error.code)}</p>
									)}
								</div>
								<div className="answer-tools flex flex-wrap items-center gap-2">
									<Button
										variant="ghost"
										disabled={!selected.executionId}
										onClick={() => {
											if (selected.executionId)
												onExecution(selected.executionId);
										}}
									>
										<SlidersHorizontal aria-hidden="true" />
										执行详情
									</Button>
									<Button
										variant="ghost"
										aria-label="上一个回答版本"
										disabled={index <= 0}
										onClick={() =>
											setVersions((previous) => ({
												...previous,
												[message.messageId]: candidates[index - 1].messageId,
											}))
										}
									>
										<ChevronLeft aria-hidden="true" />
									</Button>
									<span className="text-sm">
										版本 {selected.answerVersion ?? index + 1}/
										{candidates.length}
									</span>
									<Button
										variant="ghost"
										aria-label="下一个回答版本"
										disabled={index >= candidates.length - 1}
										onClick={() =>
											setVersions((previous) => ({
												...previous,
												[message.messageId]: candidates[index + 1].messageId,
											}))
										}
									>
										<ChevronRight aria-hidden="true" />
									</Button>
									<Button
										variant="ghost"
										disabled={!canRegenerate}
										onClick={() => onRegenerate(message.messageId)}
									>
										<RefreshCw aria-hidden="true" />
										重新生成
									</Button>
								</div>
							</>
						) : (
							message.status !== "failed" && (
								<div className="space-y-2">
									<p className="text-muted-foreground text-sm">
										{message.status === "submitted"
											? "消息已受理，等待处理。"
											: "消息已保存；回复状态以执行记录为准。"}
									</p>
									{message.executionId && (
										<Button
											variant="ghost"
											onClick={() => {
												if (message.executionId)
													onExecution(message.executionId);
											}}
										>
											执行详情
										</Button>
									)}
								</div>
							)
						)}
					</article>
				);
			})}
			{liveExecutions.map((id) => (
				<article
					className="exchange space-y-3 border-border border-b pb-6"
					key={id}
				>
					<div className="message-heading flex items-center gap-2 font-semibold">
						<Bot aria-hidden="true" className="size-5" />
						Agent
					</div>
					<AssistantMarkdown>
						{events
							.filter(
								(event) =>
									event.executionId === id && event.type === "text.delta",
							)
							.map((event) =>
								event.type === "text.delta" ? event.payload.text : "",
							)
							.join("")}
					</AssistantMarkdown>
					<p className="text-muted-foreground text-sm">
						{
							executionStatusLabels[
								executionStatus(events, id, "processing") ?? "processing"
							]
						}
					</p>
					<Button variant="ghost" onClick={() => onExecution(id)}>
						执行详情
					</Button>
				</article>
			))}
			{events
				.filter((event) => event.type === "model.selection.fell_back")
				.map((event) => (
					<p
						key={event.eventId}
						className="border border-border bg-muted p-3 text-sm"
					>
						原模型选项已移除，此条消息已使用 Owner 的默认选项。
					</p>
				))}
		</section>
	);
}
