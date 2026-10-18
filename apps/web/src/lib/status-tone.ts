// 状态 chip 的色调；与设计 .chip-gray|blue|green|amber|red 一一对应。
export type ChipTone = "gray" | "blue" | "green" | "amber" | "red";

const statusTones: Readonly<Record<string, ChipTone>> = {
	ready: "green",
	available: "green",
	succeeded: "green",
	starting: "amber",
	updating: "amber",
	pending_approval: "amber",
	creating: "amber",
	unavailable: "red",
	creation_failed: "red",
	disabled: "red",
	rejected: "red",
	failed: "red",
};

// 服务端状态值到 chip 色调的共享映射；未列出的取值一律为 gray。
// 语义与这里不同的页面应直接给 Badge 传 tone。
export function statusTone(value: string | null | undefined): ChipTone {
	if (!value || !Object.hasOwn(statusTones, value)) return "gray";
	return statusTones[value] ?? "gray";
}
