import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { IdentifierText } from "@/components/ui/identifier-text";
import { LoadingLine } from "@/components/ui/spinner";
import { Timestamp } from "@/components/ui/timestamp";
import { reasoningLevelLabel } from "@/lib/reasoning-level-label";
import type { ChipTone } from "@/lib/status-tone";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import type {
	ExecutionDetailProjectionV2,
	PersistedConversationEventV2,
	RuntimeOperationFailureV2,
} from "../../pilot/generated-v2/types.gen.js";
import { RecoveryButton } from "../recovery-button.js";
import {
	BrowserOperationRecordDialog,
	type BrowserRecordViewer,
	browserAuditEntries,
} from "./browser-audit-view.js";
import { browserToolLabel, isBrowserToolId } from "./browser-labels.js";
import { ConnectionInstallationPanel } from "./connection-installation-panel.js";
import {
	commandFailure,
	type ExecutionStatus,
	executionStatusLabels,
	isTerminal,
} from "./conversation-screen-state.js";
import type { ConversationTimelineEventV2 } from "./conversation-timeline.js";

type OperationEvent = Extract<
	PersistedConversationEventV2,
	{ type: "execution.operation" }
>;

export type ExecutionModelOption = Readonly<{
	optionId: string;
	modelId: string;
	displayName: string;
}>;

const statusTones: Record<ExecutionStatus, ChipTone> = {
	waiting: "blue",
	submitted: "blue",
	processing: "blue",
	completed: "green",
	failed: "red",
	cancelled: "gray",
	unknown: "amber",
};

// 穷举映射：契约新增失败分类时类型检查会要求补中文，原值不进入页面。
const failureLabels: Record<RuntimeOperationFailureV2, string> = {
	authorization_denied: "授权被拒绝",
	authorization_unavailable: "授权暂不可用",
	dependency_unavailable: "依赖服务暂不可用",
	request_rejected: "请求被拒绝",
	response_incomplete: "响应不完整",
	operation_failed: "操作失败",
	persistence_unavailable: "结果未能保存",
	interrupted: "已中断",
	recovery_unconfirmed: "恢复结果待核实",
};

const phaseLabels = {
	intent: "准备中",
	started: "已开始",
	completed: "已完成",
	failed: "失败",
	unknown: "结果待核实",
} as const;

/** 同一操作尝试只保留最后一条事实（快照与 SSE 重放可能重复）。 */
function operationFacts(events: readonly ConversationTimelineEventV2[]) {
	const operations = new Map<string, OperationEvent>();
	for (const event of events)
		if (event.type === "execution.operation")
			operations.set(
				JSON.stringify([event.payload.operationRef, event.payload.attemptRef]),
				event,
			);
	return [...operations.values()];
}

function modelName(
	options: readonly ExecutionModelOption[],
	match: { optionId?: string; modelId: string },
) {
	return (
		options.find((option) =>
			match.optionId
				? option.optionId === match.optionId
				: option.modelId === match.modelId,
		)?.displayName ?? match.modelId
	);
}

/** 「模型」行：显示名 · 推理档位；没有任何模型事实时明确标示未采集。 */
export function executionModelSummary(
	data: ExecutionDetailProjectionV2,
	options: readonly ExecutionModelOption[],
) {
	const fact = operationFacts(data.events).findLast(
		(event) => event.payload.kind === "model",
	);
	if (fact?.payload.kind === "model") {
		const { model } = fact.payload;
		const name = modelName(options, {
			optionId: model.modelOptionId,
			modelId: model.modelId,
		});
		return model.reasoningLevel
			? `${name} · ${reasoningLevelLabel(model.reasoningLevel)}`
			: name;
	}
	const call = data.processSummary.findLast(
		(item) => item.kind === "model_call",
	);
	if (call?.kind === "model_call") {
		const name = modelName(options, { modelId: call.modelId });
		return call.reasoningLevel
			? `${name} · ${reasoningLevelLabel(call.reasoningLevel)}`
			: name;
	}
	return "未采集";
}

/**
 * 「Connection」行（PRD §14.1：未采集与未调用分开标示，不推测）：
 * 有调用事实但没有 Connection 项为「未调用」，完全没有调用事实为「未采集」。
 */
export function executionConnectionSummary(data: ExecutionDetailProjectionV2) {
	const facts = operationFacts(data.events);
	const connected = facts.filter(
		(event) => event.payload.kind === "tool" && event.payload.connection,
	);
	if (connected.length)
		return `已调用 ${connected.length} 次 · ${
			connected.every(
				(event) =>
					event.payload.kind === "tool" &&
					event.payload.connection?.verification === "verified",
			)
				? "已核实"
				: "待核实"
		}`;
	const summaries = data.processSummary.filter(
		(item) => item.kind === "connection_call",
	);
	if (summaries.length) return `已调用 ${summaries.length} 次`;
	return facts.length ||
		data.processSummary.some((item) => item.kind === "model_call")
		? "未调用"
		: "未采集";
}

/** 本次执行确实需要 Connection 授权时，安装区默认展开。 */
function needsConnectionAuthorization(data: ExecutionDetailProjectionV2) {
	return (
		data.error?.code === "CONNECTION_AUTHORIZATION_REQUIRED" ||
		operationFacts(data.events).some(
			(event) =>
				event.payload.kind === "tool" &&
				event.payload.connection?.verification === "unverified" &&
				event.payload.connection.reason === "authorization_unavailable",
		)
	);
}

function summaryText(
	item: ExecutionDetailProjectionV2["processSummary"][number],
	options: readonly ExecutionModelOption[],
) {
	switch (item.kind) {
		case "status":
			return executionStatusLabels[item.status];
		case "model_call":
			return `模型调用 · ${modelName(options, { modelId: item.modelId })} · ${
				item.status === "succeeded" ? "成功" : "失败"
			}`;
		case "connection_call":
			return `Connection 调用 · ${item.accountDisplay} · ${
				item.status === "succeeded" ? "成功" : "失败"
			}`;
		default:
			return item.summary;
	}
}

function ProcessSummary({
	data,
	options,
}: {
	data: ExecutionDetailProjectionV2;
	options: readonly ExecutionModelOption[];
}) {
	if (!data.processSummary.length)
		return <p className="text-muted-foreground">尚无过程摘要。</p>;
	return (
		<ul className="execution-detail-list">
			{data.processSummary.map((item, index) => (
				<li key={`${item.occurredAt}-${index}`}>
					<p>{summaryText(item, options)}</p>
					<p className="execution-detail-meta">
						{item.kind === "agent_summary"
							? "Agent 提供的摘要"
							: "Platform 记录"}
						{" · "}
						<Timestamp value={item.occurredAt} />
					</p>
				</li>
			))}
		</ul>
	);
}

/**
 * 工具调用事实的名称（Z-15）：浏览器工具与浏览器卡、操作记录共用 browser-labels 的映射，
 * 不外露 browser_navigate 等原始值；其他工具没有显示名，仍显示 Runtime 上报的 toolId。
 */
function toolName(fact: Extract<OperationEvent["payload"], { kind: "tool" }>) {
	return fact.browser || isBrowserToolId(fact.toolId)
		? browserToolLabel(fact.toolId)
		: fact.toolId;
}

function usageText(
	fact: Extract<OperationEvent["payload"], { kind: "model" }>,
) {
	const input = fact.usage?.inputTokens;
	const output = fact.usage?.outputTokens;
	if (input === undefined && output === undefined) return "用量未采集";
	return `输入 ${input ?? "未采集"} · 输出 ${output ?? "未采集"} Token`;
}

function OperationFacts({
	events,
	options,
}: {
	events: readonly ConversationTimelineEventV2[];
	options: readonly ExecutionModelOption[];
}) {
	const facts = operationFacts(events);
	if (!facts.length)
		return <p className="text-muted-foreground">尚无经采集的调用事实。</p>;
	return (
		<ul className="execution-detail-list">
			{facts.map((event) => {
				const fact = event.payload;
				const meta = [
					fact.durationMs === undefined
						? "耗时未采集"
						: `耗时 ${fact.durationMs} ms`,
					...(fact.kind === "model"
						? [
								fact.model.reasoningLevel
									? `推理强度 ${reasoningLevelLabel(fact.model.reasoningLevel)}`
									: "推理强度未提供",
								usageText(fact),
							]
						: []),
				];
				return (
					<li key={event.eventId}>
						<p className="break-words font-medium">
							{fact.kind === "model"
								? `模型调用 · ${modelName(options, {
										optionId: fact.model.modelOptionId,
										modelId: fact.model.modelId,
									})}`
								: `工具调用 · ${toolName(fact)}`}{" "}
							· {phaseLabels[fact.phase]}
						</p>
						<p className="execution-detail-meta">{meta.join(" · ")}</p>
						{fact.failureCode && (
							<p className="execution-detail-meta">
								失败原因：{failureLabels[fact.failureCode]}
							</p>
						)}
						{fact.kind === "tool" && fact.connection && (
							<>
								<p className="execution-detail-meta">
									Connection 调用关联：
									{fact.connection.verification === "verified" ? (
										<>
											已核实{" "}
											<IdentifierText
												value={fact.connection.callRef}
												label="调用关联"
												copyable
											/>
										</>
									) : (
										"待核实；不能据此判定外部操作成功"
									)}
								</p>
								<p className="execution-detail-meta">
									Connection 关联引用不授予访问权限。
								</p>
							</>
						)}
						{fact.kind === "tool" && fact.resultRef && (
							<p className="execution-detail-meta">
								结果引用：
								<IdentifierText
									value={fact.resultRef}
									label="结果引用"
									copyable
								/>
							</p>
						)}
					</li>
				);
			})}
		</ul>
	);
}

/** Connection 安装与本次执行不一定相关：默认收起；收起时不卸载，授权进行中的状态与轮询保留。 */
function ConnectionInstallationSection({
	defaultOpen,
	conversationId,
	executionId,
	client,
}: {
	defaultOpen: boolean;
	conversationId: string;
	executionId: string;
	client?: Client;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const panelId = useId();
	return (
		<div className="execution-detail-section">
			<Button
				type="button"
				variant="ghost"
				className="execution-detail-disclosure"
				aria-expanded={open}
				aria-controls={panelId}
				onClick={() => setOpen((value) => !value)}
			>
				<ChevronDown aria-hidden="true" data-open={open} />
				Connection 安装
			</Button>
			<div id={panelId} hidden={!open}>
				<ConnectionInstallationPanel
					key={`${conversationId}:${executionId}`}
					executionId={executionId}
					client={client}
				/>
			</div>
		</div>
	);
}

/**
 * 执行详情模态弹窗（设计 open-execution）：标题「执行详情」、dl.facts 四行汇总加起止时间、
 * PRD §14.1 要求的过程与调用事实、page-note 与唯一主按钮「关闭」。
 * 打开时聚焦弹窗本身；关闭时焦点交给 finalFocus（触发控件或页头标题）。
 */
export function ConversationExecutionDetails({
	open,
	data,
	conversationId,
	client,
	loading,
	failed,
	modelOptions,
	connectionEnabled,
	onRetry,
	onClose,
	finalFocus,
	viewer,
}: {
	open: boolean;
	data?: ExecutionDetailProjectionV2;
	conversationId: string;
	client?: Client;
	loading: boolean;
	failed: boolean;
	modelOptions: readonly ExecutionModelOption[];
	connectionEnabled: boolean;
	onRetry: () => void;
	onClose: () => void;
	finalFocus?: () => HTMLElement | null;
	/** 当前登录用户：嵌套的浏览器操作记录用它显示接管人姓名。 */
	viewer?: BrowserRecordViewer;
}) {
	const body = useRef<HTMLDivElement>(null);
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<DialogContent finalFocus={finalFocus ? () => finalFocus() : undefined}>
				<DialogHeader>
					<DialogTitle>执行详情</DialogTitle>
				</DialogHeader>
				<DialogBody ref={body}>
					{loading && <LoadingLine>正在读取执行记录…</LoadingLine>}
					{failed && (
						<Alert tone="danger" role="alert">
							<AlertDescription>执行记录暂时无法读取。</AlertDescription>
							<AlertAction>
								{/* 重读时失败提示换成读取行、按钮卸载：焦点交给执行详情弹窗，Escape 仍可关闭；
								    仍失败时回到按钮（#3269 N8-3-02）。 */}
								<RecoveryButton
									variant="outline"
									recoveryKey="重新读取详情"
									recoveryTarget={() =>
										body.current?.closest<HTMLElement>('[role="dialog"]') ??
										null
									}
									onClick={onRetry}
								>
									重新读取详情
								</RecoveryButton>
							</AlertAction>
						</Alert>
					)}
					{data && (
						<ExecutionDetailBody
							data={data}
							conversationId={conversationId}
							client={client}
							loading={loading}
							modelOptions={modelOptions}
							connectionEnabled={connectionEnabled}
							onRetry={onRetry}
							viewer={viewer}
						/>
					)}
				</DialogBody>
				<DialogFooter>
					<DialogClose render={<Button type="button" />}>关闭</DialogClose>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function ExecutionDetailBody({
	data,
	conversationId,
	client,
	loading,
	modelOptions,
	connectionEnabled,
	onRetry,
	viewer,
}: {
	data: ExecutionDetailProjectionV2;
	conversationId: string;
	client?: Client;
	loading: boolean;
	modelOptions: readonly ExecutionModelOption[];
	connectionEnabled: boolean;
	onRetry: () => void;
	viewer?: BrowserRecordViewer;
}) {
	// 「核实原执行状态」读取中是可聚焦的禁用（#3242 K7-02）；核实到终态、按钮随之卸载后焦点交给
	// 执行详情弹窗本身，不落到 body，Escape 仍可关闭。
	const verifyButton = useRef<HTMLButtonElement>(null);
	const verifyDialog = useRef<HTMLElement | null>(null);
	useEffect(() => {
		const dialog = verifyDialog.current;
		if (loading || !dialog) return;
		verifyDialog.current = null;
		const active = document.activeElement;
		if (verifyButton.current || (active && active !== document.body)) return;
		if (dialog.isConnected) dialog.focus();
	}, [loading]);
	return (
		<>
			<dl className="conversation-facts">
				<dt>Execution ID</dt>
				<dd>
					<IdentifierText
						value={data.executionId}
						label="Execution ID"
						copyable
					/>
				</dd>
				<dt>模型</dt>
				<dd>{executionModelSummary(data, modelOptions)}</dd>
				<dt>状态</dt>
				<dd>
					<Badge
						variant="chip"
						tone={statusTones[data.status]}
						data-execution-status={data.status}
					>
						{executionStatusLabels[data.status]}
					</Badge>
				</dd>
				<dt>Connection</dt>
				<dd>{executionConnectionSummary(data)}</dd>
				<dt>开始时间</dt>
				<dd>
					{data.startedAt ? (
						<Timestamp value={data.startedAt} style="absolute" />
					) : (
						"未提供"
					)}
				</dd>
				<dt>结束时间</dt>
				<dd>
					{data.finishedAt ? (
						<Timestamp value={data.finishedAt} style="absolute" />
					) : (
						"尚未确认结束"
					)}
				</dd>
			</dl>
			{data.error && (
				<Alert tone="danger" role="alert" className="execution-detail-section">
					<AlertDescription>{commandFailure(data.error.code)}</AlertDescription>
				</Alert>
			)}
			<section className="execution-detail-section">
				<h3>过程摘要</h3>
				<ProcessSummary data={data} options={modelOptions} />
			</section>
			<section className="execution-detail-section">
				<h3>模型与工具调用事实</h3>
				<OperationFacts events={data.events} options={modelOptions} />
			</section>
			<BrowserRecordsRow data={data} viewer={viewer} />
			{connectionEnabled && (
				<ConnectionInstallationSection
					defaultOpen={needsConnectionAuthorization(data)}
					conversationId={conversationId}
					executionId={data.executionId}
					client={client}
				/>
			)}
			{!isTerminal(data.status) && (
				<Button
					ref={verifyButton}
					type="button"
					variant="outline"
					className="execution-detail-section"
					disabled={loading}
					focusableWhenDisabled
					onClick={(event) => {
						verifyDialog.current =
							event.currentTarget.closest<HTMLElement>('[role="dialog"]');
						onRetry();
					}}
				>
					核实原执行状态
				</Button>
			)}
			<p className="conversation-page-note">
				这里展示可审计的执行事实，不包含思考过程；模型提供的思考过程显示在回答上方。
			</p>
		</>
	);
}

/** 该执行有浏览器记录时，在详情里提供只读记录入口（嵌套弹窗，Esc 只关闭记录）。 */
function BrowserRecordsRow({
	data,
	viewer,
}: {
	data: ExecutionDetailProjectionV2;
	viewer?: BrowserRecordViewer;
}) {
	if (
		browserAuditEntries(data.events, data.conversationId, data.executionId)
			.length === 0
	)
		return null;
	return (
		<section className="execution-detail-section execution-detail-row">
			<h3>浏览器操作</h3>
			<BrowserOperationRecordDialog
				conversationId={data.conversationId}
				events={data.events}
				executionId={data.executionId}
				viewer={viewer}
			/>
		</section>
	);
}
