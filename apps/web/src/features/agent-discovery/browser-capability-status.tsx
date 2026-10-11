import type { BrowserCapabilityProjectionV1 } from "@agent-infra/contracts/runtime";
import {
	AlertTriangle,
	CircleCheck,
	Clock3,
	Globe2,
	ShieldCheck,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
	type BrowserHandoffActionInputV1,
	type BrowserHandoffBindingV1,
	BrowserHandoffPanel,
	type BrowserHandoffPanelStateV1,
	type BrowserSideEffectConfirmationV1,
} from "./browser-handoff-panel.js";

const statusLabels = {
	available: "可用",
	not_configured: "未配置",
	probe_failed: "探测失败",
	unavailable: "不可用",
	stale: "证据过期",
} as const;

const statusDescriptions = {
	not_configured: "部署尚未提供经验证的 Browser Capability。",
	probe_failed: "Browser Runtime 探测未通过，当前不会开放浏览器操作。",
	unavailable: "Browser Runtime 当前不可用，浏览器操作已被阻断。",
	stale: "Browser conformance receipt 已过期，需要重新探测。",
} as const;

type BrowserCapabilityStatusProps = {
	readonly workflow?: BrowserWorkflowState;
	readonly capability: BrowserCapabilityProjectionV1;
	readonly handoff?: BrowserHandoffPanelStateV1;
	readonly confirmation?: BrowserSideEffectConfirmationV1;
	readonly currentBinding?: BrowserHandoffBindingV1;
	readonly onCancelConfirmation?: (input: BrowserHandoffActionInputV1) => void;
	readonly onConfirmSideEffect?: (input: BrowserHandoffActionInputV1) => void;
	readonly onPauseAgent?: (input: BrowserHandoffActionInputV1) => void;
	readonly onRejectSideEffect?: (input: BrowserHandoffActionInputV1) => void;
	readonly onReturnToAgent?: (input: BrowserHandoffActionInputV1) => void;
	readonly onTakeOver?: (input: BrowserHandoffActionInputV1) => void;
};

export type BrowserWorkflowState =
	| { readonly kind: "idle" }
	| { readonly kind: "intent"; readonly operation: string }
	| { readonly kind: "observing" }
	| { readonly kind: "action"; readonly operation: string }
	| {
			readonly kind: "approval_pending";
			readonly operation: string;
			readonly origin: string;
	  }
	| { readonly kind: "handoff_pending"; readonly reason: string }
	| { readonly kind: "handed_off" }
	| { readonly kind: "unknown"; readonly operation: string };

const workflowLabels = {
	intent: "正在受理",
	observing: "正在观察",
	action: "正在执行",
	approval_pending: "等待确认",
	handoff_pending: "等待接管",
	handed_off: "用户已接管",
	unknown: "待核实",
} as const;

export function BrowserWorkflowStatus({
	workflow,
}: {
	readonly workflow?: BrowserWorkflowState;
}) {
	if (!workflow || workflow.kind === "idle") return null;
	const label = workflowLabels[workflow.kind];
	const detail =
		workflow.kind === "intent" || workflow.kind === "action"
			? `操作：${workflow.operation}`
			: workflow.kind === "approval_pending"
				? `操作：${workflow.operation} · 目标 origin：${workflow.origin}`
				: workflow.kind === "handoff_pending"
					? workflow.reason
					: workflow.kind === "unknown"
						? `操作：${workflow.operation}，已阻断自动重试。`
						: undefined;
	const destructive = workflow.kind === "unknown";
	return (
		<Alert
			aria-live="polite"
			aria-atomic="true"
			variant={destructive ? "destructive" : "default"}
			className="mt-3"
		>
			{destructive ? (
				<AlertTriangle aria-hidden="true" />
			) : (
				<Clock3 aria-hidden="true" />
			)}
			<AlertTitle>Browser 工作流 · {label}</AlertTitle>
			<AlertDescription>
				{workflow.kind === "approval_pending"
					? "外部副作用需要当前主体确认后才能继续。"
					: workflow.kind === "handoff_pending"
						? "浏览器将暂停 Agent 操作，等待当前主体接管。"
						: workflow.kind === "handed_off"
							? "用户已接管浏览器，Agent 操作保持暂停。"
							: workflow.kind === "unknown"
								? "操作结果无法确认，系统不会自动重放。"
								: "Browser 工作流正在推进。"}
				{detail ? <span className="mt-1 block">{detail}</span> : null}
			</AlertDescription>
		</Alert>
	);
}

function BrowserCapabilityUnavailable({
	capability,
}: BrowserCapabilityStatusProps & {
	readonly capability: Extract<
		BrowserCapabilityProjectionV1,
		{ status: "not_configured" | "probe_failed" | "unavailable" | "stale" }
	>;
}) {
	return (
		<Alert
			aria-labelledby="browser-capability-heading"
			variant="destructive"
			className="space-y-1"
		>
			<AlertTriangle aria-hidden="true" />
			<AlertTitle id="browser-capability-heading">
				Browser Capability · {statusLabels[capability.status]}
			</AlertTitle>
			<AlertDescription>
				{statusDescriptions[capability.status]} {capability.reason}
				<span className="mt-1 block text-muted-foreground">
					{capability.retryable ? "可以稍后重试。" : "当前不会自动重试。"}
				</span>
			</AlertDescription>
		</Alert>
	);
}

function BrowserCapabilityAvailable({
	capability,
}: BrowserCapabilityStatusProps & {
	readonly capability: Extract<
		BrowserCapabilityProjectionV1,
		{ status: "available" }
	>;
}) {
	return (
		<section
			aria-labelledby="browser-capability-heading"
			className="space-y-3 border-border border-b py-6"
		>
			<header className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<Globe2 aria-hidden="true" className="size-4 text-muted-foreground" />
					<h2 id="browser-capability-heading" className="font-semibold text-lg">
						Browser Capability
					</h2>
				</div>
				<span role="status" aria-atomic="true">
					<Badge variant="outline">
						<CircleCheck aria-hidden="true" data-icon="inline-start" />
						{statusLabels.available}
					</Badge>
				</span>
			</header>
			<p className="text-muted-foreground text-sm">
				已通过固定 {capability.provenance.browser} / Chromium{" "}
				{capability.provenance.chromiumVersion} 探测；页面内容、Cookie
				和凭证不会显示在此摘要中。
			</p>
			<dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
				<dt className="text-muted-foreground">支持操作</dt>
				<dd>{capability.operations.join("、")}</dd>
				<dt className="text-muted-foreground">允许域名</dt>
				<dd>{capability.policy.allowedOrigins.length} 个受控 origin</dd>
				<dt className="text-muted-foreground">资源上限</dt>
				<dd>
					{capability.policy.maxContexts} 个 Context、
					{capability.policy.maxTabs} 个 Tab、{capability.policy.maxPages} 个
					Page
				</dd>
				<dt className="text-muted-foreground">用户接管</dt>
				<dd className="flex items-center gap-1">
					{capability.policy.allowUserHandoff ? (
						<>
							<ShieldCheck aria-hidden="true" className="size-3.5" />
							支持受控接管
						</>
					) : (
						<>
							<Clock3 aria-hidden="true" className="size-3.5" />
							当前未开放
						</>
					)}
				</dd>
			</dl>
		</section>
	);
}

export function BrowserCapabilityStatus({
	capability,
	workflow,
	handoff,
	confirmation,
	currentBinding,
	onCancelConfirmation,
	onConfirmSideEffect,
	onPauseAgent,
	onRejectSideEffect,
	onReturnToAgent,
	onTakeOver,
}: BrowserCapabilityStatusProps) {
	return (
		<>
			{capability.status === "available" ? (
				<BrowserCapabilityAvailable capability={capability} />
			) : (
				<BrowserCapabilityUnavailable capability={capability} />
			)}
			<BrowserWorkflowStatus workflow={workflow} />
			<BrowserHandoffPanel
				handoff={handoff}
				confirmation={confirmation}
				currentBinding={currentBinding}
				browserAvailable={capability.status === "available"}
				onCancelConfirmation={onCancelConfirmation}
				onConfirmSideEffect={onConfirmSideEffect}
				onPauseAgent={onPauseAgent}
				onRejectSideEffect={onRejectSideEffect}
				onReturnToAgent={onReturnToAgent}
				onTakeOver={onTakeOver}
			/>
		</>
	);
}
