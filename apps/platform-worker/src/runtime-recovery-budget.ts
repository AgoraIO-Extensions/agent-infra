/**
 * #3373：unknown 恢复的墙钟预算（毫秒），来自 `PLATFORM_WORKER_RUNTIME_RECOVERY_BUDGET_MS`。
 * 未设置时返回 undefined，由 Core 使用默认的 5 分钟；只接受 1 到 86400000 之间的十进制整数，
 * 其他取值拒绝启动。
 */
export function runtimeRecoveryBudgetMs(value: string | undefined) {
	if (value === undefined || value === "") return undefined;
	const parsed = /^[1-9][0-9]{0,7}$/.test(value) ? Number(value) : Number.NaN;
	if (!Number.isSafeInteger(parsed) || parsed > 86_400_000)
		throw new Error(
			"PLATFORM_WORKER_RUNTIME_RECOVERY_BUDGET_MS must be an integer between 1 and 86400000",
		);
	return parsed;
}
