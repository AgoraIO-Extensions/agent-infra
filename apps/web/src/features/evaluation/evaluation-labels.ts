export const scoreStateLabels: Record<string, string> = {
	waiting_output: "等待任务结果",
	pending: "等待评分",
	result_ready: "评分结果待保存",
	awaiting_human: "等待人工评分",
	scored: "已评分",
	not_applicable: "不适用",
	failed: "评分失败",
	unknown: "评分待核实",
};
export const taskStateLabels: Record<string, string> = {
	waiting: "排队中",
	submitted: "已受理",
	processing: "执行中",
	completed: "已完成",
	failed: "执行失败",
	cancelled: "已取消",
	unknown: "执行待核实",
};
export const sourceLabels: Record<string, string> = {
	rule: "规则评分",
	human: "人工评分",
	model: "模型评分",
};
export const comparisonLabels: Record<string, string> = {
	comparable: "可比较",
	missing_conditions: "实际条件缺失",
	different_environment: "工具环境不同",
	mixed_conditions: "包含多个实际模型条件",
	unknown_target: "比较证据不足",
	actual_drift: "实际条件偏离请求",
	non_target_drift: "非比较目标条件发生变化",
};
export const contentLabels: Record<string, string> = {
	expired: "内容已到期",
	deleting: "内容正在删除",
	deleted: "内容已删除",
};
export const feedbackLabels = {
	correctness: "正确性",
	relevance: "相关性",
	instruction_following: "指令遵循",
	format: "格式",
	tool_use: "工具使用",
	incomplete: "结果不完整",
	performance: "响应速度",
	other: "其他",
} as const;
export const percentage = (value: number | null) =>
	value === null ? "无样本" : `${(value * 100).toFixed(1)}%`;
