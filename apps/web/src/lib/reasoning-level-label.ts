export type ReasoningLevel = "low" | "medium" | "high" | "xhigh" | "max";

// 穷举映射：新增推理强度时这里必须同步补中文，否则类型检查失败。
const reasoningLevelLabels: Record<ReasoningLevel, string> = {
	low: "低",
	medium: "均衡",
	high: "高",
	xhigh: "极高",
	max: "最高",
};

/** 推理强度的唯一中文映射；未知值显示「其他」，原值不进入页面。 */
export function reasoningLevelLabel(level: string) {
	return Object.hasOwn(reasoningLevelLabels, level)
		? reasoningLevelLabels[level as ReasoningLevel]
		: "其他";
}
