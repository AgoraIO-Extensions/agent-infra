import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva } from "class-variance-authority";
import { type ChipTone, statusTone } from "@/lib/status-tone";
import { cn } from "@/lib/utils";

// 设计 .chip（状态，全圆角带圆点）与 .tag（非状态标签，7px 圆角无圆点）。
// 放得下时不换行；超出容器宽度时换行，不截断。
const badgeVariants = cva(
	"group/badge inline-flex min-h-[24px] w-fit max-w-full shrink-0 items-center gap-[6px] border border-solid py-[3px] font-normal text-[11px] leading-[1.65] [overflow-wrap:anywhere] [&>svg]:pointer-events-none [&>svg]:size-3!",
	{
		variants: {
			variant: {
				chip: "rounded-[999px] px-[9px] before:size-[6px] before:shrink-0 before:rounded-full before:bg-current before:content-[''] has-[>svg]:before:hidden",
				tag: "rounded-[7px] border-border bg-transparent px-[8px] text-muted-foreground",
			},
			tone: {
				gray: "border-border bg-transparent text-muted-foreground",
				blue: "border-[color-mix(in_oklch,var(--accent)_28%,var(--border))] bg-(--accent-soft) text-(--accent-ink)",
				green:
					"border-[color-mix(in_oklch,var(--success)_25%,var(--border))] bg-[color-mix(in_oklch,var(--success)_8%,var(--surface))] text-(--success-ink)",
				amber:
					"border-[color-mix(in_oklch,var(--warning)_32%,var(--border))] bg-[color-mix(in_oklch,var(--warning)_10%,var(--surface))] text-(--warning-ink)",
				red: "border-[color-mix(in_oklch,var(--danger)_28%,var(--border))] bg-[color-mix(in_oklch,var(--danger)_8%,var(--surface))] text-(--danger-ink)",
			},
		},
		defaultVariants: {
			variant: "chip",
		},
	},
);

// 兼容层：旧变体名只供尚未迁移的对话页与两个浏览器面板使用，
// 对话页迁移（#2780–#2787）完成后删除。新代码只用 chip / tag 并显式传 tone。
type LegacyBadgeVariant = "default" | "secondary" | "destructive" | "outline";

type BadgeProps = useRender.ComponentProps<"span"> & {
	variant?: "chip" | "tag" | LegacyBadgeVariant;
	tone?: ChipTone;
};

function legacyTone(
	variant: BadgeProps["variant"],
	status: unknown,
): ChipTone | undefined {
	if (variant === "destructive") return "red";
	// 旧页面靠 data-status / data-result 属性选择器把 Badge 画成状态 chip。
	if (typeof status === "string") return statusTone(status);
	if (variant === "secondary") return undefined;
	if (variant === "default") return "blue";
	return "gray";
}

function Badge({
	className,
	variant = "chip",
	tone,
	render,
	...props
}: BadgeProps) {
	const attributes = props as Record<string, unknown>;
	const resolvedTone =
		variant === "tag"
			? undefined
			: (tone ??
				legacyTone(
					variant,
					attributes["data-status"] ?? attributes["data-result"],
				));
	const kind = resolvedTone === undefined ? "tag" : "chip";
	return useRender({
		defaultTagName: "span",
		props: mergeProps<"span">(
			{
				className: cn(
					badgeVariants({ variant: kind, tone: resolvedTone }),
					className,
				),
			},
			props,
		),
		render,
		state: {
			slot: "badge",
			variant: kind,
			tone: resolvedTone,
		},
	});
}

export type { BadgeProps };
export { Badge, badgeVariants };
