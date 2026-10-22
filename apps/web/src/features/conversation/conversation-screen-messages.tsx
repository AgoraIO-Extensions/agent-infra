import { Bot, ChevronLeft, ChevronRight, Square, User } from "lucide-react";
import {
	Fragment,
	memo,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "../../components/ui/button.js";
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "../../components/ui/collapsible.js";
import { LoadingLine } from "../../components/ui/spinner.js";
import { Timestamp } from "../../components/ui/timestamp.js";
import {
	distinctObjectNames,
	withObjectName,
} from "../../lib/accessible-name.js";
import type { PilotProtocolErrorV1 } from "../../pilot/generated/types.gen.js";
import type { ConversationDetailProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { AssistantMarkdown } from "./assistant-markdown.js";
import {
	ArtifactPreviewDialog,
	artifactCanPreview,
} from "./conversation-artifact-preview.js";
import type { ResultFile } from "./conversation-files.js";
import {
	type ModelFallback,
	ModelFallbackDialog,
	type ModelOptionName,
	modelFallbacks,
} from "./conversation-model-fallback.js";
import {
	answerNotWrittenYet,
	answerStatus,
	answerText,
	commandFailure,
	type ExecutionStatus,
	emptyAnswerKind,
	executionStatus,
	executionStatusLabels,
	isTerminal,
	reasoningTexts,
} from "./conversation-screen-state.js";
import type { ConversationTimelineEventV2 } from "./conversation-timeline.js";
import type { SandboxReferences } from "./sandbox-reference-views.js";
import {
	executionResultFiles,
	sandboxReferenceIndex,
} from "./sandbox-references.js";

/** 一条时间线中缓存的内联图片读取结果上限（每项不超过预览上限）。 */
const maxCachedInlineImages = 32;

/** 进行中回复的停止入口：只渲染在该 Execution 的回复卡内（R4-07）。 */
export type ConversationStopControl = Readonly<{
	executionId: string;
	label: string;
	disabled: boolean;
	onStop: () => void;
}>;

/** 停止受理等只属于某个 Execution 的说明，显示在该回复卡的状态行。 */
export type ConversationExecutionNotice = Readonly<{
	executionId: string;
	text: string;
}>;

/** 可访问名称里的对象名：回复所答问题的开头，区分同页多张回复卡上的同名链接。 */
function questionExcerpt(text: string) {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > 20 ? `${compact.slice(0, 20)}…` : compact;
}

export function ConversationMessages({
	agentName,
	userName,
	history,
	events,
	current,
	onExecution,
	onRegenerate,
	canRegenerate,
	onResend,
	onDownloadFile,
	onPreviewFile,
	onReadInlineFile,
	downloadingFileId,
	previewingFileId,
	hasEarlier,
	earlierLoading,
	earlierFailure,
	onLoadEarlier,
	stop,
	executionNotice,
	modelOptions = [],
	trailing,
}: {
	agentName: string;
	/** 当前会话用户的显示名：个人对话只对本人可见，用户消息的发送者就是当前用户（CH-08）。 */
	userName: string;
	history: ConversationDetailProjectionV2;
	events: readonly ConversationTimelineEventV2[];
	/** 页面认定的当前 Execution 与状态（含刚受理、尚无状态事件的回复）。 */
	current?: Readonly<{
		executionId: string | undefined;
		status: ExecutionStatus | undefined;
	}>;
	onExecution: (id: string) => void;
	onRegenerate: (messageId: string) => void;
	canRegenerate: boolean;
	onResend: (text: string) => void;
	onDownloadFile?: (file: ResultFile) => Promise<boolean>;
	onPreviewFile?: (file: ResultFile) => Promise<Blob | null>;
	/** #3228：回答内联图片经当前 File Grant 读取内存 Blob；不占用预览/下载的进行中状态。 */
	onReadInlineFile?: (file: Pick<ResultFile, "fileId">) => Promise<Blob | null>;
	downloadingFileId?: string;
	previewingFileId?: string;
	hasEarlier: boolean;
	earlierLoading: boolean;
	earlierFailure: boolean;
	onLoadEarlier: () => void;
	stop?: ConversationStopControl;
	executionNotice?: ConversationExecutionNotice;
	/** 当前模型清单，只用于把回退事件的选项映射为显示名（G-07）。 */
	modelOptions?: readonly ModelOptionName[];
	/** 消息流末尾的附加内容（例如命令 / Skill 调用回执），随时间线一起滚动。 */
	trailing?: ReactNode;
}) {
	const [versions, setVersions] = useState<Record<string, string>>({});
	// #2981：用户对各 Execution 思考过程的展开选择。按 Execution 保存，回复卡从实时卡换成
	// 历史回答、或切换回答版本后仍沿用；没有选择时按默认规则展开或收起。
	const [thinkingOpen, setThinkingOpen] = useState<Record<string, boolean>>({});
	// 推理流可能有上万条增量：每次事件变化只遍历一次，各回复卡直接按 Execution 取用。
	const thinking = useMemo(() => reasoningTexts(events), [events]);
	// 从回复卡就地加载更早内容后，正文出现时把焦点移到该回复（NW-15）。
	const [focusAfterLoad, setFocusAfterLoad] = useState<string>();
	const articles = useRef(new Map<string, HTMLElement>());
	// #3228：内联图片按 fileId 共享一次读取，回复卡重建（实时卡换成历史回答）时不重复签发；
	// 只缓存成功结果且有上限。缓存随时间线卸载（撤权、换身份或换会话）一起释放。
	const inlineReads = useRef(new Map<string, Promise<Blob | null>>());
	const readInline = useCallback(
		(file: Pick<ResultFile, "fileId">) => {
			const cached = inlineReads.current.get(file.fileId);
			if (cached) return cached;
			const request = (onReadInlineFile?.(file) ?? Promise.resolve(null)).then(
				(content) => {
					if (!content) inlineReads.current.delete(file.fileId);
					return content;
				},
				() => {
					inlineReads.current.delete(file.fileId);
					return null;
				},
			);
			inlineReads.current.set(file.fileId, request);
			for (const key of inlineReads.current.keys()) {
				if (inlineReads.current.size <= maxCachedInlineImages) break;
				inlineReads.current.delete(key);
			}
			return request;
		},
		[onReadInlineFile],
	);
	const userMessages = history.messages.filter((item) => item.role === "user");
	const answers = history.messages.filter((item) => item.role === "assistant");
	const renderedExecutions = new Set(answers.map((item) => item.executionId));
	const fallbacks = modelFallbacks(events, modelOptions);
	const liveExecutions = [
		...new Set(
			events
				.filter((item) => !renderedExecutions.has(item.executionId))
				.map((item) => item.executionId),
		),
	];
	// 尚无回答投影的用户消息直接带出自己的回复卡，不再在卡外单独说明受理状态（R4-07）。
	const pendingReplies = new Set(
		userMessages
			.filter(
				(message) =>
					message.status !== "failed" &&
					message.executionId &&
					!answers.some(
						(answer) => answer.replyToMessageId === message.messageId,
					),
			)
			.map((message) => message.executionId as string),
	);
	const notLoaded: string[] = [];
	const registerArticle = (id: string) => (node: HTMLElement | null) => {
		if (node) articles.current.set(id, node);
		else articles.current.delete(id);
	};
	const replyFor = ({
		key,
		executionId,
		status,
		text,
		bodyKind,
		createdAt,
		error,
		objectName,
		regenerate,
		versionControl,
	}: {
		key: string;
		executionId: string | null;
		status: ExecutionStatus | undefined;
		text: string;
		bodyKind: "text" | "empty" | "not_loaded";
		createdAt?: string;
		error?: PilotProtocolErrorV1 | null;
		objectName?: string;
		regenerate?: () => void;
		versionControl?: ReactNode;
	}) => (
		<AssistantReply
			key={key}
			articleRef={registerArticle(key)}
			agentName={agentName}
			executionId={executionId}
			status={status}
			text={text}
			bodyKind={bodyKind}
			createdAt={createdAt}
			error={error}
			objectName={objectName}
			regenerate={regenerate}
			onExecution={onExecution}
			stop={
				stop && executionId && stop.executionId === executionId
					? stop
					: undefined
			}
			notice={
				executionNotice && executionNotice.executionId === executionId
					? executionNotice.text
					: undefined
			}
			fallback={executionId ? fallbacks.get(executionId) : undefined}
			earlier={
				bodyKind === "not_loaded"
					? {
							loading: earlierLoading,
							failed: earlierFailure && focusAfterLoad === key,
							onLoad: () => {
								if (earlierLoading) return;
								setFocusAfterLoad(key);
								onLoadEarlier();
							},
						}
					: undefined
			}
			versions={versionControl}
			thinking={
				executionId
					? {
							text: thinking.get(executionId),
							open: thinkingOpen[executionId],
							onOpenChange: (open) =>
								setThinkingOpen((previous) => ({
									...previous,
									[executionId]: open,
								})),
						}
					: undefined
			}
			files={
				onDownloadFile && executionId
					? {
							files: executionResultFiles(events, executionId),
							onDownloadFile,
							onPreviewFile,
							readInlineFile: onReadInlineFile ? readInline : undefined,
							downloadingFileId,
							previewingFileId,
						}
					: undefined
			}
		/>
	);
	const liveReply = (
		id: string,
		objectName?: string,
		recorded?: ExecutionStatus,
	) => {
		const fallback = id === current?.executionId ? current.status : recorded;
		const status = executionStatus(events, id) ?? fallback;
		return replyFor({
			key: `live:${id}`,
			executionId: id,
			status,
			text: events
				.filter(
					(event) => event.executionId === id && event.type === "text.delta",
				)
				.map((event) => (event.type === "text.delta" ? event.payload.text : ""))
				.join(""),
			bodyKind: "text",
			createdAt: events.find((event) => event.executionId === id)?.occurredAt,
			objectName,
		});
	};
	// 回复卡同名控件（查看执行详情、重新生成等）的对象名取提问摘要；摘要相同时编号（N-12）。
	const replyNames = distinctObjectNames(
		userMessages.map((message) => questionExcerpt(message.text)),
	);
	const timelineItems = userMessages.map((message, messageIndex) => {
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
		const objectName = replyNames[messageIndex];
		let reply: ReactNode = null;
		if (selected) {
			const status = answerStatus(
				events,
				selected.executionId,
				selected.status,
			);
			const text = selected.executionId
				? answerText(history, events, selected.executionId, selected.text)
				: selected.text;
			const bodyKind = text
				? "text"
				: emptyAnswerKind(
						history,
						events,
						selected.executionId,
						status,
						hasEarlier,
					);
			if (bodyKind === "not_loaded") notLoaded.push(selected.messageId);
			reply = replyFor({
				key: selected.messageId,
				executionId: selected.executionId,
				status,
				text,
				bodyKind,
				createdAt: selected.createdAt,
				error: selected.error,
				objectName,
				regenerate:
					canRegenerate && isTerminal(status)
						? () => onRegenerate(message.messageId)
						: undefined,
				// 只有 2 个以上回答版本时才需要切换（CH-08 过渡；设计稿尚未画出版本切换）。
				versionControl:
					candidates.length > 1 ? (
						<div className="answer-versions">
							<Button
								variant="ghost"
								size="icon"
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
							<span>
								版本 {selected.answerVersion ?? index + 1}/{candidates.length}
							</span>
							<Button
								variant="ghost"
								size="icon"
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
						</div>
					) : undefined,
			});
		} else if (message.executionId && pendingReplies.has(message.executionId)) {
			reply = liveReply(
				message.executionId,
				objectName,
				isTerminal(message.status) ? undefined : message.status,
			);
		}
		// 提问与回复的间距由 .chat-layout .exchange 给出，与轮次之间等距（设计 .messages gap，G4-03）。
		return (
			<div className="exchange" key={message.messageId}>
				<MessageFrame
					name={userName}
					user
					meta={<Timestamp value={message.createdAt} />}
				>
					<p className="message-text whitespace-pre-wrap break-words">
						{message.text}
					</p>
					{/* 时间线里的历史记录：与回复卡的失败状态行一样不设 live role（B-10）。 */}
					{message.status === "failed" && (
						<Alert tone="danger" className="supplement">
							<AlertDescription>
								{commandFailure(message.error.code)}
							</AlertDescription>
							<AlertAction>
								<Button
									variant="outline"
									onClick={() => onResend(message.text)}
								>
									准备重新发送
								</Button>
							</AlertAction>
						</Alert>
					)}
				</MessageFrame>
				{reply}
			</div>
		);
	});
	const notLoadedKey = notLoaded.join(" ");
	useEffect(() => {
		if (!focusAfterLoad || notLoadedKey.split(" ").includes(focusAfterLoad))
			return;
		const article = articles.current.get(focusAfterLoad);
		setFocusAfterLoad(undefined);
		article?.focus();
	}, [focusAfterLoad, notLoadedKey]);
	// 刚受理、还没有任何事件的当前回复（例如重新生成）也要有自己的回复卡，承载状态与停止入口。
	const trailingExecutions = liveExecutions.filter(
		(id) => !pendingReplies.has(id),
	);
	if (
		current?.executionId &&
		!isTerminal(current.status) &&
		!renderedExecutions.has(current.executionId) &&
		!pendingReplies.has(current.executionId) &&
		!trailingExecutions.includes(current.executionId)
	)
		trailingExecutions.push(current.executionId);
	return (
		<section className="timeline min-h-48 space-y-8" aria-label="会话时间线">
			{hasEarlier && (
				<div className="chat-history-actions">
					<Button
						variant="ghost"
						disabled={earlierLoading}
						onClick={onLoadEarlier}
					>
						{earlierLoading ? "正在加载更早内容…" : "加载更早内容"}
						<ChevronRight aria-hidden="true" />
					</Button>
					{earlierFailure && !focusAfterLoad && (
						<p role="status" className="text-destructive text-sm">
							加载失败，请重试。
						</p>
					)}
				</div>
			)}
			{/* Z-01：设计稿的空会话时间线只有「加载更早内容」，不放欢迎空态卡。 */}
			{timelineItems}
			{trailingExecutions.map((id, index) => (
				<div className="exchange" key={id}>
					{/* 时间线里没有对应提问的回复按顺序编号，同名控件仍可区分（N-12）。 */}
					{liveReply(
						id,
						trailingExecutions.length > 1 ? `回复 ${index + 1}` : "回复",
					)}
				</div>
			))}
			{trailing}
		</section>
	);
}

/**
 * 设计 .message（Agent 回复）：meta 行右侧在进行中时是 15px spinner +「处理中」，结束后是时间；
 * 回答状态是 12px muted 状态行加文字链接（查看执行详情 / 重新生成），没有常驻工具行（CH-08）。
 * 处理中卡内有「停止回复」（R4-07）；失败与停止只用一行状态说明（R4-08）。
 */
function AssistantReply({
	articleRef,
	agentName,
	executionId,
	status,
	text,
	bodyKind,
	createdAt,
	error,
	objectName,
	regenerate,
	onExecution,
	stop,
	notice,
	fallback,
	earlier,
	versions,
	thinking,
	files,
}: {
	articleRef: (node: HTMLElement | null) => void;
	agentName: string;
	executionId: string | null;
	status: ExecutionStatus | undefined;
	text: string;
	bodyKind: "text" | "empty" | "not_loaded";
	createdAt?: string;
	error?: PilotProtocolErrorV1 | null;
	objectName?: string;
	regenerate?: () => void;
	onExecution: (id: string) => void;
	stop?: ConversationStopControl;
	notice?: string;
	fallback?: ModelFallback;
	earlier?: { loading: boolean; failed: boolean; onLoad: () => void };
	versions?: ReactNode;
	/** #2981：该 Execution 的思考过程与用户的展开选择（未选择时为 undefined）。 */
	thinking?: {
		text: string | undefined;
		open: boolean | undefined;
		onOpenChange: (open: boolean) => void;
	};
	files?: ReplyResultFiles;
}) {
	const pending = status === "submitted" || status === "processing";
	const answered = bodyKind === "text" && Boolean(text);
	const preview = useResultFilePreview(files);
	// #3228：回答中已显示为图片或文件卡的结果文件（按 fileId 计数，StrictMode 重复挂载也成对）。
	const renderedCounts = useRef(new Map<string, number>());
	const [inAnswer, setInAnswer] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const onRendered = useCallback((fileId: string) => {
		const counts = renderedCounts.current;
		const sync = () =>
			setInAnswer((previous) =>
				previous.size === counts.size &&
				[...counts.keys()].every((key) => previous.has(key))
					? previous
					: new Set(counts.keys()),
			);
		counts.set(fileId, (counts.get(fileId) ?? 0) + 1);
		sync();
		return () => {
			const count = (counts.get(fileId) ?? 1) - 1;
			if (count > 0) counts.set(fileId, count);
			else counts.delete(fileId);
			sync();
		};
	}, []);
	const references: SandboxReferences | undefined = files
		? {
				files: sandboxReferenceIndex(files.files),
				settled: !pending,
				readImage: files.readInlineFile,
				onPreview: files.onPreviewFile ? preview.open : undefined,
				onDownload: (file) => void files.onDownloadFile(file),
				previewingFileId: files.previewingFileId,
				downloadingFileId: files.downloadingFileId,
				onRendered,
			}
		: undefined;
	const meta = pending ? (
		<LoadingLine className="message-loading">
			{executionStatusLabels[status]}
		</LoadingLine>
	) : status === "unknown" ? (
		<span className="message-meta-state">{executionStatusLabels.unknown}</span>
	) : (
		<Timestamp value={createdAt} />
	);
	const segments: ReactNode[] = [];
	// 状态文案是独立文本节点，便于读屏与定位（「执行失败」见 R4-08 AC-8）。
	const label = (value: ExecutionStatus) => (
		<span key="status" className="message-status-label">
			{executionStatusLabels[value]}
		</span>
	);
	if (status === "completed") {
		segments.push(label(status));
		if (bodyKind === "not_loaded") segments.push("正文在更早的记录中");
	} else if (status === "failed") {
		// 原因按错误码映射，不需要打开执行详情（R4-08、NI-07）。
		segments.push(label(status));
		segments.push(commandFailure(error?.code));
		if (regenerate) segments.push("可重新生成");
	} else if (status === "cancelled") {
		segments.push(label(status));
		if (regenerate) segments.push("可重新生成");
	} else if (status === undefined) {
		segments.push("消息已保存；回复状态以执行记录为准");
	}
	if (notice)
		segments.push(
			<span key="notice" role="status">
				{notice}
			</span>,
		);
	const links: ReactNode[] = [];
	if (earlier)
		links.push(
			<Button
				key="earlier"
				variant="link"
				className="inline-link"
				aria-disabled={earlier.loading || undefined}
				aria-label={withObjectName(
					earlier.loading ? "正在加载更早内容…" : "加载更早内容",
					objectName,
				)}
				onClick={earlier.onLoad}
			>
				{earlier.loading ? "正在加载更早内容…" : "加载更早内容"}
			</Button>,
		);
	if (regenerate)
		links.push(
			<Button
				key="regenerate"
				variant="link"
				className="inline-link"
				aria-label={withObjectName("重新生成", objectName)}
				// 停止回复后的焦点落点（A2-09）：页面按 Execution 找到这张回复卡的「重新生成」。
				data-regenerate-execution={executionId ?? undefined}
				onClick={regenerate}
			>
				重新生成
			</Button>,
		);
	if (executionId)
		links.push(
			<Button
				key="details"
				variant="link"
				className="inline-link"
				aria-label={withObjectName("查看执行详情", objectName)}
				onClick={() => onExecution(executionId)}
			>
				查看执行详情
			</Button>,
		);
	const parts = [...segments, ...links];
	return (
		<MessageFrame
			name={agentName}
			meta={meta}
			articleRef={articleRef}
			focusable
		>
			{/* #2981：思考过程在回答正文之上；模型没有提供思考内容时不渲染。 */}
			{thinking?.text && (
				<ThinkingProcess
					text={thinking.text}
					open={thinking.open ?? (pending && !answered)}
					onOpenChange={thinking.onOpenChange}
					objectName={objectName}
				/>
			)}
			{/* 失败与已停止且无正文时只用状态行说明，不再写「尚未输出正文。」（R4-08）。 */}
			{answered ? (
				<AssistantMarkdown references={references}>{text}</AssistantMarkdown>
			) : pending ? (
				<p className="message-pending">正在整理结果…</p>
			) : bodyKind !== "not_loaded" && status === "completed" ? (
				<AssistantMarkdown>{answerNotWrittenYet}</AssistantMarkdown>
			) : null}
			{parts.length > 0 && (
				<p className="message-status">
					{parts.map((part, index) => (
						<Fragment key={keyOf(part, index)}>
							{index > 0 && " · "}
							{part}
						</Fragment>
					))}
					{earlier?.failed && <span role="status"> · 加载失败，请重试。</span>}
				</p>
			)}
			{fallback && (
				<p className="message-status message-fallback">
					模型回退 · 实际模型 {fallback.actualModel} ·{" "}
					<ModelFallbackDialog
						fallback={fallback}
						triggerLabel={withObjectName("查看模型状态", objectName)}
					/>
				</p>
			)}
			{files && files.files.length > 0 && (
				<ResultFileList
					files={files}
					inAnswer={answered ? inAnswer : undefined}
					onPreview={files.onPreviewFile ? preview.open : undefined}
				/>
			)}
			{preview.dialog}
			{stop && (
				<div className="card-actions">
					{/* 「正在停止」期间用 aria-disabled 保持可聚焦，焦点不在受理后落到 body（A2-09）。
					    data-stop-execution：从浏览器卡「停止操作」停止时，页面按 Execution 把焦点交给这里（G4-08）。 */}
					<Button
						type="button"
						variant="outline"
						disabled={stop.disabled}
						focusableWhenDisabled
						data-stop-execution={stop.executionId}
						onClick={stop.onStop}
					>
						<Square aria-hidden="true" />
						{stop.label}
					</Button>
				</div>
			)}
			{versions}
		</MessageFrame>
	);
}

function keyOf(part: ReactNode, index: number) {
	return typeof part === "object" && part && "key" in part && part.key
		? String(part.key)
		: `segment-${index}`;
}

/**
 * #2981：回答上方可折叠的「思考过程」（PRD §11.2）。摘要行与会话折叠条一样高 44px，
 * 「展开 / 收起」只是视觉提示，不进入可访问名称；同页多张回复卡用提问摘要区分（N-12）。
 * 正文按纯文本显示，不设 live region：状态已由 meta 行播报，推理流的每条增量也不必
 * 重新解析 Markdown。面板常驻 DOM（keepMounted），收起只隐藏。
 */
function ThinkingProcess({
	text,
	open,
	onOpenChange,
	objectName,
}: {
	text: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	objectName?: string;
}) {
	const panelId = useId();
	return (
		<Collapsible
			className="message-thinking"
			open={open}
			onOpenChange={onOpenChange}
		>
			<CollapsibleTrigger
				className="message-thinking-summary"
				aria-controls={panelId}
				aria-label={withObjectName("思考过程", objectName)}
			>
				<strong>思考过程</strong>
				<span className="message-thinking-toggle" aria-hidden="true">
					{open ? "收起" : "展开"}
				</span>
			</CollapsibleTrigger>
			<CollapsiblePanel id={panelId} className="message-thinking-body">
				<ThinkingText text={text} />
			</CollapsiblePanel>
		</Collapsible>
	);
}

/** 只在思考文本变化时重新渲染，回复卡的其他更新不会重排长文本。 */
const ThinkingText = memo(function ThinkingText({ text }: { text: string }) {
	return (
		<p className="message-thinking-text whitespace-pre-wrap break-words">
			{text}
		</p>
	);
});

/** 一张回复卡的结果文件：同一执行的已确认文件与预览、下载、内联读取入口。 */
type ReplyResultFiles = Readonly<{
	files: readonly ResultFile[];
	onDownloadFile: (file: ResultFile) => Promise<boolean>;
	onPreviewFile?: (file: ResultFile) => Promise<Blob | null>;
	readInlineFile?: (file: Pick<ResultFile, "fileId">) => Promise<Blob | null>;
	downloadingFileId?: string;
	previewingFileId?: string;
}>;

/**
 * 回复卡共用的结果文件预览：回答内文件卡、内联图片与下方结果文件列表打开同一个预览对话框。
 * 未给出内容时经当前 File Grant 重新读取；内联图片已读到的 Blob 直接复用，不再请求。
 */
function useResultFilePreview(files: ReplyResultFiles | undefined) {
	const [selected, setSelected] = useState<ResultFile>();
	const [content, setContent] = useState<Blob | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();
	const previewRequest = useRef(0);
	const latest = useRef(files);
	latest.current = files;
	const open = useCallback(async (file: ResultFile, loaded?: Blob) => {
		const onPreviewFile = latest.current?.onPreviewFile;
		if (!onPreviewFile || !artifactCanPreview(file)) return;
		const request = ++previewRequest.current;
		setSelected(file);
		setError(undefined);
		if (loaded) {
			setContent(loaded);
			setLoading(false);
			return;
		}
		setContent(null);
		setLoading(true);
		const result = await onPreviewFile(file);
		if (request !== previewRequest.current) return;
		setLoading(false);
		if (result) setContent(result);
		else setError("文件读取失败，请重试。");
	}, []);
	const preview = useCallback(
		(file: ResultFile, loaded?: Blob) => void open(file, loaded),
		[open],
	);
	const dialog = files ? (
		<ArtifactPreviewDialog
			file={selected}
			content={content}
			open={selected !== undefined}
			loading={loading}
			error={error}
			onOpenChange={(value) => {
				if (!value) {
					previewRequest.current += 1;
					setSelected(undefined);
					setContent(null);
					setError(undefined);
				}
			}}
			onRetry={() => selected && preview(selected)}
			onDownload={() => selected && void files.onDownloadFile(selected)}
		/>
	) : null;
	return { open: preview, dialog };
}

/**
 * 回答下方的结果文件列表：继续列出同一执行的全部已确认文件，每个文件一行（按 fileId 去重），
 * 包括没有 `workspaceReference` 的文件（V1 事件、ACP image 块）。回答中已显示为图片或文件卡的
 * 文件只列名称并注明位置，不重复渲染预览与下载入口；回答中未发送的引用只在原位置显示占位，
 * 不进入本列表。
 */
function ResultFileList({
	files,
	inAnswer,
	onPreview,
}: {
	files: ReplyResultFiles;
	inAnswer?: ReadonlySet<string>;
	onPreview?: (file: ResultFile) => void;
}) {
	return (
		<div className="message-files space-y-2">
			<p className="font-medium text-sm">结果文件</p>
			{files.files.map((file) => {
				const previewing = files.previewingFileId === file.fileId;
				const downloading = files.downloadingFileId === file.fileId;
				const shown = inAnswer?.has(file.fileId) ?? false;
				return (
					<div
						key={file.fileId}
						className="flex items-center gap-2 text-sm"
						data-in-answer={shown || undefined}
					>
						<span className="min-w-0 flex-1 truncate" title={file.name}>
							{file.name} ({formatResultSize(file.sizeBytes)})
						</span>
						{shown ? (
							<span className="text-muted-foreground text-xs">
								已在回答中显示
							</span>
						) : (
							<>
								{onPreview && artifactCanPreview(file) && (
									<Button
										variant="ghost"
										size="sm"
										disabled={previewing}
										aria-label={withObjectName(
											previewing ? "准备预览…" : "预览",
											file.name,
										)}
										onClick={() => onPreview(file)}
									>
										{previewing ? "准备预览…" : "预览"}
									</Button>
								)}
								<Button
									variant="outline"
									size="sm"
									disabled={downloading}
									aria-label={withObjectName(
										downloading ? "准备下载…" : "下载",
										file.name,
									)}
									onClick={() => void files.onDownloadFile(file)}
								>
									{downloading ? "准备下载…" : "下载"}
								</Button>
							</>
						)}
					</div>
				);
			})}
		</div>
	);
}

function formatResultSize(value: number) {
	if (value < 1024) return `${value} B`;
	if (value < 1024 ** 2) return `${Math.round(value / 1024)} KB`;
	if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
	return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

/** 设计 .message-meta：左侧作者 12px/650，右侧时间（11px muted）或进行中状态，可换行。 */
function MessageFrame({
	name,
	user = false,
	meta,
	articleRef,
	focusable = false,
	children,
}: {
	name: string;
	user?: boolean;
	meta?: ReactNode;
	articleRef?: (node: HTMLElement | null) => void;
	/** 回复卡可被程序聚焦（tabIndex=-1，不进入 Tab 顺序），就地加载更早内容后接收焦点。 */
	focusable?: boolean;
	children: ReactNode;
}) {
	return (
		<article
			ref={articleRef}
			className={user ? "chat-message chat-message-user" : "chat-message"}
			aria-label={`${name}的消息`}
			tabIndex={focusable ? -1 : undefined}
		>
			<div className="chat-message-avatar" aria-hidden="true">
				{user ? <User className="size-4" /> : <Bot className="size-4" />}
			</div>
			<div className="chat-message-body">
				<div className="message-meta">
					<strong className="message-heading">{name}</strong>
					{meta}
				</div>
				{children}
			</div>
		</article>
	);
}
