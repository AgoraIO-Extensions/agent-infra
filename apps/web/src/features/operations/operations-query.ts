import { ObservabilityStatusProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { getObservabilityStatus } from "../../pilot/generated/sdk.gen.js";
import type { OperationsEntryState } from "./operations-entry.js";

const unavailableMessage = "观测服务当前不可用。";
const unrecognizedMessage = "观测状态响应无法识别，请稍后重试。";

/**
 * 正式观测查询只返回 Platform API 观测采集与导出的独立健康信号（工程 Spec §18.2）。
 * 它只决定告警区块的 chip 与事实；健康、Agent 与任务、依赖三块在 M1 没有数据源，
 * 保持「未接入」，不从这里推导或补零（F-12）。
 */
function stateFor(value: unknown): OperationsEntryState {
	const parsed = ObservabilityStatusProjectionV1Schema.safeParse(value);
	if (!parsed.success)
		return { kind: "unavailable", message: unrecognizedMessage };
	const status = parsed.data;
	if (!status.enabled || status.state !== "active")
		return { kind: "unavailable", message: unavailableMessage };
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
			dependencies: "unknown",
			alerts: degraded ? "degraded" : "unknown",
		},
		collection: {
			captureFailures: status.captureFailures,
			exportFailures: status.exportFailures,
			droppedLogs: status.droppedLogs,
			invalidRecords: status.invalidRecords,
			...(status.lastExportFailureAt
				? { lastExportFailureAt: status.lastExportFailureAt }
				: {}),
		},
	};
}

/** 只经生成的 V1 Client（getObservabilityStatus，#3058）读取；响应按同一份契约 Schema 校验。 */
export async function fetchOperationsStatus(): Promise<OperationsEntryState> {
	const result = await getObservabilityStatus({ throwOnError: false });
	const status = result.response?.status;
	// 没有响应：网络失败，按观测服务不可用处理。
	if (status === undefined)
		return { kind: "unavailable", message: unavailableMessage };
	// 权限以服务端为准：会话角色过期时查询返回 403，页面显示无权限卡。
	if (status === 403) return { kind: "denied" };
	// 部署没有提供查询入口：页面级「未接入」，不当作可重试的故障。
	if (status === 404) return { kind: "not-connected" };
	if (status === 503)
		return { kind: "unavailable", message: unavailableMessage };
	if (!result.response?.ok)
		return {
			kind: "unavailable",
			message: "暂时无法读取观测状态，请稍后重试。",
		};
	// 2xx 但正文无法解析时生成 Client 只返回 error；与不符合契约的正文同样提示无法识别。
	if (result.error !== undefined)
		return { kind: "unavailable", message: unrecognizedMessage };
	return stateFor(result.data);
}
