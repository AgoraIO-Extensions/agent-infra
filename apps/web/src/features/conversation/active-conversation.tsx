import { useQueryClient } from "@tanstack/react-query";
import { Square } from "lucide-react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { LoadingLine } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { pageRecoveryTarget } from "@/hooks/use-recovery-focus";
import { distinctObjectNames } from "@/lib/accessible-name";
import { Button } from "../../components/ui/button.js";
import type { BrowserSessionProjectionV1 } from "../../pilot/generated/types.gen.js";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import {
	markUserRead,
	queryUserReading,
	readFailed,
} from "../background-read.js";
import { formatPerson } from "../directory-names.js";
import { RecoveryButton } from "../recovery-button.js";
import { BrowserActivityCard } from "./browser-activity-card.js";
import {
	type BrowserCard,
	type BrowserCardCommand,
	selectBrowserCard,
} from "./browser-card.js";
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
	BrowserContextHint,
	type ConnectionNoticeState,
	ConversationConnectionNotice,
	ConversationContextBar,
	ConversationFilesBar,
} from "./conversation-context-bar.js";
import {
	ConversationFilePicker,
	useConversationFiles,
} from "./conversation-files.js";
import { ConversationExecutionDetails } from "./conversation-screen-details.js";
import { ConversationMessages } from "./conversation-screen-messages.js";
import {
	currentExecution,
	executionStatus,
	hasWaitingMessages,
	isTerminal,
	queueStates,
} from "./conversation-screen-state.js";
import { useSkillControlFiles } from "./conversation-skill-control-files.js";
import { ConversationReadError } from "./execution-detail.js";
import { useAmbiguousDenial } from "./use-ambiguous-denial.js";
import { useConversationCapabilityCatalog } from "./use-conversation-capability-catalog.js";
import { useConversationCommands } from "./use-conversation-commands.js";
import {
	type ModelSelectionValue,
	useConversationModelAutosave,
} from "./use-conversation-model-autosave.js";
import { useConversationModelSelection } from "./use-conversation-model-selection.js";
import { useConversationTimeline } from "./use-conversation-timeline.js";

// Readiness is still authoritative on the server; a short bounded poll keeps
// the composer responsive while the Worker finishes the Session Sandbox.
const preparingRefreshMs = 500;

/**
 * 执行详情与 Runtime 模型目录读取：网络与服务失败可以重试；无权、其余 HTTP 与响应无效不可重试
 * （执行详情由时间线接手）。
 */
function retryableExecutionRead(error: unknown) {
	return (
		!(error instanceof ConversationReadError) ||
		error.failure.kind === "network" ||
		error.failure.kind === "service"
	);
}

/** 浏览器卡只给出不透明 ID；服务端命令请求体只在这里构造。停止操作走现有的停止回复命令。 */
export function browserCommandBody(
	command: Exclude<BrowserCardCommand, { kind: "stop_execution" }>,
): BrowserCommandBody {
	if ("confirmationId" in command)
		return {
			schemaVersion: 1,
			command: command.kind,
			confirmationId: command.confirmationId,
		};
	return {
		schemaVersion: 1,
		command: command.kind,
		handoffId: command.handoffId,
	};
}

/**
 * 浏览器卡所处的阶段（阶段、状态与本阶段操作）。命令受理后回读到的卡片与发出命令时不同，
 * 就是推进到了下一阶段（G5-04）。
 */
function browserCardStage(card: BrowserCard | undefined) {
	if (!card) return "none";
	return [
		card.phase,
		card.status,
		...card.actions.map((action) => action.label),
	].join("\u0000");
}

/**
 * 新会话页（/chat/:agentId）交给刚创建的会话的首条消息（CH-10）：
 * - text：原草稿，作为新会话 composer 的初始草稿；
 * - send：用户已经按下发送，会话可以发送时自动发送一次；
 * - model：新会话页选择的模型与档位，发送前先保存到新会话。
 */
export type FirstMessageHandoff = Readonly<{
	text: string;
	send: boolean;
	model?: ModelSelectionValue;
}>;

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
	session,
	connectionUrl,
	firstMessage,
	onFirstMessageTaken,
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
	/** 当前登录会话：用户消息显示真实姓名（CH-08）。 */
	session?: BrowserSessionProjectionV1;
	/** 「我的 Connection」受控入口（BR-04）。 */
	connectionUrl?: string;
	/** 新会话页交来的首条消息，只在挂载时读取一次。 */
	firstMessage?: FirstMessageHandoff;
	/** 已接收 firstMessage：调用方随即清除，重新进入同一会话不会再次自动发送。 */
	onFirstMessageTaken?: () => void;
}) {
	const queryClient = useQueryClient();
	const toast = useToast();
	const [selectedExecution, setSelectedExecution] = useState<string>();
	const executionTrigger = useRef<HTMLButtonElement>(null);
	// 关闭执行详情：触发控件还在就回到它，否则回到页头标题（例如待核实的执行已转为终态）。
	const executionFinalFocus = useCallback(() => {
		const trigger = executionTrigger.current;
		executionTrigger.current = null;
		if (trigger?.isConnected && !trigger.disabled) return trigger;
		return focusFallback?.current ?? null;
	}, [focusFallback]);
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
	// 执行详情的用户发起读取（「重新读取详情」「核实原执行状态」）记在这里：弹窗打开时回到标签页、
	// 时间线刷新带来的后台重读不显示读取行与失败提示，已显示的详情保留（#3387）。
	const executionRead = useRef({}).current;
	const [draft, setDraft] = useState(firstMessage?.text ?? "");
	// 首条消息只在本次挂载内自动发送一次；草稿被改写或会话进入不可发送的状态时改为手动发送。
	const firstSend = useRef(firstMessage?.send ? firstMessage.text : undefined);
	const [firstSendPending, setFirstSendPending] = useState(
		firstSend.current !== undefined,
	);
	// 新会话页选择的模型先保存到本会话，保存完成前不自动发送。
	const firstModel = useRef(firstMessage?.model);
	const [firstModelPending, setFirstModelPending] = useState(
		firstModel.current !== undefined,
	);
	// 从新会话页跳转过来时焦点留在 composer，直到首条消息处理完（见下方聚焦 effect）。
	const keepComposerFocus = useRef(firstMessage !== undefined);
	// 首条消息是否已自动发出：发出后要等提交结果回来、输入框重新可编辑时再放回焦点。
	const firstSendSent = useRef(false);
	const firstMessageTaken = useRef(onFirstMessageTaken);
	useLayoutEffect(() => {
		firstMessageTaken.current?.();
		firstMessageTaken.current = undefined;
	}, []);
	// 已提交消息的正文：受理后只在草稿仍等于它时清空，重试期间改写的草稿不丢（NI-91）。
	const sentText = useRef<string | undefined>(undefined);
	const resending = useRef(false);
	const [notice, setNotice] = useState("");
	// 会话级 Connection 提示状态，不随上下文条收起丢失（BR-04、NI-87）。
	const [connectionNotice, setConnectionNotice] =
		useState<ConnectionNoticeState>("needs-auth");
	const [acceptedExecution, setAcceptedExecution] = useState<string>();
	const [stopping, setStopping] = useState<string>();
	// 撤回请求进行中的排队消息（#3376）：它的「撤回」保持可聚焦的禁用。
	const [withdrawing, setWithdrawing] = useState<string>();
	// 「重新生成」请求进行中的提问与受理后的焦点交接（#3267 N8-1-09，见 regenerate()）。
	const [regenerating, setRegenerating] = useState<string>();
	const regenerateFocus = useRef<{ executionId?: string }>(undefined);
	const [selectionDenied, setSelectionDenied] = useState(false);
	// 本页内受理的命令 / Skill 调用；回执阶段由各自 Execution 的状态推导（CK-01）。
	const [invocations, setInvocations] = useState<CapabilityInvocation[]>([]);
	const pendingInvocation =
		useRef<Omit<CapabilityInvocation, "executionId">>(undefined);
	const composerId = useId();
	const feedbackId = useId();
	const composer = useRef<HTMLTextAreaElement>(null);
	const action = useRef<
		"message" | "stop" | "regenerate" | "native" | "withdraw"
	>("message");
	const handled = useRef<ConversationCommandResult | undefined>(undefined);
	const conversation = timeline.history?.conversation;
	// The Conversation stays read-only until its own Session Sandbox is ready
	// (PRD §6.4, Spec §10.1.1); the draft remains editable meanwhile (#1534).
	// An upgrading Sandbox is shown as "更新中" (PRD, ADR 0023).
	const updating = timeline.history?.sessionAvailability === "updating";
	const preparing =
		updating || timeline.history?.sessionAvailability === "preparing";
	// 排队消息（§12.5）不是当前回复；位次与结果显示在各自的用户消息上。
	const queue = useMemo(
		() => queueStates(timeline.history, timeline.events),
		[timeline.history, timeline.events],
	);
	const queueWaiting = hasWaitingMessages(queue);
	const { executionId: latestExecution, status } = currentExecution(
		timeline.history,
		timeline.events,
		acceptedExecution,
		queue,
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
	// 受理与停止的后续状态显示在对应回复卡内，不再在卡外重复（R4-07）。
	const [stopNotice, setStopNotice] = useState<{
		executionId: string;
		text: string;
	}>();
	const executionNotice =
		stopping && stopping === latestExecution && !isTerminal(status)
			? {
					executionId: stopping,
					text: "停止请求已受理，正在等待停止确认。已发生的外部操作不会自动撤回。",
				}
			: stopNotice;
	// 停止请求受理后原回复进入终态（Z-14）：确认已停止时用 Toast「回复已停止」补充确认，
	// 回复卡状态行给出「已停止 · 可重新生成」；停止生效前已完成或失败的，在该回复卡说明
	// 「原回复已结束。」（#1524）。
	useEffect(() => {
		if (!stopping || stopping !== latestExecution || !isTerminal(status))
			return;
		setStopping(undefined);
		if (status === "cancelled") toast("回复已停止");
		else setStopNotice({ executionId: stopping, text: "原回复已结束。" });
	}, [stopping, latestExecution, status, toast]);
	// A2-09：「停止回复」随处理中卡片卸载后焦点不能落到 body。发出停止时记下目标 Execution；它不再
	// 进行中（停止确认、原回复已结束或已换成新的回复）时，若焦点已落到 body，就移到该回复卡状态行的
	// 「重新生成」，没有可用的「重新生成」时移到输入框，再没有就交给页面标题（与弹窗焦点看护同一兜底）。
	// 用户按下指针或把焦点移到别处后不再代管。
	// G4-08：从浏览器卡「停止操作」（或接管卡「停止」）停止时，该按钮随停止受理卸载：先把焦点交给对应
	// 回复卡的「正在停止」（aria-disabled 仍可聚焦），停止确认后优先交给浏览器卡「查看操作记录」。
	const [stopFocus, setStopFocus] = useState<string>();
	const stopFromBrowser = useRef(false);
	useEffect(() => {
		if (!stopFocus) return;
		const release = () => setStopFocus(undefined);
		document.addEventListener("pointerdown", release, true);
		return () => document.removeEventListener("pointerdown", release, true);
	}, [stopFocus]);
	useEffect(() => {
		if (!stopFocus || (stopFocus === latestExecution && !isTerminal(status)))
			return;
		setStopFocus(undefined);
		const fromBrowser = stopFromBrowser.current;
		stopFromBrowser.current = false;
		const focused = document.activeElement;
		if (focused && focused !== document.body) return;
		const records = fromBrowser
			? document.querySelector<HTMLButtonElement>(
					"section.browser-capability [data-browser-records]",
				)
			: null;
		const regenerate = [
			...document.querySelectorAll<HTMLButtonElement>(
				"[data-regenerate-execution]",
			),
		].find(
			(button) =>
				button.dataset.regenerateExecution === stopFocus && !button.disabled,
		);
		const input = composer.current?.disabled ? null : composer.current;
		(records ?? regenerate ?? input ?? pageRecoveryTarget())?.focus();
	}, [stopFocus, latestExecution, status]);
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
	// Runtime 模型目录读到过之后，后台重读（回到标签页）的可重试失败继续用最近一次读到的目录；不可重试的
	// 失败（登录失效、无权、不存在、响应无效）与首次读取失败一致：不再列出旧目录，发送随之阻止（#3433）。
	const runtimeSelectionShown = readFailed(
		runtimeSelection,
		retryableExecutionRead,
	)
		? undefined
		: runtimeSelection.data;
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
		agentId,
		conversationId,
		attachmentsEnabled: agent.capabilities.attachments,
		resultFilesEnabled: agent.capabilities.resultFiles,
	});
	// Skill 控制文件与普通附件共用同一套会话文件限制和上传授权，但只随 Invocation V2 提交。
	const skillFiles = useSkillControlFiles({
		conversationId,
		limits: files.limits,
		enabled: agent.capabilities.attachments,
	});
	const skillSelection =
		capability.selected?.kind === "skill"
			? capability.selected.identity
			: undefined;
	const clearSkillFiles = skillFiles.clear;
	useEffect(() => {
		// 换选或清除 Skill 后，旧调用选的控制文件不再属于当前待发送内容。
		clearSkillFiles();
	}, [skillSelection, clearSkillFiles]);
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
	// Agent 确实不可用时保留草稿并只由页顶横幅说明；仍然可用才按失去访问权限处理（#2570、NW-13）。
	const denialPhase = useAmbiguousDenial({
		result: command.result,
		available,
		verifyAgent,
		onDenialStands: command.confirmDenied,
	});
	const lastRefreshEvent = useRef<string | undefined>(undefined);
	useEffect(() => {
		// 平台写入的 task.status 改变排队集合（入队、开始处理、撤回、超时与取消，§12.5）：
		// 重读投影取得服务端位次与结果。
		const event = timeline.events.findLast(
			(item) =>
				item.type === "conversation.error" ||
				item.type === "task.status" ||
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
		// 结果待核实时请求仍算进行中，「重新生成」继续保持可聚焦的禁用；其余结果结束进行中。
		// 只处理重新生成自己的结果：同一时间只有一条命令在途，其他命令的结果不改变它。
		if (action.current === "regenerate") {
			if (result.kind !== "unknown") setRegenerating(undefined);
			if (regenerateFocus.current) {
				if (result.kind === "accepted")
					regenerateFocus.current = {
						executionId: result.receipt.executionId ?? undefined,
					};
				// 被拒绝：按钮一直挂载，焦点仍在「重新生成」上，不需要代管。
				else if (result.kind !== "unknown") regenerateFocus.current = undefined;
			}
		}
		// 撤回同样：结果待核实时「撤回」继续保持可聚焦的禁用，可核实原请求。
		if (action.current === "withdraw" && result.kind !== "unknown")
			setWithdrawing(undefined);
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
					const target = result.receipt.executionId ?? latestExecution;
					if (target)
						setStopNotice({ executionId: target, text: "原回复已结束。" });
					else setNotice("原回复已结束。");
				} else setStopping(result.receipt.executionId ?? undefined);
			} else {
				// 有当前回复或排队消息时受理的新 Execution 是排队消息（§12.5）：它不是当前回复，
				// 位次由随后的投影给出；补充指令的回执就是当前回复本身。
				const queued =
					action.current === "message" &&
					(active || queueWaiting) &&
					result.receipt.executionId !== null &&
					result.receipt.executionId !== latestExecution;
				if (action.current === "message") {
					const sent = sentText.current;
					sentText.current = undefined;
					setDraft((current) => (current === sent ? "" : current));
					if (resending.current) toast("已重新发送，正在等待 Agent 确认");
				}
				if (!queued)
					setAcceptedExecution(result.receipt.executionId ?? undefined);
			}
			resending.current = false;
			void reader.refresh();
		} else if (result.kind === "withdrawal") {
			// 撤回与认领互斥：已开始处理或已结束的消息不受影响，只说明原因（§12.5）。
			if (result.receipt.status === "already_started")
				toast("消息已开始处理，不能撤回");
			else if (result.receipt.status === "already_finished")
				toast("消息已结束，无需撤回");
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
			// 浏览器卡自身的阶段变化就是反馈，不再额外显示受理提示（BR-02）。
			setNotice("");
			void reader.refresh();
		}
	}, [
		command.result,
		reader.refresh,
		refreshAgent,
		capabilityAccepted,
		setCapabilityError,
		latestExecution,
		active,
		queueWaiting,
		toast,
	]);
	const options = customPlatformAdapter
		? (runtimeSelectionShown?.options ?? [])
		: agent.configuration.modelOptions;
	const runtimeSelectionUnavailable =
		customPlatformAdapter && !runtimeSelectionShown?.available;
	const currentModelId =
		modelSave.desired?.modelOptionId ??
		conversation?.selectedModelOptionId ??
		(customPlatformAdapter
			? (runtimeSelectionShown?.currentModelOptionId ?? "")
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
	// 提交进行中（commandLocked）草稿同样不可编辑，但输入框只读而不是禁用，焦点不落到 body
	// （#3242 K7-02）；其余原因仍为原生禁用。
	const draftLocked =
		denied ||
		!timeline.history ||
		conversation?.status === "unavailable" ||
		readLocked ||
		(!available && !agentTransitioning);
	// 当前回复处理中、正在停止或结果待核实时仍可发送：服务端在受理时原子地决定作为补充指令、
	// 进入排队或繁忙（PRD 10.5、§12.5），页面不预先拦截。
	const submitReady =
		!blocked &&
		!preparing &&
		!commandLocked &&
		modelSave.phase === "idle" &&
		!files.uploading &&
		!capabilityBusy;
	const canSend = submitReady && Boolean(draft.trim());
	async function send(options: { resend?: boolean } = {}) {
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
			sentText.current = draft;
			// 「重新发送」受理后用 Toast 补充确认（G-04）。
			resending.current = options.resend === true;
			setNotice("");
			setStopNotice(undefined);
		}
	}
	// 新会话页选择的模型：投影读到后保存到本会话；与当前选择相同时不发请求（CH-10）。
	const chooseModel = modelSave.choose;
	useEffect(() => {
		const value = firstModel.current;
		if (!value || !timeline.history) return;
		firstModel.current = undefined;
		setFirstModelPending(false);
		if (
			value.modelOptionId !== currentModelId ||
			value.reasoningLevel !== currentReasoning
		)
			chooseModel(value);
	}, [timeline.history, currentModelId, currentReasoning, chooseModel]);
	// 新会话页按下发送的首条消息：模型保存完成、会话可以发送时自动发送一次。草稿被改写、
	// 失去访问、会话或 Agent 不可用、模型保存失败时不再自动发送，草稿保留给用户手动处理。
	useEffect(() => {
		const text = firstSend.current;
		if (text === undefined) return;
		const abandoned =
			draft !== text ||
			denied ||
			conversation?.status === "unavailable" ||
			readLocked ||
			(!available && !agentTransitioning) ||
			modelSave.phase === "error" ||
			modelSave.failure !== undefined;
		if (!abandoned && (firstModelPending || !canSend)) return;
		firstSend.current = undefined;
		setFirstSendPending(false);
		if (abandoned) return;
		firstSendSent.current = true;
		void send();
	});
	// 从新会话页跳转过来时焦点留在 composer：输入框可编辑而焦点已丢失（落在 body）时聚焦。
	// 自动发送期间输入框只读而不是禁用（#3242 K7-02），同样可以接过焦点；提交有了结果后不再代管，
	// 用户主动移走焦点时不抢回。
	useEffect(() => {
		if (!keepComposerFocus.current || draftLocked) return;
		const focused = document.activeElement;
		if (!focused || focused === document.body) composer.current?.focus();
		if (
			firstSend.current === undefined &&
			(!firstSendSent.current || command.result !== undefined)
		)
			keepComposerFocus.current = false;
	});
	const invokeCapability = useCallback(
		(
			body: Parameters<typeof command.invokeCapability>[0],
			selected: Omit<CapabilityInvocation, "executionId">,
		) => {
			if (!command.invokeCapability(body)) return;
			action.current = "native";
			const controlFiles = skillFiles.entries.map((entry) => entry.file.name);
			pendingInvocation.current = {
				kind: selected.kind,
				name: selected.name,
				source: selected.source,
				version: selected.version,
				...(controlFiles.length > 0 ? { controlFiles } : {}),
			};
			setNotice("");
		},
		[command.invokeCapability, skillFiles.entries],
	);
	// #3267 N8-1-09：「重新生成」请求进行中，该提问的「重新生成」保持可聚焦的禁用（不随整页锁定卸载）；
	// 受理后它随原回答换成处理中的回复卡而卸载，焦点交给新回复卡的「停止回复」（设计
	// focusAfterRender），没有时交给输入框，再没有时交给页面标题。用户按下指针后不再代管。
	useEffect(() => {
		const release = () => {
			regenerateFocus.current = undefined;
		};
		document.addEventListener("pointerdown", release, true);
		return () => document.removeEventListener("pointerdown", release, true);
	}, []);
	useLayoutEffect(() => {
		const target = regenerateFocus.current;
		if (!target || !("executionId" in target)) return;
		const focused = document.activeElement;
		const lost = !focused || focused === document.body || !focused.isConnected;
		const stop = [
			...document.querySelectorAll<HTMLButtonElement>("[data-stop-execution]"),
		].find((button) => button.dataset.stopExecution === target.executionId);
		if (stop) {
			regenerateFocus.current = undefined;
			if (lost || focused?.hasAttribute("data-regenerate-execution"))
				stop.focus();
			return;
		}
		// 受理后「重新生成」还在（新回复卡尚未出现）时继续等；焦点已被移到别处时不抢。
		if (!lost) {
			if (!focused?.hasAttribute("data-regenerate-execution"))
				regenerateFocus.current = undefined;
			return;
		}
		regenerateFocus.current = undefined;
		const input = composer.current?.disabled ? null : composer.current;
		(input ?? pageRecoveryTarget())?.focus();
	});
	function regenerate(messageId: string) {
		if (blocked || preparing || commandLocked || active || queueWaiting) return;
		if (command.regenerate(messageId)) {
			action.current = "regenerate";
			setRegenerating(messageId);
			regenerateFocus.current = {};
			setNotice("");
		}
	}
	// 对话页只有一张浏览器卡（BR-01）。空闲卡放在默认收起的会话上下文里；一旦当前 Execution
	// 有浏览器活动（请求、接管、执行中与终态），卡片移到会话时间线末尾，不会被折叠隐藏（NI-83）。
	// 空闲只取决于当前 Execution 有没有浏览器事件，与时间无关，两处判断不会错开。
	const browserCapability = agent.capabilities.browser;
	const browserAvailable = browserCapability?.status === "available";
	const browserCard =
		browserCapability === undefined
			? undefined
			: selectBrowserCard({
					events: timeline.events,
					conversationId,
					executionId: latestExecution,
					browserAvailable,
					now: Date.now(),
				});
	const browserIdle = browserCard?.phase === "idle";
	const browserStage = browserCardStage(browserCard);
	// G5-04：「接管浏览器」「交还给 Agent」「允许这次操作」「拒绝」「停止接管」受理并回读到下一阶段后，
	// 触发按钮随旧阶段卸载。发出命令时记下当时的阶段；回读到的卡片换了阶段时，若焦点在 body 或仍在
	// 卡片内，按设计交给下一步操作：新卡的第一个操作（接管浏览器 / 交还给 Agent / 停止操作），终态
	// 交给「查看操作记录」，都没有时同停止回复的兜底（输入框 → 页面标题）。命令没有受理、用户按下
	// 指针或焦点已在卡片外时不再代管。
	const [browserFocus, setBrowserFocus] = useState<string>();
	useEffect(() => {
		if (!browserFocus) return;
		const release = () => setBrowserFocus(undefined);
		document.addEventListener("pointerdown", release, true);
		return () => document.removeEventListener("pointerdown", release, true);
	}, [browserFocus]);
	useEffect(() => {
		const result = command.result;
		if (result && result.kind !== "browser-accepted")
			setBrowserFocus(undefined);
	}, [command.result]);
	useEffect(() => {
		if (!browserFocus || browserFocus === browserStage) return;
		setBrowserFocus(undefined);
		const card = document.querySelector<HTMLElement>(
			".chat-thread .timeline section.browser-capability",
		);
		const focused = document.activeElement;
		if (focused && focused !== document.body && !card?.contains(focused))
			return;
		const next =
			card?.querySelector<HTMLButtonElement>("[data-browser-action]") ??
			card?.querySelector<HTMLButtonElement>("[data-browser-records]");
		const input = composer.current?.disabled ? null : composer.current;
		(next ?? input ?? pageRecoveryTarget())?.focus();
	}, [browserFocus, browserStage]);
	if (denied)
		return (
			<Alert tone="danger" role="alert">
				<AlertDescription>访问权限已失效。</AlertDescription>
			</Alert>
		);
	const modelSelectable =
		agent.capabilities.modelSelection &&
		(!customPlatformAdapter || runtimeSelectionShown?.available);
	// 发送按钮文案与说明只按页面已知状态预告服务端的判定（§12.5）：原回复已开始处理、没有待确认的
	// 停止、也没有排队消息时，支持补充指令的 Agent 接收补充指令；其余情况进入排队。
	const supplementExpected =
		active &&
		status === "processing" &&
		agent.capabilities.supplementaryInstruction &&
		!capabilityExecution &&
		stopping !== latestExecution &&
		!queueWaiting;
	// 排队说明只在草稿非空时作为发送按钮的说明出现（R4-07、AC-7）。
	const queueOnSend =
		(active || queueWaiting) && !supplementExpected && Boolean(draft.trim());
	const stopControl =
		active && latestExecution
			? {
					executionId: latestExecution,
					label: stopping === latestExecution ? "正在停止" : "停止回复",
					disabled: blocked || commandLocked || stopping === latestExecution,
					onStop: () => {
						if (command.stop()) {
							action.current = "stop";
							stopFromBrowser.current = false;
							setStopNotice(undefined);
							setStopFocus(latestExecution);
						}
					},
				}
			: undefined;
	// G4-08：浏览器卡的停止走同一条停止命令；受理前浏览器卡按钮先被禁用、随后卸载，所以在发出时就把
	// 焦点交给回复卡（或调用回执后）的停止按钮，它在「正在停止」期间仍可聚焦。
	const stopFromBrowserCard = () => {
		if (!stopControl || !command.stop()) return;
		action.current = "stop";
		stopFromBrowser.current = true;
		setStopNotice(undefined);
		setStopFocus(stopControl.executionId);
		[...document.querySelectorAll<HTMLButtonElement>("[data-stop-execution]")]
			.find(
				(button) => button.dataset.stopExecution === stopControl.executionId,
			)
			?.focus();
	};
	// 同一命令 / Skill 调用多次时回执按钮仍可区分（N-12）。
	const receiptNames = distinctObjectNames(
		invocations.map((invocation) => invocation.name),
	);
	const onBrowserCommand = (browserCommand: BrowserCardCommand) => {
		// 「停止操作」走与「停止回复」相同的停止命令。
		if (browserCommand.kind === "stop_execution") stopFromBrowserCard();
		else if (command.invokeBrowser(browserCommandBody(browserCommand)))
			setBrowserFocus(browserStage);
	};
	const browserCardProps = {
		events: timeline.events,
		conversationId,
		executionId: latestExecution,
		browserAvailable,
		busy: blocked || commandLocked,
		canStop: active && stopping !== latestExecution,
		onCommand: onBrowserCommand,
		viewer: session?.user,
	};
	return (
		<>
			<div className="chat-thread space-y-5">
				{/* 设计 renderChatContext：只在有 Connection 或浏览器能力时出现，位于时间线之上（CH-03）。 */}
				<ConversationContextBar
					connection={agent.capabilities.connection}
					browser={browserCapability !== undefined}
				>
					{agent.capabilities.connection && (
						<ConversationConnectionNotice
							url={connectionUrl}
							state={connectionNotice}
							onOpen={() => {
								setConnectionNotice("handoff");
								toast("已转到独立 Connection 入口；完成授权后返回此会话");
							}}
						/>
					)}
					{browserCapability &&
						(browserIdle ? (
							<BrowserActivityCard includeIdle {...browserCardProps} />
						) : (
							<BrowserContextHint />
						))}
				</ConversationContextBar>
				{timeline.status === "loading" && !timeline.history && (
					<LoadingLine>正在读取会话…</LoadingLine>
				)}
				{/* 说明行与输入框上方同级说明同为 text-sm（14px / 20px），不继承正文 15px（#3293 N9-1-01）。 */}
				{timeline.status === "reconnecting" && (
					<p role="status" className="text-sm">
						会话连接中断，正在自动重新连接，草稿会保留。
					</p>
				)}
				{(timeline.status === "disconnected" ||
					timeline.status === "unavailable") && (
					<Alert tone="warn" role="alert">
						<AlertDescription>
							{readLocked
								? "会话连接暂时中断，草稿已保留。重新连接只恢复读取，不重新发送任务。"
								: "会话连接暂时中断，草稿已保留，恢复后会自动继续读取；也可手动重新连接。重新连接只恢复读取，不重新发送任务。"}
						</AlertDescription>
						<AlertAction>
							{/* 重连开始即换成「正在自动重新连接」状态行、按钮卸载：焦点交给页面 h1，仍断开时
							    回到按钮（RecoveryButton，#3269 N8-3-02）。 */}
							<RecoveryButton
								variant="outline"
								recoveryKey="重新连接"
								onClick={() => reader.reconnect()}
							>
								重新连接
							</RecoveryButton>
						</AlertAction>
					</Alert>
				)}
				{/* 静态说明：进入页面即可见，不打断读屏（B-10）。 */}
				{conversation?.status === "unavailable" && (
					<Alert tone="warn">
						<AlertDescription>
							当前会话不可用，历史只读。请使用上方入口明确新建会话。
						</AlertDescription>
					</Alert>
				)}
				{timeline.history && (
					<ConversationMessages
						agentName={agent.name}
						userName={
							formatPerson({ displayName: session?.user.displayName }).name
						}
						history={timeline.history}
						events={timeline.events}
						// 命令 / Skill 调用由调用回执说明状态，不再另画一张处理中的回复卡。
						current={
							capabilityExecution
								? undefined
								: { executionId: latestExecution, status }
						}
						onExecution={openExecution}
						onRegenerate={regenerate}
						canRegenerate={
							!blocked &&
							!preparing &&
							!commandLocked &&
							!active &&
							!queueWaiting
						}
						regeneratingMessageId={commandLocked ? regenerating : undefined}
						onResend={(text) => {
							setDraft(text);
							setNotice("请确认草稿后手动发送；不会自动提交。");
							composer.current?.focus();
						}}
						onDownloadFile={files.download}
						onPreviewFile={files.readResultFile}
						onReadInlineFile={files.readInlineResultFile}
						downloadingFileId={files.downloading}
						previewingFileId={files.reading}
						hasEarlier={timeline.hasEarlier}
						earlierLoading={timeline.earlierLoading}
						earlierFailure={timeline.earlierFailure !== null}
						onLoadEarlier={() => void reader.loadEarlier()}
						stop={capabilityExecution ? undefined : stopControl}
						executionNotice={executionNotice}
						withdraw={{
							onWithdraw: (executionId) => {
								if (blocked || commandLocked) return;
								if (command.withdraw(executionId)) {
									action.current = "withdraw";
									setWithdrawing(executionId);
									setNotice("");
								}
							},
							pendingExecutionId: commandLocked ? withdrawing : undefined,
							disabled: blocked || commandLocked,
						}}
						modelOptions={options}
						trailing={
							<>
								{invocations.map((invocation, index) => (
									<CapabilityReceipt
										key={invocation.executionId}
										invocation={invocation}
										objectName={receiptNames[index]}
										phase={invocationPhase(invocation.executionId)}
										onDetails={() => openExecution(invocation.executionId)}
										onVerify={() => {
											void reader.refresh();
											openExecution(invocation.executionId);
										}}
									/>
								))}
								{/* 设计 .skill-actions：调用进行中时回执之后的「停止回复」（R4-07）。 */}
								{capabilityExecution && stopControl && (
									<div className="skill-actions">
										<Button
											type="button"
											variant="outline"
											disabled={stopControl.disabled}
											focusableWhenDisabled
											data-stop-execution={stopControl.executionId}
											onClick={stopControl.onStop}
										>
											<Square aria-hidden="true" />
											{stopControl.label}
										</Button>
									</div>
								)}
								{/* 有活动的浏览器卡在时间线末尾，不放进可收起的上下文条（NI-83）；空闲时不渲染。 */}
								{browserCapability && (
									<BrowserActivityCard {...browserCardProps} />
								)}
							</>
						}
					/>
				)}
				{/* 设计 renderChatFiles：消息列表之后、输入框之前；只汇总本页上传的输入附件（CH-03）。 */}
				{agent.capabilities.attachments && (
					<ConversationFilesBar
						uploads={files.uploads}
						limitsError={files.limitsError}
					>
						<ConversationFilePicker
							attachmentsEnabled={agent.capabilities.attachments}
							limits={files.limits}
							limitsError={files.limitsError}
							uploads={files.uploads}
							onSelect={(selected) => void files.addFiles(selected)}
							onRemove={files.remove}
							onRetry={files.retry}
							fallbackFocus={composer}
						/>
					</ConversationFilesBar>
				)}
				{/* 命令反馈区：composer 上方、任何折叠条之外，默认可见（NI-83）。
				    这里的说明行统一为 text-sm（14px / 20px，#3293 N9-1-01）。 */}
				{uncertainExecution && !capabilityExecution && (
					<p role="status" className="text-sm">
						原执行结果待核实，核实前新消息只进入排队。
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
					<p role="status" className="text-sm">
						{firstSendPending
							? updating
								? "会话更新中，完成后自动发送这条消息。"
								: "会话准备中，完成后自动发送这条消息。"
							: updating
								? "会话更新中，完成后即可发送。草稿会保留。"
								: "会话准备中，完成后即可发送。草稿会保留。"}
					</p>
				)}
				{queueOnSend && (
					<p id={`${feedbackId}-queue`} className="text-sm">
						{active
							? "当前回复仍在处理，这条消息发送后进入排队，按顺序处理。"
							: "会话中已有排队消息，这条消息发送后排在它们之后。"}
					</p>
				)}
				{notice && (
					<p role="status" className="text-sm">
						{notice}
					</p>
				)}
				<CommandNotice
					result={command.result}
					pending={command.isPending}
					retry={
						command.canRetry
							? () => {
									// 「核实原请求」「重试原请求」随提交开始卸载：先把焦点交给输入框（提交中只读），
									// 不落到 body（#3242 K7-02）。
									composer.current?.focus();
									command.retry();
								}
							: undefined
					}
					denial={denialPhase}
					unknownId={`${feedbackId}-unknown`}
					onResend={() => {
						// 「重新发送」随提交开始卸载：先把焦点交给输入框（提交中只读），不落到 body（#3242 K7-02）。
						composer.current?.focus();
						void send({ resend: true });
					}}
					resendDisabled={!canSend}
					queuedCount={
						[...queue.values()].filter((state) => state.status === "waiting")
							.length
					}
				/>
				{agent.capabilities.modelSelection && !option && currentModelId && (
					// 静态说明行，同区其余说明行为正文前景色、不设 role（web-ui「对话页状态说明行」，#3327 N10-1-03）。
					<p className="text-sm">
						原模型选项已移除；提交消息时，标准模板将使用 Owner
						的默认选项。你也可以刷新并重新选择。
					</p>
				)}
				<ConversationComposer
					composerId={composerId}
					textarea={composer}
					draft={draft}
					draftDisabled={draftLocked}
					draftBusy={commandLocked && !draftLocked}
					submitReady={submitReady}
					invokeReady={!active}
					sendLabel={supplementExpected ? "发送补充指令" : "发送"}
					capability={capability}
					skillControlFiles={{
						attachmentsEnabled: agent.capabilities.attachments,
						limits: files.limits,
						limitsError: files.limitsError,
						entries: skillFiles.entries,
						error: skillFiles.error,
						ready: skillFiles.ready,
						attachmentIds: skillFiles.attachmentIds,
						onSelect: skillFiles.addFiles,
						onRemove: skillFiles.remove,
						onRetry: skillFiles.retry,
					}}
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
									onRetry: () => modelSave.retry(),
								}
							: undefined
					}
					modelFailure={modelSave.failure}
					draftDescribedBy={
						command.result?.kind === "unknown"
							? `${feedbackId}-unknown`
							: undefined
					}
					sendDescribedBy={queueOnSend ? `${feedbackId}-queue` : undefined}
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
			<ConversationExecutionDetails
				open={selectedExecution !== undefined}
				data={selectedExecution ? reader.execution.data : undefined}
				conversationId={conversationId}
				loading={
					Boolean(selectedExecution) &&
					(reader.execution.data === undefined
						? reader.execution.isFetching
						: queryUserReading(reader.execution, executionRead))
				}
				failed={
					Boolean(selectedExecution) &&
					(readFailed(
						reader.execution,
						retryableExecutionRead,
						executionRead,
					) ||
						timeline.failure?.kind === "http")
				}
				modelOptions={options}
				connectionEnabled={agent.capabilities.connection === true}
				onRetry={() => {
					if (timeline.failure?.kind === "http") return reader.reconnect();
					markUserRead(executionRead, reader.execution.dataUpdatedAt);
					return reader.execution.refetch();
				}}
				onClose={() => setSelectedExecution(undefined)}
				finalFocus={executionFinalFocus}
				viewer={session?.user}
			/>
		</>
	);
}
