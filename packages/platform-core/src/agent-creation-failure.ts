import {
	type AgentManagementActorContextV1,
	type AgentManagementStateV1,
	isAdministratorAgentReadAllowedV1,
	isAgentOwnerV1,
} from "./agent-management.js";
import type { WorkloadFailureReasonCodeV1 } from "./workload-reconciliation.js";

/**
 * 浏览器可见的创建失败类别（#3034）。只说明 Owner 或管理员下一步该做什么，
 * 不暴露原因码、尝试次数或 Kubernetes 状态。
 */
export type AgentCreationFailureCategoryV1 =
	/** 来源或配置与当前部署不兼容；调整配置或部署前重试不会成功。 */
	| "configuration_rejected"
	/** Agent 已启动但没有通过健康检查。 */
	| "health_check_failed"
	/** 部署资源暂不可用或没有及时就绪；可以稍后重试。 */
	| "deployment_unavailable";

/** 由管理状态的失败码与 Workload 最近一次失败原因推导唯一的类别。 */
export function agentCreationFailureCategoryV1(input: {
	readonly failureCode: AgentManagementStateV1["failureCode"];
	readonly workloadFailureReason: WorkloadFailureReasonCodeV1 | null;
}): AgentCreationFailureCategoryV1 {
	if (input.failureCode === "health_check_failed") return "health_check_failed";
	if (
		input.workloadFailureReason === "preflight_rejected" ||
		input.workloadFailureReason === "kubernetes_policy"
	)
		return "configuration_rejected";
	return "deployment_unavailable";
}

/**
 * 只有 active 的当前 Owner 或系统管理员能读取创建失败类别，并且 Agent 必须处于
 * `creation_failed`；其他情况由调用方按不存在处理，不泄漏对象是否存在。
 */
export function isAgentCreationFailureReadAllowedV1(
	actor: AgentManagementActorContextV1,
	state: Pick<AgentManagementStateV1, "ownerIds" | "status">,
): boolean {
	if (state.status !== "creation_failed") return false;
	if (isAdministratorAgentReadAllowedV1(actor)) return true;
	return (
		actor.accountStatus === "active" && isAgentOwnerV1(state, actor.userId)
	);
}
