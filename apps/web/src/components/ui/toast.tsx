import type * as React from "react";
import { cn } from "@/lib/utils";

export function Toast({
	className,
	children,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			role="status"
			aria-live="polite"
			className={cn("ui-toast", className)}
			{...props}
		>
			{children}
		</div>
	);
}
