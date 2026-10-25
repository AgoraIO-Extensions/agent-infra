import { useQuery, useQueryClient } from "@tanstack/react-query";

import { retainContent } from "../background-read.js";
import {
	type DeploymentConfigurationState,
	isRetryableDeploymentConfigurationError,
	loadDeploymentConfiguration,
} from "./deployment-configuration.js";

const deploymentConfigurationQueryKey = ["deployment-configuration"] as const;

export function useDeploymentConfiguration() {
	return useQuery({
		queryKey: deploymentConfigurationQueryKey,
		queryFn: () => loadDeploymentConfiguration(),
		retry: false,
	});
}

/**
 * 部署配置的派生读取（Owner 配置的模型目录与环境变量名、模板显示名、申请表单的端点与模型显示名）按
 * 后台重读规则取结果（#3387、#3418，docs/development/web-ui.md「组件与调用方」）：读到过 ready 结果后，
 * 回到标签页、窗口重新聚焦或失效重取遇到可重试的失败（503、网络中断）继续用上一次结果；没有结果、
 * 失败不可重试（登录失效、无权、响应无效）时为当前结果。
 *
 * 读取函数把 503 写成 `{ kind: "unavailable" }` 结果（缓存里的上一次结果被替换），网络中断则抛出，
 * 两种都按 retainContent 保留。记录挂在共享查询本身上：所有页面共用同一次读取，查询被移除后不带到新查询。
 * 申请表单的部署状态说明仍按当前读取结果（N12-01），不使用这里的结果。
 */
export function useShownDeploymentConfiguration() {
	const queryClient = useQueryClient();
	const query = useDeploymentConfiguration();
	const owner = queryClient
		.getQueryCache()
		.find({ queryKey: deploymentConfigurationQueryKey, exact: true });
	const current: DeploymentConfigurationState | undefined = query.isError
		? {
				kind: "unavailable",
				retryable: isRetryableDeploymentConfigurationError(query.error),
			}
		: query.data;
	const shown = owner
		? retainContent(owner, current, {
				isContent: (state) => state?.kind === "ready",
				isRetryableFailure: (state) =>
					state?.kind === "unavailable" && state.retryable,
				updatedAt: query.isError ? query.errorUpdatedAt : query.dataUpdatedAt,
			})
		: current;
	return { query, shown };
}
