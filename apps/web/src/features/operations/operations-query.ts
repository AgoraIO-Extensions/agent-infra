import type {
	OperationsEntryState,
	OperationsStatus,
} from "./operations-entry.js";

type ObservabilityStatusProjection = {
	readonly schemaVersion: 1;
	readonly service: "platform-api";
	readonly enabled: boolean;
	readonly state: "active" | "closing" | "closed";
	readonly captureFailures: number;
	readonly exportFailures: number;
	readonly droppedLogs: number;
	readonly invalidRecords: number;
	readonly lastExportFailureAt?: string;
};

function isProjection(value: unknown): value is ObservabilityStatusProjection {
	if (typeof value !== "object" || value === null) return false;
	const item = value as Record<string, unknown>;
	return (
		item.schemaVersion === 1 &&
		item.service === "platform-api" &&
		typeof item.enabled === "boolean" &&
		["active", "closing", "closed"].includes(String(item.state)) &&
		[
			"captureFailures",
			"exportFailures",
			"droppedLogs",
			"invalidRecords",
		].every((key) => Number.isSafeInteger(item[key]) && Number(item[key]) >= 0)
	);
}

function statusFor(
	status: ObservabilityStatusProjection,
): OperationsEntryState {
	if (!status.enabled || status.state !== "active")
		return { kind: "unavailable", message: "观测服务当前不可用。" };
	const degraded =
		status.captureFailures > 0 ||
		status.exportFailures > 0 ||
		status.droppedLogs > 0 ||
		status.invalidRecords > 0;
	return {
		kind: "ready",
		statuses: {
			health: "unknown",
			agents: "unknown",
			delivery: "unknown",
			alerts: degraded ? "degraded" : "unknown",
		},
	};
}

export async function fetchOperationsStatus(): Promise<OperationsEntryState> {
	let response: Response;
	try {
		response = await fetch("/api/v1/ops/observability", {
			headers: { accept: "application/json" },
		});
	} catch {
		return { kind: "unavailable", message: "观测服务当前不可用。" };
	}
	if (response.status === 503)
		return { kind: "unavailable", message: "观测服务当前不可用。" };
	if (!response.ok)
		return { kind: "error", message: "观测状态查询失败。", retryable: true };
	let value: unknown;
	try {
		value = await response.json();
	} catch {
		return { kind: "error", message: "观测状态响应无效。", retryable: true };
	}
	return isProjection(value)
		? statusFor(value)
		: { kind: "error", message: "观测状态响应无效。", retryable: true };
}
