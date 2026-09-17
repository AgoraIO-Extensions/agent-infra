import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowUp, Bot, History, Plus, Square } from "lucide-react";
import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Button, buttonVariants } from "../../components/ui/button.js";
import { Label } from "../../components/ui/label.js";
import {
	NativeSelect,
	NativeSelectOption,
} from "../../components/ui/native-select.js";
import { Textarea } from "../../components/ui/textarea.js";
import { getAgentV2 } from "../../pilot/generated-v2/sdk.gen.js";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import type { ConversationCommandResult } from "./conversation-commands.js";
import { ConversationExecutionDetails } from "./conversation-screen-details.js";
import { ConversationMessages } from "./conversation-screen-messages.js";
import {
	commandFailure,
	currentExecution,
	isTerminal,
} from "./conversation-screen-state.js";
import { ConversationReadError, httpFailure } from "./execution-detail.js";
import { useConversationCommands } from "./use-conversation-commands.js";
import { useConversationHistory } from "./use-conversation-history.js";
import { useConversationTimeline } from "./use-conversation-timeline.js";

export type ConversationScreenProps = {
	agentId: string;
	conversationId?: string;
	identityKey: string;
	view?: "history" | "conversation";
	onViewChange?: (view: "history" | "conversation") => void;
	onConversationChange: (conversationId: string | undefined) => void;
	onAccessDenied?: () => void;
};

/** The React key is an additional UI boundary: drafts, selections and receipts
 * cannot cross a login/session or Agent change. Identity is never sent as input. */
export function ConversationScreen(props: ConversationScreenProps) {
	return (
		<ConversationWorkspace
			key={JSON.stringify([props.identityKey, props.agentId])}
			{...props}
		/>
	);
}

function ConversationWorkspace(props: ConversationScreenProps) {
	const {
		agentId,
		identityKey,
		conversationId,
		onConversationChange,
		onAccessDenied,
	} = props;
	const queryClient = useQueryClient();
	const instanceId = useId();
	const queryKey = useMemo(
		() => ["conversation-screen-agent", instanceId, identityKey, agentId],
		[instanceId, identityKey, agentId],
	);
	const [denied, setDenied] = useState(false);
	const [internalHistory, setInternalHistory] = useState(false);
	const showHistory =
		props.view === undefined ? internalHistory : props.view === "history";
	function setHistory(value: boolean) {
		setInternalHistory(value);
		props.onViewChange?.(value ? "history" : "conversation");
	}
	const agentQuery = useQuery({
		queryKey,
		enabled: Boolean(identityKey && agentId) && !denied,
		retry: false,
		gcTime: 0,
		placeholderData: undefined,
		queryFn: async ({ signal }) => {
			const result = await getAgentV2({
				path: { agentId },
				signal,
				responseStyle: "fields",
				throwOnError: false,
			});
			signal.throwIfAborted();
			if (!result.data)
				throw new ConversationReadError(httpFailure(result.response?.status));
			const parsed = AgentProjectionV2Schema.safeParse(result.data);
			if (!parsed.success || parsed.data.agentId !== agentId)
				throw new ConversationReadError({ kind: "invalid" });
			return parsed.data;
		},
	});
	useLayoutEffect(
		() => () => {
			void queryClient.cancelQueries({ queryKey, exact: true });
			queryClient.removeQueries({ queryKey, exact: true });
		},
		[queryClient, queryKey],
	);
	const deny = useCallback(() => setDenied(true), []);
	const deniedCallback = useRef(onAccessDenied);
	deniedCallback.current = onAccessDenied;
	useLayoutEffect(() => {
		if (
			agentQuery.error instanceof ConversationReadError &&
			agentQuery.error.failure.kind === "authorization"
		)
			setDenied(true);
	}, [agentQuery.error]);
	useLayoutEffect(() => {
		if (!denied) return;
		void queryClient.cancelQueries({ queryKey, exact: true });
		queryClient.removeQueries({ queryKey, exact: true });
		deniedCallback.current?.();
	}, [denied, queryClient, queryKey]);
	if (denied || !identityKey)
		return (
			<p role="alert" className="py-6">
				当前登录或访问权限已失效，请重新登录或返回 Agent 列表。
			</p>
		);
	const agent = agentQuery.data;
	if (!agent)
		return (
			<section className="space-y-4 py-6">
				<h1 className="font-semibold text-[28px]">对话</h1>
				{agentQuery.isPending ? (
					<p role="status">正在读取 Agent…</p>
				) : (
					<>
						<p role="alert">Agent 信息暂时无法读取。</p>
						<Button onClick={() => void agentQuery.refetch()}>重新读取</Button>
					</>
				)}
			</section>
		);
	const available =
		agent.managementStatus === "available" &&
		agent.serviceAvailability === "ready";
	const selfManaged =
		agent.source.kind === "custom" &&
		agent.source.interactionMode === "self-managed";
	return (
		<section className="chat-layout min-w-0 space-y-5">
			<header className="flex flex-wrap items-start justify-between gap-3 border-border border-b pb-4">
				<div>
					<h1 className="font-semibold text-[28px]">
						{showHistory ? "个人历史" : agent.name}
					</h1>
					<p className="mt-1 text-muted-foreground text-sm">
						个人 Web 对话 · 离开页面不会取消已提交的任务
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button variant="outline" onClick={() => setHistory(!showHistory)}>
						{showHistory ? (
							<ArrowLeft aria-hidden="true" />
						) : (
							<History aria-hidden="true" />
						)}
						{showHistory ? "返回对话" : "个人历史"}
					</Button>
					<Button
						variant="outline"
						disabled={!available || selfManaged}
						onClick={() => {
							setInternalHistory(false);
							onConversationChange(undefined);
						}}
					>
						<Plus aria-hidden="true" />
						新建会话
					</Button>
				</div>
			</header>
			{!available && (
				<p role="status" className="border border-border bg-muted p-3">
					{agent.serviceAvailability === "updating"
						? "Agent 更新中"
						: agent.serviceAvailability === "starting"
							? "Agent 启动中"
							: "Agent 当前不可用"}
					，历史保持只读。
					<Button variant="ghost" onClick={() => void agentQuery.refetch()}>
						刷新 Agent 状态
					</Button>
				</p>
			)}
			{showHistory ? (
				<PersonalHistory
					agentId={agentId}
					identityKey={identityKey}
					current={conversationId}
					onSelect={(id) => {
						setInternalHistory(false);
						onConversationChange(id);
					}}
					onDenied={deny}
				/>
			) : null}
			<div hidden={showHistory} className="chat-workspace">
				{selfManaged ? (
					<p>此 Agent 使用自有交互入口，请从 Agent 详情进入。</p>
				) : conversationId ? (
					<ActiveConversation
						key={conversationId}
						{...props}
						agent={agent}
						available={available}
						onDenied={deny}
						refreshAgent={() => void agentQuery.refetch()}
					/>
				) : (
					<NewConversation
						agentId={agentId}
						identityKey={identityKey}
						available={available}
						onCreated={onConversationChange}
						onDenied={deny}
					/>
				)}
			</div>
		</section>
	);
}

function PersonalHistory({
	agentId,
	identityKey,
	current,
	onSelect,
	onDenied,
}: {
	agentId: string;
	identityKey: string;
	current?: string;
	onSelect: ConversationScreenProps["onConversationChange"];
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

function CommandNotice({
	result,
	pending,
	retry,
}: {
	result?: ConversationCommandResult;
	pending: boolean;
	retry?: () => void;
}) {
	if (pending) return <p role="status">正在提交，请勿重复操作…</p>;
	if (result?.kind === "unknown")
		return (
			<div role="alert" className="space-y-2 border border-border bg-muted p-3">
				<p>
					提交结果尚未确认。原请求可能已受理，请核实原请求，避免重复创建回复。
				</p>
				{retry && (
					<Button variant="outline" onClick={retry}>
						核实原请求
					</Button>
				)}
			</div>
		);
	if (result?.kind === "rejected")
		return (
			<div role="alert" className="space-y-2">
				<p>{commandFailure(result.code)}</p>
				{retry && (
					<Button variant="outline" onClick={retry}>
						重试原请求
					</Button>
				)}
			</div>
		);
	return null;
}

function NewConversation({
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

function ActiveConversation({
	agentId,
	identityKey,
	conversationId = "",
	agent,
	available,
	onDenied,
	refreshAgent,
}: ConversationScreenProps & {
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
			setModelId(undefined);
			setReasoning(undefined);
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
		action.current = "message";
		if (command.submitText(draft)) setNotice("");
	}
	function regenerate(messageId: string) {
		if (blocked || commandLocked || active) return;
		action.current = "regenerate";
		if (command.regenerate(messageId)) setNotice("");
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
						{stopping && isTerminal(status) ? "原回复已结束。" : notice}
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
								variant="outline"
								className="self-end"
								disabled={!option?.reasoningLevels.includes(currentReasoning)}
								onClick={() => {
									action.current = "selection";
									command.selectModel({
										modelOptionId: currentModelId,
										reasoningLevel: currentReasoning,
									});
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
						<div className="flex gap-2">
							{active && (
								<Button
									type="button"
									variant="outline"
									disabled={
										blocked || commandLocked || stopping === latestExecution
									}
									onClick={() => {
										action.current = "stop";
										command.stop();
									}}
								>
									<Square aria-hidden="true" />
									{stopping === latestExecution ? "正在停止" : "停止回复"}
								</Button>
							)}
							<Button type="submit" disabled={!canSend}>
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
