import type * as React from "react";
import { cn } from "@/lib/utils";

function Listbox({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="listbox"
			role="listbox"
			className={cn(className)}
			{...props}
		/>
	);
}

export { Listbox };
