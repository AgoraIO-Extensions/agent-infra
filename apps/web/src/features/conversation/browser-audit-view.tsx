import { AlertTriangle, CheckCircle2, Clock3, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { PersistedConversationEventV2 } from "../../pilot/generated-v2/types.gen.js";

const MAX_BROWSER_AUDIT_ENTRIES = 50;

type BrowserAuditKind = "operation" | "handoff" | "side_effect";
type BrowserAuditSeverity = "normal" | "warning" | "danger";

export type BrowserAuditEntry = Readonly<{
	key: string;
	sequence: number;
	occurredAt: string;
	kind: BrowserAuditKind;
	status: string;
	statusLabel: string;
	severity: BrowserAuditSeverity;
	detail: string;
}>;

const operationLabels = {
	intent: "正在受理",
	started: "正在执行",
	completed: "已完成",
	failed: "执行失败",
	unknown: "结果待核实",
} as const;

const handoffLabels = {
	requested: "等待接管",
	active: "用户已接管",
	returning: "正在交回 Agent",
	completed: "已交回 Agent",
	revoked: "已撤销",
	expired: "已过期",
	crashed: "浏览器已崩溃",
	unknown: "状态待核实",
} as const;

const sideEffectLabels = {
	pending: "等待确认",
	confirmed: "已确认",
	rejected: "已拒绝",
	cancelled: "已取消",
	expired: "已过期",
	unknown: "结果待核实",
} as const;

const reasonLabels = {
	login: "登录",
	mfa: "MFA 验证",
	captcha: "CAPTCHA 验证",
	human_judgment: "需要人工判断",
} as const;

function safeText(value: string, limit = 160): string {
	return [...value]
		.filter((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code >= 0x20 && code !== 0x7f;
		})
		.join("")
		.trim()
		.slice(0, limit);
}

function safeOrigin(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (
			(url.protocol !== "http:" && url.protocol !== "https:") ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		)
			return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

function severityFor(status: string): BrowserAuditSeverity {
	if (["failed", "unknown", "crashed"].includes(status)) return "danger";
	if (
		[
			"intent",
			"started",
			"requested",
			"active",
			"returning",
			"pending",
			"expired",
		].includes(status)
	)
		return "warning";
	return "normal";
}

function sameExecution(
	event: PersistedConversationEventV2,
	conversationId: string | undefined,
	executionId: string | undefined,
): boolean {
	return (
		event.kind === "event" &&
		(conversationId === undefined || event.conversationId === conversationId) &&
		(executionId === undefined || event.executionId === executionId)
	);
}

function validBrowserSideEffectEvent(
	event: Extract<PersistedConversationEventV2, { type: "browser.side_effect" }>,
): boolean {
	const { binding } = event.payload;
	return (
		binding.conversationId === event.conversationId &&
		binding.executionId === event.executionId &&
		binding.confirmationId === event.payload.confirmationId &&
		Boolean(safeOrigin(event.payload.targetOrigin)) &&
		Boolean(safeText(event.payload.redactedTargetSummary))
	);
}

function operationEntry(
	event: Extract<PersistedConversationEventV2, { type: "execution.operation" }>,
): BrowserAuditEntry | undefined {
	if (event.payload.kind !== "tool" || !event.payload.browser) return undefined;
	const status = event.payload.phase;
	return {
		key: `operation:${event.payload.operationRef}:${event.payload.attemptRef}`,
		sequence: event.sequence,
		occurredAt: event.occurredAt,
		kind: "operation",
		status,
		statusLabel: operationLabels[status],
		severity: severityFor(status),
		detail: safeText(event.payload.toolId),
	};
}

function handoffEntry(
	event: Extract<PersistedConversationEventV2, { type: "browser.handoff" }>,
): BrowserAuditEntry | undefined {
	if (
		event.payload.binding.conversationId !== event.conversationId ||
		event.payload.binding.executionId !== event.executionId
	)
		return undefined;
	const status = event.payload.status;
	return {
		key: `handoff:${event.eventId}`,
		sequence: event.sequence,
		occurredAt: event.occurredAt,
		kind: "handoff",
		status,
		statusLabel: handoffLabels[status],
		severity: severityFor(status),
		detail: `原因：${reasonLabels[event.payload.reason]}`,
	};
}

function sideEffectEntry(
	event: Extract<PersistedConversationEventV2, { type: "browser.side_effect" }>,
): BrowserAuditEntry | undefined {
	if (!validBrowserSideEffectEvent(event)) return undefined;
	const status = event.payload.status;
	const origin = safeOrigin(event.payload.targetOrigin);
	const summary = safeText(event.payload.redactedTargetSummary);
	if (!origin || !summary) return undefined;
	return {
		key: `side-effect:${event.payload.confirmationId}`,
		sequence: event.sequence,
		occurredAt: event.occurredAt,
		kind: "side_effect",
		status,
		statusLabel: sideEffectLabels[status],
		severity: severityFor(status),
		detail: `${safeText(event.payload.operation)} · ${origin} · ${summary}`,
	};
}

/**
 * Build a bounded, read-only Browser history from the already authorized
 * Conversation timeline. No caller-supplied binding becomes an action input.
 */
export function browserAuditEntries(
	events: readonly PersistedConversationEventV2[],
	conversationId?: string,
	executionId?: string,
): readonly BrowserAuditEntry[] {
	if (!executionId) return [];
	const operations = new Map<string, BrowserAuditEntry>();
	const handoffs = new Map<string, BrowserAuditEntry>();
	const sideEffects = new Map<string, BrowserAuditEntry>();
	for (const event of events) {
		if (!sameExecution(event, conversationId, executionId)) continue;
		if (event.type === "execution.operation") {
			const entry = operationEntry(event);
			if (entry) {
				const previous = operations.get(entry.key);
				if (!previous || previous.sequence <= entry.sequence)
					operations.set(entry.key, entry);
			}
		} else if (event.type === "browser.handoff") {
			const entry = handoffEntry(event);
			if (entry) handoffs.set(entry.key, entry);
		} else if (event.type === "browser.side_effect") {
			const entry = sideEffectEntry(event);
			if (entry) {
				const previous = sideEffects.get(entry.key);
				if (!previous || previous.sequence <= entry.sequence)
					sideEffects.set(entry.key, entry);
			}
		}
	}
	return [...operations.values(), ...handoffs.values(), ...sideEffects.values()]
		.sort((left, right) => left.sequence - right.sequence)
		.slice(-MAX_BROWSER_AUDIT_ENTRIES);
}

function statusIcon(entry: BrowserAuditEntry) {
	if (entry.severity === "danger") return <AlertTriangle aria-hidden="true" />;
	if (entry.status === "completed" || entry.status === "confirmed")
		return <CheckCircle2 aria-hidden="true" />;
	if (entry.status === "pending") return <ShieldCheck aria-hidden="true" />;
	return <Clock3 aria-hidden="true" />;
}

const kindLabels: Record<BrowserAuditKind, string> = {
	operation: "Browser 操作",
	handoff: "浏览器接管",
	side_effect: "外部副作用",
};

function displayTime(value: string): string {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed)
		? new Date(parsed).toLocaleString("zh-CN")
		: "时间待核实";
}

export function BrowserAuditView({
	conversationId,
	events,
	executionId,
}: {
	readonly conversationId?: string;
	readonly events: readonly PersistedConversationEventV2[];
	readonly executionId?: string;
}) {
	const entries = browserAuditEntries(events, conversationId, executionId);
	if (entries.length === 0) return null;
	return (
		<section aria-labelledby="browser-audit-heading" className="mt-3">
			<div className="mb-2">
				<h2 id="browser-audit-heading" className="font-medium">
					Browser 审计与恢复
				</h2>
				<p className="text-muted-foreground text-xs">
					只读显示当前执行的服务端 Browser 事实；结果待核实不会自动重放。
				</p>
			</div>
			<ol className="space-y-2" aria-label="Browser 审计记录">
				{entries.map((entry) => (
					<li key={entry.key}>
						<Alert
							variant={entry.severity === "danger" ? "destructive" : "default"}
							aria-label={`${kindLabels[entry.kind]}：${entry.statusLabel}`}
						>
							{statusIcon(entry)}
							<AlertTitle>
								{kindLabels[entry.kind]} · {entry.statusLabel}
							</AlertTitle>
							<AlertDescription>
								<time dateTime={entry.occurredAt}>
									{displayTime(entry.occurredAt)}
								</time>
								<span className="ml-2">{entry.detail}</span>
							</AlertDescription>
						</Alert>
					</li>
				))}
			</ol>
		</section>
	);
}
