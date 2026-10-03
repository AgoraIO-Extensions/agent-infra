"use client";

import type * as React from "react";
import { cn } from "@/lib/utils";

function Label({
	className,
	htmlFor,
	children,
	...props
}: React.ComponentProps<"label">) {
	return (
		<label
			htmlFor={htmlFor}
			data-slot="label"
			className={cn(
				"flex select-none flex-wrap items-center gap-2 font-medium text-sm leading-5 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50",
				className,
			)}
			{...props}
		>
			{children}
		</label>
	);
}

export { Label };
