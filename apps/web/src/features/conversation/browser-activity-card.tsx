import {
	Activity,
	Check,
	Eye,
	Square,
	TriangleAlert,
	UserRound,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	BrowserOperationRecordDialog,
	type BrowserRecordViewer,
	browserAuditEntries,
} from "./browser-audit-view.js";
import {
	type BrowserCardCommand,
	type BrowserCardPhase,
	selectBrowserCard,
} from "./browser-card.js";
import type { ConversationTimelineEventV2 } from "./conversation-timeline.js";

const phaseIcons: Record<BrowserCardPhase, typeof Eye> = {
	idle: Eye,
	request: Eye,
	handoff: UserRound,
	running: Activity,
	complete: Check,
	denied: TriangleAlert,
	stopped: Square,
	unknown: TriangleAlert,
};

const timelineSteps = ["请求已确认", "页面已打开", "结果已回读"] as const;

/** 设计只在终态卡上放「查看操作记录」；非终态只保留本阶段的操作，记录仍可从执行详情打开（Z-09）。 */
const recordPhases: ReadonlySet<BrowserCardPhase> = new Set([
	"complete",
	"denied",
	"stopped",
	"unknown",
]);

/** 在待处理请求到期的那一刻重新渲染，让过期的请求立即失去动作。 */
function useExpiryTick(expiresAt: string | undefined, readNow: () => number) {
	const [, setTick] = useState(0);
	useEffect(() => {
		if (!expiresAt) return;
		const expiry = Date.parse(expiresAt);
		if (!Number.isFinite(expiry)) return;
		const delay = expiry - readNow();
		if (delay <= 0) return;
		const timer = setTimeout(() => setTick((value) => value + 1), delay + 1);
		return () => clearTimeout(timer);
	}, [expiresAt, readNow]);
}

/**
 * 对话页唯一的浏览器卡（设计 .browser-capability）。阶段、文案与动作由
 * selectBrowserCard 从当前 Execution 的服务端事件推导；卡片只发出不透明 ID，
 * 命令请求体由对话页统一构造。
 */
export function BrowserActivityCard({
	events,
	conversationId,
	executionId,
	browserAvailable,
	busy = false,
	canStop = false,
	includeIdle = false,
	now = Date.now,
	onCommand,
	viewer,
}: {
	readonly events: readonly ConversationTimelineEventV2[];
	readonly conversationId?: string;
	readonly executionId?: string;
	readonly browserAvailable: boolean;
	/** 命令提交中：按钮暂时不可用，防止重复提交。 */
	readonly busy?: boolean;
	/** 当前执行仍可停止时才提供「停止操作」。 */
	readonly canStop?: boolean;
	/** 空闲卡只放在默认收起的会话上下文里；对话流中默认不显示。 */
	readonly includeIdle?: boolean;
	readonly now?: () => number;
	readonly onCommand: (command: BrowserCardCommand) => void;
	/** 当前登录用户：操作记录里的接管人显示为姓名。 */
	readonly viewer?: BrowserRecordViewer;
}) {
	const titleId = useId();
	const card = selectBrowserCard({
		events,
		conversationId,
		executionId,
		browserAvailable,
		now: now(),
	});
	useExpiryTick(card?.expiresAt, now);
	if (!card || (card.phase === "idle" && !includeIdle)) return null;
	const records =
		recordPhases.has(card.phase) &&
		browserAuditEntries(events, conversationId, executionId).length > 0;
	const actions = card.actions.filter(
		(action) => action.command.kind !== "stop_execution" || canStop,
	);
	const Icon = phaseIcons[card.phase];
	const invoke = (command: BrowserCardCommand) => {
		// 点击时再核对一次：到期的请求不发出命令。
		if (card.expiresAt && now() >= Date.parse(card.expiresAt)) return;
		onCommand(command);
	};
	return (
		<section
			className="browser-capability"
			data-phase={card.phase}
			aria-labelledby={titleId}
		>
			<div className="browser-capability-head" role="status" aria-atomic="true">
				<div className="browser-capability-title">
					<span className="browser-capability-icon" aria-hidden="true">
						<Icon />
					</span>
					<div>
						<strong id={titleId}>{card.title}</strong>
						<p className="browser-capability-body">{card.body}</p>
					</div>
				</div>
				<div className="browser-capability-status">
					<Badge variant="chip" tone={card.tone}>
						{card.status}
					</Badge>
				</div>
			</div>
			{card.meta.length > 0 && (
				<dl className="browser-capability-meta">
					{card.meta.map((item) => (
						<div key={item.label}>
							<dt>{item.label}</dt>
							<dd>{item.value}</dd>
						</div>
					))}
				</dl>
			)}
			{card.timeline && (
				<ol className="browser-capability-timeline" aria-label="操作进度">
					{timelineSteps.map((step, index) => (
						<li
							key={step}
							data-active={index < (card.timeline ?? 0)}
							aria-current={
								index === (card.timeline ?? 0) - 1 ? "step" : undefined
							}
						>
							{step}
						</li>
					))}
				</ol>
			)}
			{(actions.length > 0 || records) && (
				<div className="browser-capability-actions">
					{actions.map((action) => (
						// G5-04：命令处理中用 aria-disabled 保持可聚焦（同 RecoveryButton、G4-26），焦点不随禁用
						// 落到 body；回读推进后由对话页把焦点交给新卡的第一个操作（data-browser-action）。
						<Button
							key={action.label}
							type="button"
							variant={action.variant}
							aria-label={action.accessibleName}
							disabled={busy}
							focusableWhenDisabled
							data-browser-action={action.command.kind}
							onClick={() => invoke(action.command)}
						>
							{action.icon === "stop" && <Square aria-hidden="true" />}
							{action.label}
						</Button>
					))}
					{records && (
						<BrowserOperationRecordDialog
							conversationId={conversationId}
							events={events}
							executionId={executionId}
							viewer={viewer}
						/>
					)}
				</div>
			)}
		</section>
	);
}
