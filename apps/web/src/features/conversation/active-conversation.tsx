import { useQueryClient } from "@tanstack/react-query";
import {
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/components/ui/toast";
import { Button } from "../../components/ui/button.js";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import {
	type BrowserHandoffActionInputV1,
	BrowserHandoffPanel,
	type BrowserSideEffectConfirmationV1,
} from "../agent-discovery/browser-handoff-panel.js";
import { BrowserAuditView } from "./browser-audit-view.js";
import { BrowserOperationStatus } from "./browser-operation-status.js";
import {
	type CapabilityInvocation,
	capabilityReceiptBusy,
	capabilityReceiptPhase,
	capabilityRejectionMessage,
} from "./conversation-capability-lifecycle.js";
import { useCapabilityComposer } from "./conversation-capability-menu.js";
import { CapabilityReceipt } from "./conversation-capability-receipt.js";
import { CommandNotice } from "./conversation-command-notice.js";
import type {
	BrowserCommandBody,
	ConversationCommandResult,
} from "./conversation-commands.js";
import { ConversationComposer } from "./conversation-composer.js";
import {
	ConversationFilePicker,
	useConversationFiles,
} from "./conversation-files.js";
import { ConversationExecutionDetails } from "./conversation-screen-details.js";
import { ConversationMessages } from "./conversation-screen-messages.js";
import {
	currentExecution,
	executionStatus,
	isTerminal,
} from "./conversation-screen-state.js";
import { useConversationCapabilityCatalog } from "./use-conversation-capability-catalog.js";
import { useConversationCommands } from "./use-conversation-commands.js";
import { useConversationModelAutosave } from "./use-conversation-model-autosave.js";
import { useConversationModelSelection } from "./use-conversation-model-selection.js";
import { useConversationTimeline } from "./use-conversation-timeline.js";

// Readiness is still authoritative on the server; a short bounded poll keeps
// the composer responsive while the Worker finishes the Session Sandbox.
const preparingRefreshMs = 500;

type BrowserCommandInvoker = (body: BrowserCommandBody) => boolean;

/** Keep the Browser panel's opaque action ids mapped to the server command
 * union in one place; the panel never constructs transport payloads itself. */
export function createBrowserConversationHandlers(
	invokeBrowser: BrowserCommandInvoker,
) {
	return {
		onPauseAgent: ({ id }: BrowserHandoffActionInputV1) => {
			void invokeBrowser({ schemaVersion: 1, command: "pause", handoffId: id });
		},
		onTakeOver: ({ id }: BrowserHandoffActionInputV1) => {
			void invokeBrowser({
				schemaVersion: 1,
				command: "take_over",
				handoffId: id,
			});
		},
		onReturnToAgent: ({ id }: BrowserHandoffActionInputV1) => {
			void invokeBrowser({
				schemaVersion: 1,
				command: "return_to_agent",
				handoffId: id,
			});
		},
		onConfirmSideEffect: ({ id }: BrowserHandoffActionInputV1) => {
			void invokeBrowser({
				schemaVersion: 1,
				command: "confirm_side_effect",
				confirmationId: id,
			});
		},
		onRejectSideEffect: ({ id }: BrowserHandoffActionInputV1) => {
			void invokeBrowser({
				schemaVersion: 1,
				command: "reject_side_effect",
				confirmationId: id,
			});
		},
		onCancelConfirmation: ({ id }: BrowserHandoffActionInputV1) => {
			void invokeBrowser({
				schemaVersion: 1,
				command: "cancel_side_effect",
				confirmationId: id,
			});
		},
	};
}

export function ActiveConversation({
	agentId,
	identityKey,
	conversationId = "",
	agent,
	available,
	onDenied,
	refreshAgent,
	verifyAgent,
	focusFallback,
}: {
	agentId: string;
	identityKey: string;
	conversationId?: string;
	agent: AgentProjectionV2;
	available: boolean;
	onDenied: () => void;
	refreshAgent: () => void;
	/** 重新读取 Agent；返回 true 表示 Agent 仍然可用，命令被拒绝就是真的失去了访问权限。 */
	verifyAgent: () => Promise<boolean>;
	/** 关闭执行详情且原触发按钮已不存在时的焦点回退目标（页头 h1）。 */
	focusFallback?: RefObject<HTMLHeadingElement | null>;
}) {
	const queryClient = useQueryClient();
	const toast = useToast();
	const [selectedExecution, setSelectedExecution] = useState<string>();
	const executionTrigger = useRef<HTMLButtonElement>(null);
	const returnExecutionFocus = useRef(false);
	useLayoutEffect(() => {
		if (selectedExecution || !returnExecutionFocus.current) return;
		returnExecutionFocus.current = false;
		const trigger = executionTrigger.current;
		executionTrigger.current = null;
		if (trigger?.isConnected && !trigger.disabled) trigger.focus();
		else focusFallback?.current?.focus();
	}, [selectedExecution, focusFallback]);
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
	const [selectionDenied, setSelectionDenied] = useState(false);
	// 本页内受理的命令 / Skill 调用；回执阶段由各自 Execution 的状态推导（CK-01）。
	const [invocations, setInvocations] = useState<CapabilityInvocation[]>([]);
	const pendingInvocation =
		useRef<Omit<CapabilityInvocation, "executionId">>(undefined);
	const composerId = useId();
	const composer = useRef<HTMLTextAreaElement>(null);
	const action = useRef<"message" | "stop" | "regenerate" | "native">(
		"message",
	);
	const handled = useRef<ConversationCommandResult | undefined>(undefined);
	const conversation = timeline.history?.conversation;
	// The Conversation stays read-only until its own Session Sandbox is ready
	// (PRD §6.4, Spec §10.1.1); the draft remains editable meanwhile (#1534).
	// An upgrading Sandbox is shown as "更新中" (PRD, ADR 0023).
	const updating = timeline.history?.sessionAvailability === "updating";
	const preparing =
		updating || timeline.history?.sessionAvailability === "preparing";
	const { executionId: latestExecution, status } = currentExecution(
		timeline.history,
		timeline.events,
		acceptedExecution,
	);
	const catalog = useConversationCapabilityCatalog({
		identityKey,
		conversationId,
		executionId: latestExecution,
		enabled: agent.capabilities.nativeMetadata === true,
	});
	function invocationPhase(executionId: string) {
		return capabilityReceiptPhase(
			executionStatus(
				timeline.events,
				executionId,
				timeline.history?.messages.findLast(
					(message) =>
						message.role === "assistant" && message.executionId === executionId,
				)?.status,
			),
		);
	}
	const lastInvocation = invocations.at(-1);
	const capabilityBusy =
		lastInvocation !== undefined &&
		capabilityReceiptBusy(invocationPhase(lastInvocation.executionId));
	const capability = useCapabilityComposer({
		catalog,
		draft,
		setDraft,
		textarea: composer,
		busy: capabilityBusy,
	});
	const active = Boolean(latestExecution && !isTerminal(status));
	const capabilityExecution = invocations.some(
		(item) => item.executionId === latestExecution,
	);
	const visibleNotice =
		notice ||
		(stopping && stopping === latestExecution
			? isTerminal(status)
				? "原回复已结束。"
				: "停止请求已受理，正在等待停止确认。已发生的外部操作不会自动撤回。"
			: active && acceptedExecution === latestExecution && !capabilityExecution
				? "消息已受理，等待处理结果。"
				: "");
	const uncertainExecution = active && status === "unknown";
	const command = useConversationCommands({
		agentId,
		identityKey,
		conversationId,
		executionId: active ? latestExecution : undefined,
	});
	const customPlatformAdapter =
		agent.source.kind === "custom" &&
		agent.source.interactionMode === "platform-adapter" &&
		agent.capabilities.modelSelection;
	const runtimeSelection = useConversationModelSelection({
		conversationId,
		identityKey,
		enabled: customPlatformAdapter,
	});
	const modelSave = useConversationModelAutosave({
		agentId,
		conversationId,
		onSaved: () => void reader.refresh(),
		onFailed: () => toast("模型设置未保存，请重试；当前任务不受影响"),
		onDenied: (result) => {
			if (!result.ambiguous) {
				setSelectionDenied(true);
				return;
			}
			// 404 与 Agent 已停止同响应：先重读 Agent，确实失去访问权限才闭锁（#2570）。
			void verifyAgent().then((denialStands) => {
				if (denialStands) setSelectionDenied(true);
			});
		},
	});
	const files = useConversationFiles({
		conversationId,
		attachmentsEnabled: agent.capabilities.attachments,
		resultFilesEnabled: agent.capabilities.resultFiles,
	});
	const mismatched = Boolean(conversation && conversation.agentId !== agentId);
	const denied =
		timeline.status === "denied" ||
		command.isDenied ||
		selectionDenied ||
		mismatched;
	const denialScope = `${agentId}:${identityKey}:${conversationId}`;
	const denialScopeRef = useRef(denialScope);
	const denialHandled = useRef(false);
	useLayoutEffect(() => {
		if (denialScopeRef.current !== denialScope) {
			denialScopeRef.current = denialScope;
			denialHandled.current = false;
		}
		if (!denied || denialHandled.current) return;
		denialHandled.current = true;
		command.revoke();
		reader.abort();
		setDraft("");
		onDenied();
	}, [denialScope, denied, command.revoke, reader.abort, onDenied]);
	// 命令得到 404：没有权限与 Agent 已停止在线上是同一个响应。先重新读取 Agent，
	// Agent 确实不可用时保留草稿并由上方横幅说明；仍然可用才按失去访问权限处理（#2570）。
	const ambiguousDenial =
		command.result?.kind === "denied" && command.result.ambiguous === true
			? command.result
			: undefined;
	useEffect(() => {
		if (!ambiguousDenial) return;
		let current = true;
		void verifyAgent().then((denialStands) => {
			if (current && denialStands) command.confirmDenied();
		});
		return () => {
			current = false;
		};
	}, [ambiguousDenial, verifyAgent, command.confirmDenied]);
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
		) {
			void reader.refresh();
		}
		void queryClient.resetQueries({
			queryKey: ["personal-recent", identityKey],
		});
	}, [
		timeline.events,
		timeline.history,
		reader.refresh,
		identityKey,
		queryClient,
	]);
	useEffect(() => {
		if (!preparing) return;
		// No timeline event announces readiness; re-read the projection instead.
		// The next read waits for the previous one to finish, so a slow read is
		// never overlapped or aborted by its own successor (#1732).
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const schedule = () => {
			timer = setTimeout(() => {
				void reader.refresh().finally(() => {
					if (!stopped) schedule();
				});
			}, preparingRefreshMs);
		};
		schedule();
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [preparing, reader.refresh]);
	// The Agent update that becomes ready commits this Session's Sandbox
	// upgrade with it; re-read so an open page shows "更新中" (ADR 0023).
	const wasAvailable = useRef(available);
	useEffect(() => {
		if (available && !wasAvailable.current) void reader.refresh();
		wasAvailable.current = available;
	}, [available, reader.refresh]);
	const capabilityAccepted = capability.accepted;
	const setCapabilityError = capability.setError;
	useEffect(() => {
		const result = command.result;
		if (!result || result === handled.current) return;
		handled.current = result;
		if (
			result.kind === "rejected" &&
			(result.code === "AGENT_STARTING" || result.code === "AGENT_UPDATING")
		) {
			void reader.refresh();
			refreshAgent();
			return;
		}
		if (result.kind === "accepted") {
			setNotice("");
			if (action.current === "stop") {
				// The stop request found the reply already finished; there is no
				// stop to wait for, only a projection to refresh (#1524).
				if (result.receipt.status === "already_finished") {
					setStopping(undefined);
					setNotice("原回复已结束。");
				} else setStopping(result.receipt.executionId ?? undefined);
			} else {
				if (action.current === "message") setDraft("");
				setAcceptedExecution(result.receipt.executionId ?? undefined);
			}
			void reader.refresh();
		} else if (result.kind === "native-accepted") {
			const selected = pendingInvocation.current;
			pendingInvocation.current = undefined;
			if (selected)
				setInvocations((items) => [
					...items.filter((item) => item.executionId !== result.executionId),
					{ ...selected, executionId: result.executionId },
				]);
			setNotice("");
			setAcceptedExecution(result.executionId);
			capabilityAccepted();
			void reader.refresh();
		} else if (result.kind === "native-rejected") {
			// 原因只在 composer 内显示一次，选择保留，可移除后重选（CK-02）。
			pendingInvocation.current = undefined;
			setCapabilityError(
				capabilityRejectionMessage(result.outcome, result.reason),
			);
		} else if (result.kind === "browser-accepted") {
			setNotice(
				result.receipt.outcome === "replayed"
					? "Browser 命令已恢复。"
					: "Browser 命令已受理。",
			);
			void reader.refresh();
		}
	}, [
		command.result,
		reader.refresh,
		refreshAgent,
		capabilityAccepted,
		setCapabilityError,
	]);
	const options = customPlatformAdapter
		? (runtimeSelection.data?.options ?? [])
		: agent.configuration.modelOptions;
	const runtimeSelectionUnavailable =
		customPlatformAdapter && !runtimeSelection.data?.available;
	const currentModelId =
		modelSave.desired?.modelOptionId ??
		conversation?.selectedModelOptionId ??
		(customPlatformAdapter
			? (runtimeSelection.data?.currentModelOptionId ?? "")
			: (agent.configuration.defaultModelOptionId ?? ""));
	const option = options.find((item) => item.optionId === currentModelId);
	const currentReasoning =
		modelSave.desired?.reasoningLevel ??
		conversation?.selectedReasoningLevel ??
		agent.configuration.defaultReasoningLevel ??
		"";
	// 已有投影时的刷新（例如回复结束后的重读）不锁住发送；服务端仍做准入校验（#2136）。
	const refreshing = timeline.status === "loading" && Boolean(timeline.history);
	const blocked =
		!available ||
		!timeline.history ||
		denied ||
		runtimeSelectionUnavailable ||
		conversation?.status === "unavailable" ||
		// A stream reconnecting on its own keeps the composer usable (#1606).
		(timeline.status !== "ready" &&
			timeline.status !== "reconnecting" &&
			!refreshing);
	const commandLocked = command.isPending || command.result?.kind === "unknown";
	const browserEvent = reader.browserHandoffEvent;
	const browserSideEffectEvent = reader.browserSideEffectEvent;
	const browserBinding =
		browserSideEffectEvent?.payload.binding ?? browserEvent?.payload.binding;
	const browserConfirmation: BrowserSideEffectConfirmationV1 | undefined =
		browserSideEffectEvent
			? {
					confirmationId: browserSideEffectEvent.payload.confirmationId,
					status: browserSideEffectEvent.payload.status,
					expiresAt: browserSideEffectEvent.payload.expiresAt,
					operation: browserSideEffectEvent.payload.operation,
					targetOrigin: browserSideEffectEvent.payload.targetOrigin,
					redactedTargetSummary:
						browserSideEffectEvent.payload.redactedTargetSummary,
					binding: browserSideEffectEvent.payload.binding,
				}
			: undefined;
	const browserHandlers = createBrowserConversationHandlers(
		command.invokeBrowser,
	);
	// Keep the local draft editable while an Agent or its Session is becoming
	// ready. Sending stays blocked by `blocked`/`preparing`; only an authorization
	// or read failure should lock the text area itself (#1607).
	const agentTransitioning =
		agent.serviceAvailability === "starting" ||
		agent.serviceAvailability === "updating";
	// 连接暂时中断（断开或读取暂不可用）时草稿仍可编辑，发送由 `blocked` 阻止（#2151）。
	const readLocked =
		timeline.status === "unavailable" &&
		timeline.failure?.kind !== "network" &&
		timeline.failure?.kind !== "service";
	// 模型设置保存不进入 commandLocked：保存中草稿仍可编辑，只禁止发送（CK-06）。
	const draftDisabled =
		denied ||
		commandLocked ||
		!timeline.history ||
		conversation?.status === "unavailable" ||
		readLocked ||
		(!available && !agentTransitioning);
	const submitReady =
		!blocked &&
		!preparing &&
		!commandLocked &&
		modelSave.phase === "idle" &&
		!uncertainExecution &&
		!(active && stopping === latestExecution) &&
		(!active || agent.capabilities.supplementaryInstruction) &&
		!files.uploading &&
		!capabilityBusy;
	const canSend = submitReady && Boolean(draft.trim());
	async function send() {
		if (!canSend) return;
		if (customPlatformAdapter) {
			let latest: Awaited<ReturnType<typeof runtimeSelection.refresh>>;
			try {
				latest = await runtimeSelection.refresh();
			} catch {
				setNotice("Runtime 模型列表暂时不可用，请刷新后重试。");
				return;
			}
			const selected = latest?.options.find(
				(item) => item.optionId === currentModelId,
			);
			if (
				!latest?.available ||
				!selected?.reasoningLevels.includes(currentReasoning)
			) {
				setNotice("模型选项已失效，请刷新后重新选择。");
				return;
			}
		}
		if (command.submitText(draft, files.attachments)) {
			action.current = "message";
			setNotice("");
		}
	}
	const invokeCapability = useCallback(
		(
			body: Parameters<typeof command.invokeCapability>[0],
			selected: Omit<CapabilityInvocation, "executionId">,
		) => {
			if (!command.invokeCapability(body)) return;
			action.current = "native";
			pendingInvocation.current = {
				kind: selected.kind,
				name: selected.name,
				source: selected.source,
				version: selected.version,
			};
			setNotice("");
		},
		[command.invokeCapability],
	);
	function regenerate(messageId: string) {
		if (blocked || preparing || commandLocked || active) return;
		if (command.regenerate(messageId)) {
			action.current = "regenerate";
			setNotice("");
		}
	}
	if (denied)
		return (
			<Alert>
				<AlertDescription>访问权限已失效。</AlertDescription>
			</Alert>
		);
	const modelSelectable =
		agent.capabilities.modelSelection &&
		(!customPlatformAdapter || runtimeSelection.data?.available);
	return (
		<>
			<div
				hidden={Boolean(selectedExecution)}
				className="chat-thread space-y-5"
			>
				{timeline.status === "loading" && !timeline.history && (
					<p role="status">正在读取会话…</p>
				)}
				{timeline.status === "reconnecting" && (
					<p role="status">会话连接中断，正在自动重新连接，草稿会保留。</p>
				)}
				{(timeline.status === "disconnected" ||
					timeline.status === "unavailable") && (
					<Alert className="space-y-2 bg-muted">
						<AlertDescription>
							{readLocked
								? "会话连接暂时中断，草稿已保留。重新连接只恢复读取，不重新发送任务。"
								: "会话连接暂时中断，草稿已保留，恢复后会自动继续读取；也可手动重新连接。重新连接只恢复读取，不重新发送任务。"}
						</AlertDescription>
						<Button variant="outline" onClick={() => void reader.reconnect()}>
							重新连接
						</Button>
					</Alert>
				)}
				{conversation?.status === "unavailable" && (
					<Alert>
						<AlertDescription>
							当前会话不可用，历史只读。请使用上方入口明确新建会话。
						</AlertDescription>
					</Alert>
				)}
				{timeline.history && (
					<ConversationMessages
						agentName={agent.name}
						history={timeline.history}
						events={timeline.events}
						onExecution={openExecution}
						onRegenerate={regenerate}
						canRegenerate={!blocked && !preparing && !commandLocked && !active}
						onResend={(text) => {
							setDraft(text);
							setNotice("请确认草稿后手动发送；不会自动提交。");
							composer.current?.focus();
						}}
						onDownloadFile={files.download}
						downloadingFileId={files.downloading}
						hasEarlier={timeline.hasEarlier}
						earlierLoading={timeline.earlierLoading}
						earlierFailure={timeline.earlierFailure !== null}
						onLoadEarlier={() => void reader.loadEarlier()}
						trailing={invocations.map((invocation) => (
							<CapabilityReceipt
								key={invocation.executionId}
								invocation={invocation}
								phase={invocationPhase(invocation.executionId)}
								onDetails={() => openExecution(invocation.executionId)}
								onVerify={() => {
									void reader.refresh();
									openExecution(invocation.executionId);
								}}
							/>
						))}
					/>
				)}
				{uncertainExecution && !capabilityExecution && (
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
				{preparing && (
					<p role="status">
						{updating
							? "会话更新中，完成后即可发送。草稿会保留。"
							: "会话准备中，完成后即可发送。草稿会保留。"}
					</p>
				)}
				{active && !agent.capabilities.supplementaryInstruction && (
					<p role="status">当前回复仍在处理，不支持补充指令。草稿会保留。</p>
				)}
				{visibleNotice && (
					<p role="status" className="text-sm">
						{visibleNotice}
					</p>
				)}
				<BrowserOperationStatus
					events={timeline.events}
					executionId={latestExecution}
				/>
				<BrowserAuditView
					conversationId={conversationId}
					events={timeline.events}
					executionId={latestExecution}
				/>
				{reader.browserHandoffEvent || browserConfirmation ? (
					<BrowserHandoffPanel
						browserAvailable={
							agent.capabilities.browser?.status === "available"
						}
						handoffEvent={reader.browserHandoffEvent}
						confirmation={browserConfirmation}
						currentBinding={browserBinding}
						{...browserHandlers}
					/>
				) : null}
				<CommandNotice
					result={command.result}
					pending={command.isPending}
					retry={command.canRetry ? () => command.retry() : undefined}
				/>
				{agent.capabilities.modelSelection && !option && currentModelId && (
					<p className="text-muted-foreground text-sm">
						原模型选项已移除；提交消息时，标准模板将使用 Owner
						的默认选项。你也可以刷新并重新选择。
					</p>
				)}
				<ConversationComposer
					composerId={composerId}
					textarea={composer}
					draft={draft}
					draftDisabled={draftDisabled}
					submitReady={submitReady}
					invokeReady={!active}
					sendLabel={
						active &&
						agent.capabilities.supplementaryInstruction &&
						!capabilityExecution
							? "发送补充指令"
							: "发送"
					}
					capability={capability}
					model={
						modelSelectable
							? {
									options,
									modelId: currentModelId,
									reasoning: currentReasoning,
									disabled: blocked || commandLocked,
									phase: modelSave.phase,
									saved: modelSave.saved,
									onChoose: modelSave.choose,
									onRetry: () => void modelSave.retry(),
								}
							: undefined
					}
					modelFailure={modelSave.failure}
					stop={
						active
							? {
									label: stopping === latestExecution ? "正在停止" : "停止回复",
									disabled:
										blocked || commandLocked || stopping === latestExecution,
									onStop: () => {
										if (command.stop()) action.current = "stop";
									},
								}
							: undefined
					}
					attachments={
						<ConversationFilePicker
							attachmentsEnabled={agent.capabilities.attachments}
							limits={files.limits}
							limitsError={files.limitsError}
							uploads={files.uploads}
							onSelect={(selected) => void files.addFiles(selected)}
							onRemove={files.remove}
							onRetry={files.retry}
						/>
					}
					formAttributes={{
						"data-c02-guard": "pending-submit",
						"data-c02-session-id":
							conversation?.conversationId ?? conversationId,
						"data-c02-message-count": String(
							timeline.history?.messages.length ?? 0,
						),
						"data-pending-submit": command.isPending ? "true" : "false",
					}}
					onSendMessage={() => void send()}
					onInvokeCapability={invokeCapability}
				/>
			</div>
			{selectedExecution && (
				<ConversationExecutionDetails
					data={reader.execution.data}
					conversationId={conversationId}
					loading={reader.execution.isFetching}
					failed={reader.execution.isError || timeline.failure?.kind === "http"}
					onRetry={() => {
						if (timeline.failure?.kind === "http") void reader.reconnect();
						else void reader.execution.refetch();
					}}
					onClose={() => {
						returnExecutionFocus.current = true;
						setSelectedExecution(undefined);
					}}
				/>
			)}
		</>
	);
}
