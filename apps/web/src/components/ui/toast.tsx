import type * as React from "react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export function Toast({
	className,
	children,
	...props
}: React.ComponentProps<"div">) {
	const [visible, setVisible] = useState(true);
	const toastKey = typeof children === "string" ? children : null;
	useEffect(() => {
		setVisible(true);
		const timer = window.setTimeout(() => setVisible(false), 2600);
		return () => window.clearTimeout(timer);
	}, [toastKey]);
	if (!visible) return null;
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
