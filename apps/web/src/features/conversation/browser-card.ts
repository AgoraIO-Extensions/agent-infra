import { withObjectName } from "@/lib/accessible-name";
import { cjkSpaced } from "@/lib/cjk-spacing";
import type { ChipTone } from "@/lib/status-tone";
import type { PersistedConversationEventV2 } from "../../pilot/generated-v2/types.gen.js";
import {
	type BrowserHandoffReason,
	boundedBrowserText,
	browserHandoffReasonLabels,
	browserHandoffStatusLabels,
	browserOriginHost,
	browserSideEffectLabel,
	browserSideEffectStatusLabels,
	browserToolLabel,
	browserToolProgress,
} from "./browser-labels.js";
import type { ConversationTimelineEventV2 } from "./conversation-timeline.js";

export type BrowserOperationEvent = Extract<
	PersistedConversationEventV2,
	{ type: "execution.operation" }
>;
export type BrowserHandoffEvent = Extract<
	PersistedConversationEventV2,
	{ type: "browser.handoff" }
>;
export type BrowserSideEffectEvent = Extract<
	PersistedConversationEventV2,
	{ type: "browser.side_effect" }
>;

export type BrowserCardPhase =
	| "idle"
	| "request"
	| "handoff"
	| "running"
	| "complete"
	| "denied"
	| "stopped"
	| "unknown";

/** 卡片动作只携带服务端给出的不透明 ID；请求体由对话页装配统一构造。 */
export type BrowserCardCommand =
	| {
			readonly kind: "confirm_side_effect" | "reject_side_effect";
			readonly confirmationId: string;
	  }
	| {
			readonly kind: "take_over" | "return_to_agent" | "revoke";
			readonly handoffId: string;
	  }
	| { readonly kind: "stop_execution" };

export type BrowserCardAction = Readonly<{
	label: string;
	/** 可访问名称；同时出现多个同名按钮时带上操作对象。 */
	accessibleName?: string;
	variant: "default" | "ghost" | "outline";
	icon?: "stop";
	command: BrowserCardCommand;
}>;

export type BrowserCard = Readonly<{
	phase: BrowserCardPhase;
	title: string;
	body: string;
	status: string;
	tone: ChipTone;
	meta: ReadonlyArray<Readonly<{ label: string; value: string }>>;
	/** 卡内时间线「请求已确认 / 页面已打开 / 结果已回读」中已激活的步数。 */
	timeline?: 1 | 2 | 3;
	actions: readonly BrowserCardAction[];
	/** 阶段会因到期而变化的时间点；组件据此在到期时重新计算。 */
	expiresAt?: string;
}>;

type Binding = BrowserHandoffEvent["payload"]["binding"];

const digestPattern = /^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/u;

/** 只做事件自身的结构校验；不再拿另一事件的 binding 做相等比较（页面版本变化不构成阻断）。 */
export function validBrowserBinding(
	binding: Binding | undefined,
	event: Pick<PersistedConversationEventV2, "conversationId" | "executionId">,
): boolean {
	return (
		typeof binding === "object" &&
		binding !== null &&
		[
			binding.subjectId,
			binding.agentId,
			binding.conversationId,
			binding.executionId,
		].every((value) => typeof value === "string" && value.length > 0) &&
		[
			binding.sessionGeneration,
			binding.resourceFence,
			binding.workloadRevision,
			binding.capabilityVersion,
			binding.capabilityRevision,
			binding.pageRevision,
		].every((value) => Number.isSafeInteger(value) && value >= 1) &&
		typeof binding.imageDigest === "string" &&
		digestPattern.test(binding.imageDigest) &&
		binding.conversationId === event.conversationId &&
		binding.executionId === event.executionId
	);
}

export function validBrowserHandoffEvent(event: BrowserHandoffEvent): boolean {
	const { payload } = event;
	return (
		typeof payload.handoffId === "string" &&
		payload.handoffId.length > 0 &&
		Object.hasOwn(browserHandoffStatusLabels, payload.status) &&
		Object.hasOwn(browserHandoffReasonLabels, payload.reason) &&
		Number.isFinite(Date.parse(payload.expiresAt)) &&
		validBrowserBinding(payload.binding, event)
	);
}

export function validBrowserSideEffectEvent(
	event: BrowserSideEffectEvent,
): boolean {
	const { payload } = event;
	return (
		typeof payload.confirmationId === "string" &&
		payload.confirmationId.length > 0 &&
		Object.hasOwn(browserSideEffectStatusLabels, payload.status) &&
		Number.isFinite(Date.parse(payload.expiresAt)) &&
		validBrowserBinding(payload.binding, event) &&
		payload.binding.confirmationId === payload.confirmationId &&
		Boolean(browserOriginHost(payload.targetOrigin)) &&
		Boolean(boundedBrowserText(payload.redactedTargetSummary))
	);
}

export function isBrowserOperationEvent(
	event: ConversationTimelineEventV2,
): event is BrowserOperationEvent {
	return (
		event.type === "execution.operation" &&
		event.payload.kind === "tool" &&
		Boolean(event.payload.browser)
	);
}

export function browserEventsForExecution(
	events: readonly ConversationTimelineEventV2[],
	conversationId: string | undefined,
	executionId: string | undefined,
) {
	if (!executionId) return [];
	return events.filter(
		(
			event,
		): event is
			| BrowserOperationEvent
			| BrowserHandoffEvent
			| BrowserSideEffectEvent =>
			event.kind === "event" &&
			event.executionId === executionId &&
			(conversationId === undefined ||
				event.conversationId === conversationId) &&
			(isBrowserOperationEvent(event) ||
				event.type === "browser.handoff" ||
				event.type === "browser.side_effect"),
	);
}

function generation(
	event: BrowserOperationEvent | BrowserHandoffEvent | BrowserSideEffectEvent,
) {
	if (event.type === "execution.operation")
		return event.payload.kind === "tool"
			? (event.payload.browser?.sessionGeneration ?? 0)
			: 0;
	return event.payload.binding.sessionGeneration;
}

function latestBy<T extends { sequence: number }>(
	map: Map<string, T>,
	key: string,
	event: T,
) {
	const previous = map.get(key);
	if (!previous || previous.sequence <= event.sequence) map.set(key, event);
}

function newest<T extends { sequence: number }>(items: Iterable<T>) {
	let result: T | undefined;
	for (const item of items)
		if (!result || item.sequence > result.sequence) result = item;
	return result;
}

const idleCard: BrowserCard = {
	phase: "idle",
	title: "浏览器操作",
	body: "Agent 可以请求查看页面或执行浏览器操作。开始前会显示域名、操作范围和风险。",
	status: "可请求",
	tone: "gray",
	meta: [],
	actions: [],
};

const unknownCard: BrowserCard = {
	phase: "unknown",
	title: "浏览器结果待核实",
	body: "连接中断，暂时无法确认页面操作是否完成。不会自动重试。",
	status: "待核实",
	tone: "red",
	meta: [],
	timeline: 1,
	actions: [],
};

function stoppedCard(body: string): BrowserCard {
	return {
		phase: "stopped",
		title: "浏览器操作已停止",
		body,
		status: "已停止",
		tone: "red",
		meta: [],
		actions: [],
	};
}

const stoppedBody = "操作已停止，页面是否产生变化需要重新核实。";
const unavailableBody = "浏览器当前不可用，这次操作不会执行。";
const expiredBody = "请求已过期，这次操作不会执行。";

function sideEffectMeta(event: BrowserSideEffectEvent) {
	const host = browserOriginHost(event.payload.targetOrigin) ?? "";
	return [
		{ label: "域名", value: host },
		{
			label: "操作",
			value: browserSideEffectLabel(event.payload.operation),
		},
		{
			label: "范围",
			value: `${boundedBrowserText(event.payload.redactedTargetSummary)} · 会产生外部操作`,
		},
	];
}

function stopAction(): BrowserCardAction {
	return {
		label: "停止操作",
		variant: "outline",
		icon: "stop",
		command: { kind: "stop_execution" },
	};
}

/**
 * 从已授权的会话时间线里为当前 Execution 选出唯一一张浏览器卡。
 *
 * - 只看当前 Execution、且只看最新 sessionGeneration 的事件；旧执行的接管与确认不会常驻。
 * - 每个对象（操作尝试 / 接管 / 确认）按 sequence 取最新状态。
 * - 任一对象待核实或结构无法核验时 fail closed：显示「浏览器结果待核实」，没有任何动作。
 * - 到期与能力判断只作用于仍在等待处理的请求（pending 确认、requested/active 接管）；
 *   终态直接按状态显示，不会因为过期或能力变化变成阻断。
 */
export function selectBrowserCard({
	events,
	conversationId,
	executionId,
	browserAvailable,
	now,
}: {
	readonly events: readonly ConversationTimelineEventV2[];
	readonly conversationId?: string;
	readonly executionId?: string;
	readonly browserAvailable: boolean;
	readonly now: number;
}): BrowserCard | undefined {
	const candidates = browserEventsForExecution(
		events,
		conversationId,
		executionId,
	);
	if (candidates.length === 0) return browserAvailable ? idleCard : undefined;
	for (const event of candidates) {
		if (event.type === "browser.handoff" && !validBrowserHandoffEvent(event))
			return unknownCard;
		if (
			event.type === "browser.side_effect" &&
			!validBrowserSideEffectEvent(event)
		)
			return unknownCard;
	}
	const latestGeneration = Math.max(...candidates.map(generation));
	const current = candidates.filter(
		(event) => generation(event) === latestGeneration,
	);
	const operations = new Map<string, BrowserOperationEvent>();
	const handoffs = new Map<string, BrowserHandoffEvent>();
	const sideEffects = new Map<string, BrowserSideEffectEvent>();
	for (const event of current) {
		if (event.type === "execution.operation") {
			if (event.payload.kind === "tool")
				latestBy(
					operations,
					`${event.payload.operationRef}:${event.payload.attemptRef}`,
					event,
				);
		} else if (event.type === "browser.handoff")
			latestBy(handoffs, event.payload.handoffId, event);
		else latestBy(sideEffects, event.payload.confirmationId, event);
	}
	if (
		[...operations.values()].some(
			(event) => event.payload.phase === "unknown",
		) ||
		[...handoffs.values()].some(
			(event) => event.payload.status === "unknown",
		) ||
		[...sideEffects.values()].some(
			(event) => event.payload.status === "unknown",
		)
	)
		return unknownCard;

	const expired = (expiresAt: string) => now >= Date.parse(expiresAt);
	const handoffStatus = (event: BrowserHandoffEvent) =>
		(event.payload.status === "requested" ||
			event.payload.status === "active") &&
		expired(event.payload.expiresAt)
			? "expired"
			: event.payload.status;
	const sideEffectStatus = (event: BrowserSideEffectEvent) =>
		event.payload.status === "pending" && expired(event.payload.expiresAt)
			? "expired"
			: event.payload.status;

	// 未结束的接管优先：接管期间不开放副作用确认（沿用原有规则，表现为接管卡而不是红色阻断）。
	const openHandoff = newest(
		[...handoffs.values()].filter((event) =>
			["requested", "active", "returning"].includes(handoffStatus(event)),
		),
	);
	if (openHandoff) {
		const status = handoffStatus(openHandoff);
		if (status === "returning")
			return {
				phase: "running",
				title: "浏览器操作进行中",
				body: "控制权正在交还给 Agent。你可以随时停止。",
				status: "执行中",
				tone: "blue",
				meta: [],
				timeline: 2,
				actions: [stopAction()],
			};
		if (!browserAvailable) return stoppedCard(unavailableBody);
		const label =
			browserHandoffReasonLabels[
				openHandoff.payload.reason as BrowserHandoffReason
			];
		const handoffId = openHandoff.payload.handoffId;
		return {
			phase: "handoff",
			title: "需要你接管浏览器",
			// 中西文之间留空格：「完成 MFA 验证」「完成 CAPTCHA 验证」，中文开头的「完成登录」不加。
			body:
				status === "requested"
					? cjkSpaced`请接管浏览器完成${label}，然后把控制权交还给 Agent。接管期间 Agent 不会操作页面。`
					: cjkSpaced`请在浏览器中完成${label}，然后把控制权交还给 Agent。`,
			status: status === "requested" ? "等待接管" : "已接管",
			tone: "amber",
			meta: [],
			actions:
				status === "requested"
					? [
							{
								label: "接管浏览器",
								variant: "default",
								command: { kind: "take_over", handoffId },
							},
							{
								label: "停止",
								accessibleName: "停止接管",
								variant: "ghost",
								command: { kind: "revoke", handoffId },
							},
						]
					: [
							{
								label: "交还给 Agent",
								variant: "default",
								command: { kind: "return_to_agent", handoffId },
							},
							{
								label: "停止",
								accessibleName: "停止接管",
								variant: "ghost",
								command: { kind: "revoke", handoffId },
							},
						],
			expiresAt: openHandoff.payload.expiresAt,
		};
	}

	const pending = newest(
		[...sideEffects.values()].filter(
			(event) => sideEffectStatus(event) === "pending",
		),
	);
	if (pending) {
		if (!browserAvailable) return stoppedCard(unavailableBody);
		// 最近一次接管被停止、过期或浏览器崩溃时，不开放副作用确认（沿用原有阻断规则）。
		const lastHandoff = newest(handoffs.values());
		if (
			lastHandoff &&
			["revoked", "expired", "crashed"].includes(handoffStatus(lastHandoff))
		)
			return stoppedCard(
				"浏览器接管已结束，这次操作不会执行。请让 Agent 重新发起请求。",
			);
		const meta = sideEffectMeta(pending);
		const target = `${browserSideEffectLabel(pending.payload.operation)} ${meta[0]?.value ?? ""}`;
		const confirmationId = pending.payload.confirmationId;
		return {
			phase: "request",
			title: "浏览器操作请求",
			body: "请确认这次操作范围，确认前不会执行。",
			status: "等待确认",
			tone: "amber",
			meta,
			actions: [
				{
					label: "允许这次操作",
					accessibleName: withObjectName("允许这次操作", target),
					variant: "default",
					command: { kind: "confirm_side_effect", confirmationId },
				},
				{
					label: "拒绝",
					accessibleName: withObjectName("拒绝", target),
					variant: "ghost",
					command: { kind: "reject_side_effect", confirmationId },
				},
			],
			expiresAt: pending.payload.expiresAt,
		};
	}

	const latest = newest<
		BrowserOperationEvent | BrowserHandoffEvent | BrowserSideEffectEvent
	>([
		...operations.values(),
		...sideEffects.values(),
		// 已交回 Agent 的接管不再单独成卡。
		...[...handoffs.values()].filter(
			(event) => event.payload.status !== "completed",
		),
	]);
	if (!latest) return browserAvailable ? idleCard : undefined;
	if (latest.type === "execution.operation") {
		if (latest.payload.kind !== "tool") return unknownCard;
		const { phase, toolId } = latest.payload;
		if (phase === "intent" || phase === "started")
			return {
				phase: "running",
				title: "浏览器操作进行中",
				body: `Agent 正在${browserToolProgress(toolId)}。你可以随时停止。`,
				status: "执行中",
				tone: "blue",
				meta: [{ label: "操作", value: browserToolLabel(toolId) }],
				timeline: phase === "intent" ? 1 : 2,
				actions: [stopAction()],
			};
		if (phase === "completed")
			return {
				phase: "complete",
				title: "浏览器操作已完成",
				body: "页面结果已经回到当前会话。",
				status: "已完成",
				tone: "green",
				meta: [],
				timeline: 3,
				actions: [],
			};
		return stoppedCard("操作没有完成，页面是否产生变化需要重新核实。");
	}
	if (latest.type === "browser.side_effect") {
		const status = sideEffectStatus(latest);
		if (status === "confirmed")
			return {
				phase: "running",
				title: "浏览器操作进行中",
				body: "Agent 正在执行已允许的操作。你可以随时停止。",
				status: "执行中",
				tone: "blue",
				meta: sideEffectMeta(latest),
				timeline: 2,
				actions: [stopAction()],
			};
		if (status === "rejected")
			return {
				phase: "denied",
				title: "浏览器操作已拒绝",
				body: "这次操作没有执行，也没有产生外部操作。",
				status: "已拒绝",
				tone: "red",
				meta: [],
				actions: [],
			};
		return stoppedCard(status === "expired" ? expiredBody : stoppedBody);
	}
	const status = handoffStatus(latest);
	return stoppedCard(
		status === "expired"
			? expiredBody
			: status === "crashed"
				? "浏览器已中断，页面是否产生变化需要重新核实。"
				: stoppedBody,
	);
}
