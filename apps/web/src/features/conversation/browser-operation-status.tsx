import { AlertTriangle, CheckCircle2, Clock3 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { PersistedConversationEventV2 } from "../../pilot/generated-v2/types.gen.js";

export type BrowserOperationStatusState = Readonly<{
	readonly phase: "intent" | "started" | "completed" | "failed" | "unknown";
	readonly operation: string;
}>;

function operationKey(
	event: Extract<PersistedConversationEventV2, { type: "execution.operation" }>,
) {
	return `${event.payload.operationRef}:${event.payload.attemptRef}`;
}

/**
 * Reduce only server-validated Browser facts for one Execution. The timeline
 * may contain the same operation in its snapshot and in a later SSE replay;
 * the last fact for an operation/attempt is the current read-only projection.
 */
export function latestBrowserOperationStatus(
	events: readonly PersistedConversationEventV2[],
	executionId: string | undefined,
): BrowserOperationStatusState | undefined {
	if (!executionId) return undefined;
	const latest = new Map<
		string,
		Extract<PersistedConversationEventV2, { type: "execution.operation" }>
	>();
	for (const event of events) {
		if (
			event.type !== "execution.operation" ||
			event.executionId !== executionId ||
			event.payload.kind !== "tool" ||
			!event.payload.browser
		)
			continue;
		latest.set(operationKey(event), event);
	}
	const event = [...latest.values()].at(-1);
	if (event?.payload.kind !== "tool" || !event.payload.browser)
		return undefined;
	return {
		phase: event.payload.phase,
		operation: event.payload.toolId,
	};
}

const phaseLabels = {
	intent: "正在受理",
	started: "正在执行",
	completed: "已完成",
	failed: "执行失败",
	unknown: "结果待核实",
} as const;

export function BrowserOperationStatus({
	events,
	executionId,
}: {
	readonly events: readonly PersistedConversationEventV2[];
	readonly executionId?: string;
}) {
	const status = latestBrowserOperationStatus(events, executionId);
	if (!status) return null;
	const destructive = status.phase === "failed" || status.phase === "unknown";
	return (
		<Alert
			aria-live="polite"
			aria-atomic="true"
			variant={destructive ? "destructive" : "default"}
			className="mt-3"
		>
			{destructive ? (
				<AlertTriangle aria-hidden="true" />
			) : status.phase === "completed" ? (
				<CheckCircle2 aria-hidden="true" />
			) : (
				<Clock3 aria-hidden="true" />
			)}
			<AlertTitle>Browser 工作流 · {phaseLabels[status.phase]}</AlertTitle>
			<AlertDescription>
				操作：{status.operation}
				{status.phase === "unknown"
					? "。结果未确认，系统不会自动重放。"
					: status.phase === "completed"
						? "。状态来自服务端执行事实。"
						: "。"}
			</AlertDescription>
		</Alert>
	);
}
