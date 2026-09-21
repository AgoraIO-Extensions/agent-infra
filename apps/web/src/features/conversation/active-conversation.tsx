import { ArrowUp, Square } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { Label } from "../../components/ui/label.js";
import {
	NativeSelect,
	NativeSelectOption,
} from "../../components/ui/native-select.js";
import { Textarea } from "../../components/ui/textarea.js";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { CommandNotice } from "./conversation-command-notice.js";
import type { ConversationCommandResult } from "./conversation-commands.js";
import { ConversationExecutionDetails } from "./conversation-screen-details.js";
import { ConversationMessages } from "./conversation-screen-messages.js";
import { currentExecution, isTerminal } from "./conversation-screen-state.js";
import { useConversationCommands } from "./use-conversation-commands.js";
import { useConversationTimeline } from "./use-conversation-timeline.js";

export function ActiveConversation({
	agentId,
	identityKey,
	conversationId = "",
	agent,
	available,
	onDenied,
	refreshAgent,
}: {
	agentId: string;
	identityKey: string;
	conversationId?: string;
	agent: AgentProjectionV2;
	available: boolean;
	onDenied: () => void;
	refreshAgent: () => void;
}) {
	const [selectedExecution, setSelectedExecution] = useState<string>();
	const executionTrigger = useRef<HTMLButtonElement>(null);
	const returnExecutionFocus = useRef(false);
	const conversationTitle = useRef<HTMLHeadingElement>(null);
	useLayoutEffect(() => {
		if (selectedExecution || !returnExecutionFocus.current) return;
		returnExecutionFocus.current = false;
		const trigger = executionTrigger.current;
		executionTrigger.current = null;
		if (trigger?.isConnected && !trigger.disabled) trigger.focus();
		else conversationTitle.current?.focus();
	}, [selectedExecution]);
	function openExecution(executionId: string) {
		executionTrigger.current =
			document.activeElement instanceof HTMLButtonElement
				? document.activeElement
				: null;
		setSelectedExecution(executionId);
	}
	const reader = useConversationTimeline({
		conversationId,
		identityKey,
		executionId: selectedExecution,
	});
	const { timeline } = reader;
	const [draft, setDraft] = useState("");
	const [notice, setNotice] = useState("");
	const [acceptedExecution, setAcceptedExecution] = useState<string>();
	const [stopping, setStopping] = useState<string>();
	const [modelId, setModelId] = useState<string | undefined>();
	const [reasoning, setReasoning] = useState<string | undefined>();
	const composerId = useId();
	const composer = useRef<HTMLTextAreaElement>(null);
	const composing = useRef(false);
	const action = useRef<"message" | "stop" | "regenerate" | "selection">(
		"message",
	);
	const handled = useRef<ConversationCommandResult | undefined>(undefined);
	const conversation = timeline.history?.conversation;
	const { executionId: latestExecution, status } = currentExecution(
		timeline.history,
		timeline.events,
		acceptedExecution,
	);
	const active = Boolean(latestExecution && !isTerminal(status));
	const uncertainExecution = active && status === "unknown";
	const command = useConversationCommands({
		agentId,
		identityKey,
		conversationId,
		executionId: active ? latestExecution : undefined,
	});
	const mismatched = Boolean(conversation && conversation.agentId !== agentId);
	const denied = timeline.status === "denied" || command.isDenied || mismatched;
	useLayoutEffect(() => {
		if (!denied) return;
		command.revoke();
		reader.abort();
		setDraft("");
		onDenied();
	}, [denied, command.revoke, reader.abort, onDenied]);
	const lastRefreshEvent = useRef<string | undefined>(undefined);
	useEffect(() => {
		const event = timeline.events.findLast(
			(item) =>
				item.type === "conversation.error" ||
				(item.type === "execution.status" && isTerminal(item.payload.status)),
		);
		if (!event || lastRefreshEvent.current === event.eventId) return;
		lastRefreshEvent.current = event.eventId;
		// Snapshot already includes this terminal fact; only live terminal events
		// require a fresh message/version projection.
		if (
			!timeline.history?.events.some((item) => item.eventId === event.eventId)
		)
			void reader.refresh();
	}, [timeline.events, timeline.history, reader.refresh]);
	useEffect(() => {
		const result = command.result;
		if (!result || result === handled.current) return;
		handled.current = result;
		if (result.kind === "accepted") {
			if (action.current === "stop") {
				setStopping(result.receipt.executionId ?? undefined);
				setNotice(
					"停止请求已受理，正在等待停止确认。已发生的外部操作不会自动撤回。",
				);
			} else {
				if (action.current === "message") setDraft("");
				setAcceptedExecution(result.receipt.executionId ?? undefined);
				setNotice("消息已受理，等待处理结果。");
			}
			void reader.refresh();
		} else if (result.kind === "selection-updated") {
			// Keep the confirmed values while the projection refreshes; falling back
			// to the stale conversation would briefly show and submit the old choice.
			setNotice("模型选择已保存，从下一条消息开始生效。");
			void reader.refresh();
		}
	}, [command.result, reader.refresh]);
	const options = agent.configuration.modelOptions;
	const currentModelId =
		modelId ??
		conversation?.selectedModelOptionId ??
		agent.configuration.defaultModelOptionId ??
		"";
	const option = options.find((item) => item.optionId === currentModelId);
	const currentReasoning =
		reasoning ??
		conversation?.selectedReasoningLevel ??
		agent.configuration.defaultReasoningLevel ??
		"";
	const blocked =
		!available ||
		!timeline.history ||
		denied ||
		conversation?.status === "unavailable" ||
		timeline.status !== "ready";
	const selectionDirty =
		(modelId !== undefined &&
			modelId !== conversation?.selectedModelOptionId) ||
		(reasoning !== undefined &&
			reasoning !== conversation?.selectedReasoningLevel);
	const commandLocked = command.isPending || command.result?.kind === "unknown";
	const canSend =
		!blocked &&
		!commandLocked &&
		!selectionDirty &&
		!uncertainExecution &&
		!(active && stopping === latestExecution) &&
		(!active || agent.capabilities.supplementaryInstruction) &&
		Boolean(draft.trim());
	function send() {
		if (!canSend) return;
		if (command.submitText(draft)) {
			action.current = "message";
			setNotice("");
		}
	}
	function regenerate(messageId: string) {
		if (blocked || commandLocked || active) return;
		if (command.regenerate(messageId)) {
			action.current = "regenerate";
			setNotice("");
		}
	}
	if (denied) return <p role="alert">访问权限已失效。</p>;
	return (
		<>
			<div
				hidden={Boolean(selectedExecution)}
				className="chat-thread space-y-5"
			>
				<div className="chat-status flex flex-wrap items-center justify-between gap-2">
					<h2 ref={conversationTitle} tabIndex={-1} className="font-medium">
						{conversation?.title || "新会话"}
					</h2>
					<Button
						variant="ghost"
						disabled={timeline.status === "loading"}
						onClick={() => {
							void reader.refresh();
							refreshAgent();
						}}
					>
						刷新会话
					</Button>
				</div>
				{timeline.status === "loading" && <p role="status">正在读取会话…</p>}
				{(timeline.status === "disconnected" ||
					timeline.status === "unavailable") && (
					<div
						role="alert"
						className="space-y-2 border border-border bg-muted p-3"
					>
						<p>
							会话连接暂时中断，草稿已保留。重新连接只恢复读取，不重新发送任务。
						</p>
						<Button variant="outline" onClick={() => void reader.reconnect()}>
							重新连接
						</Button>
					</div>
				)}
				{conversation?.status === "unavailable" && (
					<p role="alert">
						当前会话不可用，历史只读。请使用上方入口明确新建会话。
					</p>
				)}
				{timeline.history && (
					<ConversationMessages
						history={timeline.history}
						events={timeline.events}
						onExecution={openExecution}
						onRegenerate={regenerate}
						canRegenerate={!blocked && !commandLocked && !active}
						onResend={(text) => {
							setDraft(text);
							setNotice("请确认草稿后手动发送；不会自动提交。");
							composer.current?.focus();
						}}
					/>
				)}
				{uncertainExecution && (
					<p role="status">
						原执行结果待核实，同会话暂不能发送下一条消息。
						<Button
							variant="ghost"
							data-c02-recover="recover-original"
							onClick={() => {
								void reader.refresh();
								if (latestExecution) openExecution(latestExecution);
							}}
						>
							核实原执行状态
						</Button>
					</p>
				)}
				{active && !agent.capabilities.supplementaryInstruction && (
					<p role="status">当前回复仍在处理，不支持补充指令。草稿会保留。</p>
				)}
				{notice && (
					<p role="status" className="text-sm">
						{stopping === latestExecution && isTerminal(status)
							? "原回复已结束。"
							: notice}
					</p>
				)}
				<CommandNotice
					result={command.result}
					pending={command.isPending}
					retry={command.canRetry ? () => command.retry() : undefined}
				/>
				{selectionDirty && (
					<p role="status" className="text-sm">
						请先保存模型选择，再发送消息。
					</p>
				)}
				{agent.capabilities.modelSelection && !option && currentModelId && (
					<p className="text-muted-foreground text-sm">
						原模型选项已移除；提交消息时，标准模板将使用 Owner
						的默认选项。你也可以刷新并重新选择。
					</p>
				)}
				<form
					className="composer-zone composer space-y-3 rounded border border-border p-4"
					data-c02-guard="pending-submit"
					data-c02-session-id={conversation?.conversationId ?? conversationId}
					data-c02-message-count={String(
						timeline.history?.messages.length ?? 0,
					)}
					data-pending-submit={command.isPending ? "true" : "false"}
					onSubmit={(event) => {
						event.preventDefault();
						send();
					}}
				>
					<Label htmlFor={composerId}>消息</Label>
					<Textarea
						ref={composer}
						id={composerId}
						rows={3}
						value={draft}
						disabled={blocked || commandLocked}
						placeholder="描述任务和期望结果…"
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
					{agent.capabilities.modelSelection && (
						<fieldset
							className="model-controls grid min-w-0 gap-3 sm:grid-cols-[1fr_1fr_auto]"
							disabled={blocked || commandLocked}
						>
							<legend className="text-muted-foreground text-sm">
								下一条消息的模型
							</legend>
							<div className="min-w-0 space-y-1">
								<Label htmlFor={`${composerId}-model`}>模型</Label>
								<NativeSelect
									id={`${composerId}-model`}
									value={currentModelId}
									onChange={(event) => {
										setModelId(event.target.value);
										setReasoning(
											options.find(
												(item) => item.optionId === event.target.value,
											)?.reasoningLevels[0],
										);
									}}
								>
									<NativeSelectOption value="" disabled>
										请选择模型
									</NativeSelectOption>
									{!option && currentModelId && (
										<NativeSelectOption value={currentModelId} disabled>
											当前选项已移除
										</NativeSelectOption>
									)}
									{options.map((item) => (
										<NativeSelectOption
											key={item.optionId}
											value={item.optionId}
										>
											{item.displayName}
										</NativeSelectOption>
									))}
								</NativeSelect>
							</div>
							<div className="min-w-0 space-y-1">
								<Label htmlFor={`${composerId}-reasoning`}>推理强度</Label>
								<NativeSelect
									id={`${composerId}-reasoning`}
									value={currentReasoning}
									onChange={(event) => setReasoning(event.target.value)}
								>
									<NativeSelectOption value="" disabled>
										请选择推理强度
									</NativeSelectOption>
									{option?.reasoningLevels.map((value) => (
										<NativeSelectOption key={value} value={value}>
											{value}
										</NativeSelectOption>
									))}
								</NativeSelect>
							</div>
							<Button
								type="button"
								variant="outline"
								className="self-end"
								disabled={!option?.reasoningLevels.includes(currentReasoning)}
								onClick={() => {
									if (
										command.selectModel({
											modelOptionId: currentModelId,
											reasoningLevel: currentReasoning,
										})
									)
										action.current = "selection";
								}}
							>
								保存模型选择
							</Button>
						</fieldset>
					)}
					<div className="composer-controls flex flex-wrap items-center justify-between gap-3">
						<p className="text-muted-foreground text-xs">
							Enter 发送 · Shift + Enter 换行
						</p>
						<div className="composer-actions flex gap-2">
							{active && (
								<Button
									type="button"
									variant="outline"
									disabled={
										blocked || commandLocked || stopping === latestExecution
									}
									onClick={() => {
										if (command.stop()) action.current = "stop";
									}}
								>
									<Square aria-hidden="true" />
									{stopping === latestExecution ? "正在停止" : "停止回复"}
								</Button>
							)}
							<Button
								type="submit"
								data-c02-send-button="send"
								disabled={!canSend}
							>
								<ArrowUp aria-hidden="true" />
								{active && agent.capabilities.supplementaryInstruction
									? "发送补充指令"
									: "发送"}
							</Button>
						</div>
					</div>
				</form>
			</div>
			{selectedExecution && (
				<ConversationExecutionDetails
					data={reader.execution.data}
					loading={reader.execution.isFetching}
					failed={reader.execution.isError}
					onRetry={() => void reader.execution.refetch()}
					onClose={() => {
						returnExecutionFocus.current = true;
						setSelectedExecution(undefined);
					}}
				/>
			)}
		</>
	);
}
