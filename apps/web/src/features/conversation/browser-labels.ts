import type { ChipTone } from "@/lib/status-tone";

/**
 * 浏览器卡与「浏览器操作记录」共用的唯一一份可读映射。
 * toolId、副作用 operation 等内部值只在这里转换，原值不进入页面；
 * 文案对任意站点都成立，不使用设计稿里的站点示例。
 */

type Label = { readonly label: string; readonly tone: ChipTone };

// Runtime 已登记的浏览器工具；未登记的 toolId 统一为「浏览器操作」。
const toolLabels: Readonly<
	Record<string, { readonly label: string; readonly doing: string }>
> = {
	browser_navigate: { label: "打开页面", doing: "打开页面" },
	browser_observe: { label: "读取页面", doing: "读取页面" },
	browser_interact: { label: "操作页面", doing: "操作页面" },
};

/** 浏览器工具的中性动作描述。 */
export function browserToolLabel(toolId: string): string {
	return Object.hasOwn(toolLabels, toolId)
		? (toolLabels[toolId]?.label ?? "浏览器操作")
		: "浏览器操作";
}

/** Runtime 已登记的浏览器工具；执行详情据此不外露原始 toolId（Z-15）。 */
export function isBrowserToolId(toolId: string): boolean {
	return Object.hasOwn(toolLabels, toolId);
}

/** 执行中正文「Agent 正在{…}。」使用的进行时描述。 */
export function browserToolProgress(toolId: string): string {
	return Object.hasOwn(toolLabels, toolId)
		? (toolLabels[toolId]?.doing ?? "执行浏览器操作")
		: "执行浏览器操作";
}

// PRD §11.4 列出的外部副作用；其余取值显示「外部操作」，不显示原值。
const sideEffectLabels: Readonly<Record<string, string>> = {
	submit: "提交",
	publish: "发布",
	delete: "删除",
	purchase: "购买",
};

export function browserSideEffectLabel(operation: string): string {
	return Object.hasOwn(sideEffectLabels, operation)
		? (sideEffectLabels[operation] ?? "外部操作")
		: "外部操作";
}

export type BrowserHandoffReason =
	| "login"
	| "mfa"
	| "captcha"
	| "human_judgment";

export const browserHandoffReasonLabels: Readonly<
	Record<BrowserHandoffReason, string>
> = {
	login: "登录",
	mfa: "MFA 验证",
	captcha: "CAPTCHA 验证",
	human_judgment: "需要人工判断的步骤",
};

export const browserOperationStatusLabels = {
	intent: { label: "正在受理", tone: "blue" },
	started: { label: "执行中", tone: "blue" },
	completed: { label: "已完成", tone: "green" },
	failed: { label: "执行失败", tone: "red" },
	unknown: { label: "待核实", tone: "red" },
} as const satisfies Record<string, Label>;

export const browserHandoffStatusLabels = {
	requested: { label: "等待接管", tone: "amber" },
	active: { label: "接管中", tone: "amber" },
	returning: { label: "正在交回", tone: "blue" },
	completed: { label: "已交回 Agent", tone: "green" },
	revoked: { label: "已停止", tone: "red" },
	expired: { label: "已过期", tone: "gray" },
	crashed: { label: "浏览器已崩溃", tone: "red" },
	unknown: { label: "待核实", tone: "red" },
} as const satisfies Record<string, Label>;

export const browserSideEffectStatusLabels = {
	pending: { label: "等待确认", tone: "amber" },
	confirmed: { label: "已确认", tone: "green" },
	rejected: { label: "已拒绝", tone: "red" },
	cancelled: { label: "已取消", tone: "red" },
	expired: { label: "已过期", tone: "gray" },
	unknown: { label: "待核实", tone: "red" },
} as const satisfies Record<string, Label>;

/** 只接受不带凭据、路径、查询和片段的 http(s) origin；返回 host（不带协议与尾斜杠）。 */
export function browserOriginHost(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	try {
		const url = new URL(value);
		if (
			(url.protocol !== "https:" && url.protocol !== "http:") ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		)
			return undefined;
		return url.host;
	} catch {
		return undefined;
	}
}

/** 去掉控制字符并限制长度；可信生产方已经脱敏，这里只做显示边界。 */
export function boundedBrowserText(value: unknown, limit = 160): string {
	if (typeof value !== "string") return "";
	return [...value]
		.filter((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code >= 0x20 && code !== 0x7f;
		})
		.join("")
		.trim()
		.slice(0, limit);
}
