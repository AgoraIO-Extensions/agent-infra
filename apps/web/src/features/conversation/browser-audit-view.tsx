import { Fragment, useEffect, useId, useRef, useState } from "react";
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
	DialogTrigger,
} from "@/components/ui/dialog";
import { Timestamp } from "@/components/ui/timestamp";
import type { ChipTone } from "@/lib/status-tone";
import { formatPerson, unresolvedDirectoryLabels } from "../directory-names.js";
import {
	browserEventsForExecution,
	validBrowserHandoffEvent,
	validBrowserSideEffectEvent,
} from "./browser-card.js";
import {
	type BrowserHandoffReason,
	boundedBrowserText,
	browserHandoffReasonLabels,
	browserHandoffStatusLabels,
	browserOperationStatusLabels,
	browserOriginHost,
	browserSideEffectLabel,
	browserSideEffectStatusLabels,
	browserToolLabel,
} from "./browser-labels.js";
import type { ConversationTimelineEventV2 } from "./conversation-timeline.js";

export const MAX_BROWSER_AUDIT_ENTRIES = 50;

export type BrowserAuditKind = "operation" | "handoff" | "side_effect";

export type BrowserAuditEntry = Readonly<{
	key: string;
	sequence: number;
	occurredAt: string;
	kind: BrowserAuditKind;
	status: string;
	statusLabel: string;
	tone: ChipTone;
	title: string;
	detail?: string;
	/** 「操作范围」使用的可读动作；接管没有动作。 */
	action?: string;
	host?: string;
	reason?: string;
	/** 接管人：服务端只给 operatorId（等于会话主体本人），名称由当前登录身份解析。 */
	operatorId?: string;
}>;

/** 当前登录用户；用于把接管记录里的 operatorId 显示为姓名。 */
export type BrowserRecordViewer = Readonly<{
	userId: string;
	displayName: string;
}>;

function latest(map: Map<string, BrowserAuditEntry>, entry: BrowserAuditEntry) {
	const previous = map.get(entry.key);
	if (!previous || previous.sequence <= entry.sequence)
		map.set(entry.key, entry);
}

/**
 * 从已授权的会话时间线构造只读、有上限的浏览器操作记录。
 * 操作尝试、接管、确认三类都按对象聚合到最新 sequence；
 * 绑定与事件范围不一致、origin 带路径或凭据、摘要为空的记录直接丢弃。
 */
export function browserAuditRecords(
	events: readonly ConversationTimelineEventV2[],
	conversationId?: string,
	executionId?: string,
): { entries: readonly BrowserAuditEntry[]; truncated: boolean } {
	const objects = new Map<string, BrowserAuditEntry>();
	for (const event of browserEventsForExecution(
		events,
		conversationId,
		executionId,
	)) {
		if (event.type === "execution.operation") {
			if (event.payload.kind !== "tool") continue;
			const status = event.payload.phase;
			const action = browserToolLabel(event.payload.toolId);
			latest(objects, {
				key: `operation:${event.payload.operationRef}:${event.payload.attemptRef}`,
				sequence: event.sequence,
				occurredAt: event.occurredAt,
				kind: "operation",
				status,
				statusLabel: browserOperationStatusLabels[status].label,
				tone: browserOperationStatusLabels[status].tone,
				title: action,
				action,
			});
		} else if (event.type === "browser.handoff") {
			if (!validBrowserHandoffEvent(event)) continue;
			const { status } = event.payload;
			const reason =
				browserHandoffReasonLabels[
					event.payload.reason as BrowserHandoffReason
				];
			latest(objects, {
				key: `handoff:${event.payload.handoffId}`,
				sequence: event.sequence,
				occurredAt: event.occurredAt,
				kind: "handoff",
				status,
				statusLabel: browserHandoffStatusLabels[status].label,
				tone: browserHandoffStatusLabels[status].tone,
				title: "人工接管",
				detail: reason,
				reason,
				...(event.payload.operatorId
					? { operatorId: event.payload.operatorId }
					: {}),
			});
		} else {
			if (!validBrowserSideEffectEvent(event)) continue;
			const { status } = event.payload;
			const host = browserOriginHost(event.payload.targetOrigin);
			const action = browserSideEffectLabel(event.payload.operation);
			latest(objects, {
				key: `side-effect:${event.payload.confirmationId}`,
				sequence: event.sequence,
				occurredAt: event.occurredAt,
				kind: "side_effect",
				status,
				statusLabel: browserSideEffectStatusLabels[status].label,
				tone: browserSideEffectStatusLabels[status].tone,
				title: action,
				detail: `${host} · ${boundedBrowserText(event.payload.redactedTargetSummary)}`,
				action,
				host,
			});
		}
	}
	const sorted = [...objects.values()].sort(
		(left, right) => left.sequence - right.sequence,
	);
	return {
		entries: sorted.slice(-MAX_BROWSER_AUDIT_ENTRIES),
		truncated: sorted.length > MAX_BROWSER_AUDIT_ENTRIES,
	};
}

export function browserAuditEntries(
	events: readonly ConversationTimelineEventV2[],
	conversationId?: string,
	executionId?: string,
): readonly BrowserAuditEntry[] {
	return browserAuditRecords(events, conversationId, executionId).entries;
}

const unique = (values: readonly (string | undefined)[]) => [
	...new Set(values.filter((value): value is string => Boolean(value))),
];

/** 接管人：operatorId 即会话主体本人；与当前登录用户一致时显示姓名，否则不推测、不显示 ID。 */
function handoffOperatorName(
	operatorId: string,
	viewer: BrowserRecordViewer | undefined,
) {
	return viewer?.userId === operatorId
		? formatPerson({ displayName: viewer.displayName }).name
		: unresolvedDirectoryLabels.user;
}

/**
 * 弹窗顶部的五行事实（设计「域名 / 操作范围 / 接管人 / 结果 / 凭证」）；契约没有访问域名时不推测。
 * 接管人为「姓名 · 原因」；尚无接管人时为「接管状态 · 原因」。
 */
export function browserAuditFacts(
	entries: readonly BrowserAuditEntry[],
	viewer?: BrowserRecordViewer,
) {
	const hosts = unique(entries.map((entry) => entry.host));
	const actions = unique(entries.map((entry) => entry.action));
	const handoff = entries.findLast((entry) => entry.kind === "handoff");
	return [
		{ label: "域名", value: hosts.length ? hosts.join("、") : "未记录" },
		{
			label: "操作范围",
			value: actions.length ? actions.join("、") : "未记录",
		},
		{
			label: "接管人",
			value: !handoff
				? "无需接管"
				: handoff.operatorId
					? `${handoffOperatorName(handoff.operatorId, viewer)} · ${handoff.reason}`
					: `${handoff.statusLabel} · ${handoff.reason}`,
		},
		{ label: "结果", value: entries.at(-1)?.statusLabel ?? "未记录" },
		// 设计「不保存」超出 PRD §11.4（凭证不进入模型）、§13.1（审计不保存凭证值）与
		// 工程 Spec §11.5（Cookie、Storage 留在 RuntimeHost 内）的承诺，按 PRD 表述。
		{ label: "凭证", value: "不进入模型或平台记录" },
	] as const;
}

/** 弹窗打开期间只播报最新变化的一条，首次打开不播报。 */
function useLatestChange(entries: readonly BrowserAuditEntry[], open: boolean) {
	const [announcement, setAnnouncement] = useState("");
	const seen = useRef(new Map<string, string>());
	useEffect(() => {
		const previous = seen.current;
		const next = new Map(entries.map((entry) => [entry.key, entry.status]));
		seen.current = next;
		if (!open) {
			setAnnouncement("");
			return;
		}
		const changed = entries.findLast(
			(entry) => previous.size > 0 && previous.get(entry.key) !== entry.status,
		);
		if (changed) setAnnouncement(`${changed.title} · ${changed.statusLabel}`);
	}, [entries, open]);
	useEffect(() => {
		if (open) setAnnouncement("");
	}, [open]);
	return announcement;
}

/**
 * 只读的「浏览器操作记录」：触发按钮 + 模态弹窗。
 * 只渲染所选 Execution 的记录；打开、关闭都不发出任何写请求。
 */
export function BrowserOperationRecordDialog({
	conversationId,
	events,
	executionId,
	viewer,
}: {
	readonly conversationId?: string;
	readonly events: readonly ConversationTimelineEventV2[];
	readonly executionId?: string;
	/** 当前登录用户，用于显示接管人姓名。 */
	readonly viewer?: BrowserRecordViewer;
}) {
	const [open, setOpen] = useState(false);
	const headingId = useId();
	const { entries, truncated } = browserAuditRecords(
		events,
		conversationId,
		executionId,
	);
	const announcement = useLatestChange(entries, open);
	if (entries.length === 0) return null;
	const unknown = entries.some((entry) => entry.status === "unknown");
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger render={<Button type="button" variant="outline" />}>
				查看操作记录
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>浏览器操作记录</DialogTitle>
				</DialogHeader>
				<DialogBody>
					<dl className="conversation-facts">
						{browserAuditFacts(entries, viewer).map((fact) => (
							<Fragment key={fact.label}>
								<dt>{fact.label}</dt>
								<dd>{fact.value}</dd>
							</Fragment>
						))}
					</dl>
					<h3 id={headingId} className="browser-record-heading">
						操作步骤
					</h3>
					<ol aria-labelledby={headingId} className="browser-record-list">
						{entries.map((entry) => (
							<li key={entry.key}>
								<div className="browser-record-main">
									<strong>{entry.title}</strong>
									{entry.detail ? <span>{entry.detail}</span> : null}
									<RecordTime value={entry.occurredAt} />
								</div>
								<Badge variant="chip" tone={entry.tone}>
									{entry.statusLabel}
								</Badge>
							</li>
						))}
					</ol>
					{truncated ? (
						<p className="browser-record-note">
							仅显示最近 {MAX_BROWSER_AUDIT_ENTRIES} 条
						</p>
					) : null}
					{unknown ? (
						<p className="conversation-page-note">
							结果待核实的操作不会自动重试。
						</p>
					) : null}
					<p role="status" aria-live="polite" className="sr-only">
						{announcement}
					</p>
				</DialogBody>
				<DialogFooter>
					<DialogClose render={<Button type="button" />}>关闭</DialogClose>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function RecordTime({ value }: { readonly value: string }) {
	return Number.isFinite(Date.parse(value)) ? (
		<Timestamp value={value} />
	) : (
		<span>时间待核实</span>
	);
}
