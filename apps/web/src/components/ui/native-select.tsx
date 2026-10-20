import type * as React from "react";
import { cn } from "@/lib/utils";

type NativeSelectProps = Omit<React.ComponentProps<"select">, "size">;

// 设计稿 .select：与 Input 同高同内边距，右侧 40px 留给箭头。
// 箭头与设计相同，是背景上 45° / 135° 两段渐变拼成的 5px 实心小三角
// （位于右侧 13–18px、上距 18px，muted 文字色），不再叠加图标元素。
function NativeSelect({ className, ...props }: NativeSelectProps) {
	return (
		<div
			className={cn(
				"w-full min-w-0 has-[select:disabled]:opacity-50",
				className,
			)}
			data-slot="native-select-wrapper"
		>
			<select
				data-slot="native-select"
				className="h-11 w-full min-w-0 select-none appearance-none rounded-[10px] border border-input bg-[var(--surface)] bg-no-repeat py-[9px] pr-10 pl-3 text-[15px] text-foreground leading-6 outline-none [background-image:linear-gradient(45deg,transparent_50%,var(--muted-foreground)_50%),linear-gradient(135deg,var(--muted-foreground)_50%,transparent_50%)] [background-position:calc(100%_-_18px)_18px,calc(100%_-_13px)_18px] [background-size:5px_5px,5px_5px] selection:bg-primary selection:text-primary-foreground placeholder:text-muted-ink focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 dark:hover:bg-input/50"
				{...props}
			/>
		</div>
	);
}

function NativeSelectOption({
	className,
	...props
}: React.ComponentProps<"option">) {
	return (
		<option
			data-slot="native-select-option"
			className={cn("bg-[Canvas] text-[CanvasText]", className)}
			{...props}
		/>
	);
}

function NativeSelectOptGroup({
	className,
	...props
}: React.ComponentProps<"optgroup">) {
	return (
		<optgroup
			data-slot="native-select-optgroup"
			className={cn("bg-[Canvas] text-[CanvasText]", className)}
			{...props}
		/>
	);
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };
