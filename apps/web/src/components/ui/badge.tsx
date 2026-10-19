import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva } from "class-variance-authority";
import type { ChipTone } from "@/lib/status-tone";
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

// 只有 chip（状态）与 tag（非状态标签）两种变体；状态色调由调用方显式传 tone，
// 组件不再从 data-status / data-result 推导，也不接受旧变体名。
type BadgeProps = useRender.ComponentProps<"span"> & {
	variant?: "chip" | "tag";
	tone?: ChipTone;
};

function Badge({
	className,
	variant = "chip",
	tone,
	render,
	...props
}: BadgeProps) {
	const resolvedTone = variant === "tag" ? undefined : (tone ?? "gray");
	return useRender({
		defaultTagName: "span",
		props: mergeProps<"span">(
			{
				className: cn(
					badgeVariants({ variant, tone: resolvedTone }),
					className,
				),
			},
			props,
		),
		render,
		state: {
			slot: "badge",
			variant,
			tone: resolvedTone,
		},
	});
}

export type { BadgeProps };
export { Badge, badgeVariants };
