import type * as React from "react";
import { cn } from "@/lib/utils";

function Sidebar({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="sidebar"
			className={cn(
				"flex h-full flex-col bg-sidebar text-sidebar-foreground",
				className,
			)}
			{...props}
		/>
	);
}

export { Sidebar };
