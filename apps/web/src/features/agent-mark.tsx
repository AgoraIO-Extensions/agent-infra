import { cn } from "@/lib/utils";

// 设计 .agent-mark / .agent-mark.blue / .agent-mark.soft。
export type AgentMarkTone = "fg" | "blue" | "soft";

const agentMarkTones: readonly AgentMarkTone[] = ["fg", "blue", "soft"];

const toneClasses = {
	fg: "bg-foreground text-(--surface)",
	blue: "bg-(--accent-ink) text-(--surface)",
	soft: "border border-[color-mix(in_oklch,var(--accent)_20%,var(--border))] bg-(--accent-soft) text-(--accent-ink)",
} satisfies Record<AgentMarkTone, string>;

// 同一 agentId 在工作台、目录、详情和我的 Agent 中得到相同 tone（稳定散列）。
export function agentMarkTone(agentId: string): AgentMarkTone {
	let hash = 0;
	for (const char of agentId)
		hash = (hash * 31 + (char.codePointAt(0) ?? 0)) | 0;
	return agentMarkTones[Math.abs(hash) % agentMarkTones.length] ?? "fg";
}

// 字形取 Agent 名的首个字符，拉丁字母转大写。
export function agentMarkGlyph(name: string) {
	const first = Array.from(name.trim())[0] ?? "";
	return first.toLocaleUpperCase("en-US");
}

export function AgentMark({
	name,
	agentId,
	tone,
	className,
}: {
	name: string;
	agentId: string;
	tone?: AgentMarkTone;
	className?: string;
}) {
	const resolvedTone = tone ?? agentMarkTone(agentId);
	return (
		<span
			aria-hidden="true"
			data-slot="agent-mark"
			data-tone={resolvedTone}
			className={cn(
				"grid size-[42px] flex-none place-items-center rounded-[12px] font-normal text-[19px] leading-[1.65] [font-family:var(--font-display)]",
				toneClasses[resolvedTone],
				className,
			)}
		>
			{agentMarkGlyph(name)}
		</span>
	);
}
