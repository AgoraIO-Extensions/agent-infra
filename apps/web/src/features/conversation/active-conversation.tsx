import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Square } from "lucide-react";
import {
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "../../components/ui/button.js";
import { Label } from "../../components/ui/label.js";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../../components/ui/select.js";
import { Textarea } from "../../components/ui/textarea.js";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import {
	type BrowserHandoffActionInputV1,
	BrowserHandoffPanel,
	type BrowserSideEffectConfirmationV1,
} from "../agent-discovery/browser-handoff-panel.js";
import { BrowserAuditView } from "./browser-audit-view.js";
import { BrowserOperationStatus } from "./browser-operation-status.js";
import type { ConversationCapabilitySelectionV1 } from "./conversation-capability-picker.js";
import { ConversationCapabilityPickerPanel } from "./conversation-capability-picker-panel.js";
import { CommandNotice } from "./conversation-command-notice.js";
import type {
	BrowserCommandBody,
	ConversationCommandResult,
} from "./conversation-commands.js";
import {
	ConversationFilePicker,
	useConversationFiles,
} from "./conversation-files.js";
import { ConversationExecutionDetails } from "./conversation-screen-details.js";
import { ConversationMessages } from "./conversation-screen-messages.js";
import { currentExecution, isTerminal } from "./conversation-screen-state.js";
import { useConversationCommands } from "./use-conversation-commands.js";
import { useConversationModelSelection } from "./use-conversation-model-selection.js";
import { useConversationNativeMetadata } from "./use-conversation-native-metadata.js";
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
}) {
	const queryClient = useQueryClient();
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
	const action = useRef<
		"message" | "stop" | "regenerate" | "selection" | "native"
	>("message");
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
	const nativeMetadataEnabled = agent.capabilities.nativeMetadata === true;
	const nativeMetadataCommands = useConversationNativeMetadata({
		identityKey,
		conversationId,
		executionId: latestExecution,
		selector: "commands",
		enabled: nativeMetadataEnabled,
	});
	const nativeMetadataSkills = useConversationNativeMetadata({
		identityKey,
		conversationId,
		executionId: latestExecution,
		selector: "skills",
		enabled: nativeMetadataEnabled,
	});
	const nativeMetadataCapabilities = useMemo(
		() => [
			...nativeMetadataCommands.capabilities,
			...nativeMetadataSkills.capabilities,
		],
		[nativeMetadataCommands.capabilities, nativeMetadataSkills.capabilities],
	);
	const nativeMetadataScopeKey = JSON.stringify([
		identityKey,
		agentId,
		conversationId,
		latestExecution ?? null,
	]);
	const nativeMetadataLoading =
		latestExecution !== undefined &&
		(nativeMetadataCommands.isPending || nativeMetadataSkills.isPending);
	const nativeMetadataUnavailable =
		latestExecution !== undefined &&
		!nativeMetadataLoading &&
		!nativeMetadataCommands.available &&
		!nativeMetadataSkills.available &&
		(nativeMetadataCommands.isError || nativeMetadataSkills.isError);
	const nativeMetadataPartiallyUnavailable =
		latestExecution !== undefined &&
		!nativeMetadataLoading &&
		nativeMetadataCommands.available !== nativeMetadataSkills.available;
	const nativeMetadataReady =
		latestExecution !== undefined &&
		nativeMetadataCommands.available &&
		nativeMetadataSkills.available;
	const active = Boolean(latestExecution && !isTerminal(status));
	const visibleNotice =
		notice ||
		(stopping && stopping === latestExecution
			? isTerminal(status)
				? "原回复已结束。"
				: "停止请求已受理，正在等待停止确认。已发生的外部操作不会自动撤回。"
			: active && acceptedExecution === latestExecution
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
	const files = useConversationFiles({
		conversationId,
		attachmentsEnabled: agent.capabilities.attachments,
		resultFilesEnabled: agent.capabilities.resultFiles,
	});
	const mismatched = Boolean(conversation && conversation.agentId !== agentId);
	const denied = timeline.status === "denied" || command.isDenied || mismatched;
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
		} else if (result.kind === "selection-updated") {
			// Keep the confirmed values while the projection refreshes; falling back
			// to the stale conversation would briefly show and submit the old choice.
			setNotice("模型选择已保存，从下一条消息开始生效。");
			void reader.refresh();
		} else if (result.kind === "native-accepted") {
			action.current = "native";
			setNotice(
				result.outcome === "replayed" ? "能力请求已恢复。" : "能力请求已受理。",
			);
			void reader.refresh();
		} else if (result.kind === "native-rejected") {
			setNotice(`能力请求未受理：${result.outcome}`);
		} else if (result.kind === "browser-accepted") {
			setNotice(
				result.receipt.outcome === "replayed"
					? "Browser 命令已恢复。"
					: "Browser 命令已受理。",
			);
			void reader.refresh();
		}
	}, [command.result, reader.refresh, refreshAgent]);
	const options = customPlatformAdapter
		? (runtimeSelection.data?.options ?? [])
		: agent.configuration.modelOptions;
	const runtimeSelectionUnavailable =
		customPlatformAdapter && !runtimeSelection.data?.available;
	const currentModelId =
		modelId ??
		conversation?.selectedModelOptionId ??
		(customPlatformAdapter
			? (runtimeSelection.data?.currentModelOptionId ?? "")
			: (agent.configuration.defaultModelOptionId ?? ""));
	const option = options.find((item) => item.optionId === currentModelId);
	const currentReasoning =
		reasoning ??
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
	const draftDisabled =
		denied ||
		commandLocked ||
		!timeline.history ||
		conversation?.status === "unavailable" ||
		readLocked ||
		(!available && !agentTransitioning);
	const selectionDirty =
		(modelId !== undefined &&
			modelId !== conversation?.selectedModelOptionId) ||
		(reasoning !== undefined &&
			reasoning !== conversation?.selectedReasoningLevel);
	const canSend =
		!blocked &&
		!preparing &&
		!commandLocked &&
		!selectionDirty &&
		!uncertainExecution &&
		!(active && stopping === latestExecution) &&
		(!active || agent.capabilities.supplementaryInstruction) &&
		!files.uploading &&
		Boolean(draft.trim());
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
	return (
		<>
			{latestExecution &&
				(nativeMetadataUnavailable ||
					nativeMetadataPartiallyUnavailable ||
					(nativeMetadataReady && nativeMetadataCapabilities.length > 0)) && (
					<div aria-live="polite">
						{nativeMetadataUnavailable && (
							<Alert role="status">
								<AlertDescription>
									当前执行的命令或 Skill 暂不可用，已隐藏旧数据。
								</AlertDescription>
							</Alert>
						)}
						{nativeMetadataPartiallyUnavailable && (
							<Alert role="status">
								<AlertDescription>
									部分命令或 Skill 目录暂不可用，已隐藏对应旧数据。
								</AlertDescription>
							</Alert>
						)}
						{nativeMetadataReady && nativeMetadataCapabilities.length > 0 && (
							<ConversationCapabilityPickerPanel
								key={nativeMetadataScopeKey}
								capabilities={nativeMetadataCapabilities}
								scopeKey={nativeMetadataScopeKey}
								disabled={!available}
								onConfirm={(selection: ConversationCapabilitySelectionV1) => {
									if (!selection.capabilityId || !selection.directoryRevision)
										return;
									command.invokeCapability({
										capabilityId: selection.capabilityId,
										directoryRevision: selection.directoryRevision,
										parameters: selection.parameterText,
									});
								}}
							/>
						)}
					</div>
				)}
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
				{agent.capabilities.modelSelection &&
					(!customPlatformAdapter || runtimeSelection.data?.available) && (
						<fieldset
							className="model-controls"
							disabled={blocked || commandLocked}
						>
							<legend className="sr-only">下一条消息的模型</legend>
							<div className="min-w-0 space-y-1">
								<Label className="sr-only" htmlFor={`${composerId}-model`}>
									模型
								</Label>
								<Select
									disabled={blocked || commandLocked}
									value={currentModelId || null}
									itemToStringLabel={(value) =>
										(!option && value === currentModelId
											? "当前选项已移除"
											: options.find((item) => item.optionId === value)
													?.displayName) ?? String(value)
									}
									onValueChange={(value) => {
										if (!value) return;
										setModelId(value);
										setReasoning(
											options.find((item) => item.optionId === value)
												?.reasoningLevels[0],
										);
									}}
								>
									<SelectTrigger
										id={`${composerId}-model`}
										className="min-h-11 w-full text-base md:text-sm"
									>
										<SelectValue placeholder="请选择模型" />
									</SelectTrigger>
									<SelectContent>
										{!option && currentModelId && (
											<SelectItem value={currentModelId} disabled>
												当前选项已移除
											</SelectItem>
										)}
										{options.map((item) => (
											<SelectItem key={item.optionId} value={item.optionId}>
												{item.displayName}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="min-w-0 space-y-1">
								<Label className="sr-only" htmlFor={`${composerId}-reasoning`}>
									推理强度
								</Label>
								<Select
									disabled={blocked || commandLocked}
									value={currentReasoning || null}
									onValueChange={(value) => setReasoning(value ?? undefined)}
								>
									<SelectTrigger
										id={`${composerId}-reasoning`}
										className="min-h-11 w-full text-base md:text-sm"
									>
										<SelectValue placeholder="请选择推理强度" />
									</SelectTrigger>
									<SelectContent>
										{option?.reasoningLevels.map((value) => (
											<SelectItem key={value} value={value}>
												{value}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<Button
								type="button"
								variant="default"
								className="model-save"
								hidden={!selectionDirty}
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
					className="composer-zone composer"
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
					<ConversationFilePicker
						attachmentsEnabled={agent.capabilities.attachments}
						limits={files.limits}
						limitsError={files.limitsError}
						uploads={files.uploads}
						onSelect={(selected) => void files.addFiles(selected)}
						onRemove={files.remove}
						onRetry={files.retry}
					/>
					<Label className="sr-only" htmlFor={composerId}>
						消息
					</Label>
					<Textarea
						ref={composer}
						id={composerId}
						rows={3}
						value={draft}
						disabled={draftDisabled}
						placeholder={`给 ${agent.name} 发一条消息…`}
						onFocus={(event) => {
							const input = event.currentTarget;
							const bounds = input.getBoundingClientRect();
							// Browsers may reveal only the caret when returning from execution details.
							if (bounds.top < 0 || bounds.bottom > window.innerHeight)
								input.scrollIntoView({ block: "nearest" });
						}}
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
