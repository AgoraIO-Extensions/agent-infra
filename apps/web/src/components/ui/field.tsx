import type * as React from "react";
import { labelVariants } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// 设计稿 .field{display:grid;gap:7px}：包住 Label 与控件。content-start 避免同一行
// 相邻字段较高（例如带说明文字）时把标签行拉高、控件下沉。
function Field({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="field"
			className={cn("grid min-w-0 content-start gap-[7px]", className)}
			{...props}
		/>
	);
}

// 设计稿 .field legend：fieldset 内的字段组标题，与字段标签同样式。
// fieldset 由 preflight 去掉边框与内边距，分区标题请用 FormSection。
function FieldLegend({ className, ...props }: React.ComponentProps<"legend">) {
	return (
		<legend
			data-slot="field-legend"
			className={cn(labelVariants({ variant: "field" }), className)}
			{...props}
		/>
	);
}

// 设计稿 p.field-error[role=alert]：字段下方 12px、--danger-ink 的校验错误，上距 6px。
// 只在提交校验失败后渲染；控件用 aria-invalid 与 aria-describedby 指向它的 id。
// 字段级错误的样式只在这里维护（#3268 N8-2-02），调用方只选择播报方式。
type FieldErrorProps = Omit<React.ComponentProps<"p">, "role" | "aria-live"> & {
	/**
	 * 播报方式：默认 role="alert"；焦点已移到出错字段时可用 polite / assertive 的 live region；
	 * 同一次校验已有一条总提示播报时用 none，字段错误只经 aria-describedby 读出。
	 */
	announce?: "alert" | "polite" | "assertive" | "none";
};

function FieldError({
	announce = "alert",
	className,
	...props
}: FieldErrorProps) {
	return (
		<p
			data-slot="field-error"
			role={announce === "alert" ? "alert" : undefined}
			aria-live={
				announce === "polite" || announce === "assertive" ? announce : undefined
			}
			className={cn(
				"mt-[6px] text-(--danger-ink) text-[12px] leading-[1.5]",
				className,
			)}
			{...props}
		/>
	);
}

export { Field, FieldError, FieldLegend };
