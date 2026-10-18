"use client";

import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

// 设计稿 .field label 与 .check：字段标签与复选框选项是两种固定样式，
// 调用点不再用 className 改字号、字重或颜色。
const labelVariants = cva(
	"select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50 group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50",
	{
		variants: {
			variant: {
				field:
					"block font-[650] text-[12px] text-muted-foreground leading-[1.65]",
				option:
					"inline-flex min-h-11 items-center gap-2 font-normal text-[13px] text-foreground leading-[1.65]",
			},
		},
		defaultVariants: {
			variant: "field",
		},
	},
);

function Label({
	className,
	htmlFor,
	children,
	variant = "field",
	...props
}: React.ComponentProps<"label"> & VariantProps<typeof labelVariants>) {
	return (
		<label
			htmlFor={htmlFor}
			data-slot="label"
			data-variant={variant}
			className={cn(labelVariants({ variant }), className)}
			{...props}
		>
			{children}
		</label>
	);
}

export { Label, labelVariants };
