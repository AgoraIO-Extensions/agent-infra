import { PersistedConversationEventV2Schema } from "@agent-infra/contracts/pilot";
import type { PersistedConversationEventV2 } from "../../pilot/generated-v2/types.gen.js";
import type { BrowserHandoffReason } from "./browser-labels.js";

// 浏览器卡与操作记录单测共用的受控事件；只用合成 ID，不含任何真实凭据。
// unchecked 用于构造契约之外的输入，验证前端在服务端校验之外仍然 fail closed。
function parse(value: unknown, unchecked = false) {
	return (
		unchecked ? value : PersistedConversationEventV2Schema.parse(value)
	) as PersistedConversationEventV2;
}
export const browserTestNow = Date.parse("2026-10-11T10:00:00.000Z");
const occurredAt = "2026-10-11T09:59:00.000Z";
const expiresAt = "2026-10-11T12:00:00.000Z";

export const browserBinding = {
	subjectId: "subject-1",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	sessionGeneration: 2,
	resourceFence: 7,
	workloadRevision: 4,
	imageDigest: `sha256:${"a".repeat(64)}`,
	capabilityVersion: 1,
	capabilityRevision: 1,
	pageRevision: 4,
};

function base(
	sequence: number,
	executionId: string,
	conversationId = "conversation-1",
) {
	return {
		schemaVersion: 1,
		kind: "event",
		eventId: `browser-event-${executionId}-${sequence}`,
		conversationId,
		executionId,
		sequence,
		conversationCursor: `browser-cursor-${executionId}-${sequence}`,
		occurredAt,
	};
}

export function operationEvent(
	sequence: number,
	phase: "intent" | "started" | "completed" | "failed" | "unknown",
	{
		executionId = "execution-1",
		toolId = "browser_navigate",
		operationRef = "operation-1",
		attemptRef = "attempt-1",
		sessionGeneration = 2,
	}: {
		executionId?: string;
		toolId?: string;
		operationRef?: string;
		attemptRef?: string;
		sessionGeneration?: number;
	} = {},
): PersistedConversationEventV2 {
	return parse({
		...base(sequence, executionId),
		schemaVersion: 2,
		type: "execution.operation",
		payload: {
			kind: "tool",
			operationRef,
			attemptRef,
			phase,
			toolId,
			browser: {
				actionId: `action-${operationRef}`,
				capabilityVersion: 1,
				pageRevision: 4,
				resourceFence: 7,
				sessionGeneration,
				sideEffect: false,
			},
		},
	});
}

export function handoffEvent(
	sequence: number,
	status:
		| "requested"
		| "active"
		| "returning"
		| "completed"
		| "revoked"
		| "expired"
		| "crashed"
		| "unknown",
	{
		executionId = "execution-1",
		handoffId = "handoff-1",
		pageRevision = 4,
		expires = expiresAt,
		binding = {},
		reason = "mfa",
		unchecked = false,
	}: {
		executionId?: string;
		handoffId?: string;
		pageRevision?: number;
		expires?: string;
		binding?: Record<string, unknown>;
		reason?: BrowserHandoffReason;
		unchecked?: boolean;
	} = {},
): PersistedConversationEventV2 {
	return parse(
		{
			...base(sequence, executionId),
			schemaVersion: 2,
			type: "browser.handoff",
			payload: {
				handoffId,
				status,
				reason,
				requestedAt: occurredAt,
				expiresAt: expires,
				operatorId: "operator-secret-1",
				binding: {
					...browserBinding,
					executionId,
					pageRevision,
					...binding,
				},
			},
		},
		unchecked,
	);
}

export function sideEffectEvent(
	sequence: number,
	status:
		| "pending"
		| "confirmed"
		| "rejected"
		| "cancelled"
		| "expired"
		| "unknown",
	{
		executionId = "execution-1",
		confirmationId = "confirmation-1",
		operation = "submit",
		targetOrigin = "https://example.test",
		summary = "提交公开表单（已脱敏）",
		pageRevision = 4,
		expires = expiresAt,
		binding = {},
		unchecked = false,
	}: {
		executionId?: string;
		confirmationId?: string;
		operation?: string;
		targetOrigin?: string;
		summary?: string;
		pageRevision?: number;
		expires?: string;
		binding?: Record<string, unknown>;
		unchecked?: boolean;
	} = {},
): PersistedConversationEventV2 {
	return parse(
		{
			...base(sequence, executionId),
			schemaVersion: 2,
			type: "browser.side_effect",
			payload: {
				confirmationId,
				status,
				requestedAt: occurredAt,
				expiresAt: expires,
				operation,
				targetOrigin,
				redactedTargetSummary: summary,
				binding: {
					...browserBinding,
					executionId,
					pageRevision,
					actionId: "action-side-effect-1",
					confirmationId,
					operationRef: "operation-side-effect-1",
					attemptRef: "attempt-side-effect-1",
					...binding,
				},
			},
		},
		unchecked,
	);
}
