import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@/lib/utils";

// 设计 .card：只用于独立卡片（可用 Agent、目录卡、已创建 Agent），不用于面板内的列表行。
// 默认渲染 article，可通过 render 改为 li 或 div。
function Card({
	className,
	render,
	...props
}: useRender.ComponentProps<"article">) {
	return useRender({
		defaultTagName: "article",
		props: mergeProps<"article">(
			{
				className: cn(
					"min-w-0 rounded-[14px] border border-border bg-card p-[18px] transition-[border-color,transform,box-shadow] duration-[180ms] ease-[ease] hover:border-[color-mix(in_oklch,var(--accent)_30%,var(--border))] hover:[box-shadow:0_8px_24px_color-mix(in_oklch,var(--foreground)_6%,transparent)]",
					className,
				),
			},
			props,
		),
		render,
		state: { slot: "card" },
	});
}

export { Card };
