import type * as React from "react";
import { cn } from "@/lib/utils";

// 设计 .spinner（15px，顶边 accent-ink）与对话设置里的小号 .preference-spinner（12px，顶边 fg）。
// reduced-motion 下有意停掉动画（animation-name: none），而不只是压缩时长。
const spinnerSizes = {
	md: "size-[15px] border-2 border-t-(--accent-ink)",
	sm: "size-[12px] border-[1.5px] border-t-foreground",
} as const;

function Spinner({
	className,
	size = "md",
	...props
}: Omit<React.ComponentProps<"span">, "children"> & {
	size?: keyof typeof spinnerSizes;
}) {
	return (
		<span
			data-slot="spinner"
			data-size={size}
			aria-hidden="true"
			className={cn(
				"inline-block shrink-0 animate-spin rounded-full border-border border-solid [animation-duration:0.8s] motion-reduce:[animation-name:none]",
				spinnerSizes[size],
				className,
			)}
			{...props}
		/>
	);
}

// 设计 .loading-line：spinner 加文案。父级已经是 live region 时传 announce={false}。
function LoadingLine({
	className,
	children,
	announce = true,
	...props
}: React.ComponentProps<"div"> & { announce?: boolean }) {
	return (
		<div
			data-slot="loading-line"
			role={announce ? "status" : undefined}
			aria-live={announce ? "polite" : undefined}
			className={cn(
				"flex items-center gap-[9px] text-[13px] text-muted-foreground",
				className,
			)}
			{...props}
		>
			<Spinner />
			{children}
		</div>
	);
}

export { LoadingLine, Spinner };
