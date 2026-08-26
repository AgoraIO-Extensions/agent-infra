import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentProps } from "react";

import { cn } from "../../lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;

export function DialogContent({
	className,
	...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
	return (
		<DialogPrimitive.Portal>
			<DialogPrimitive.Overlay className="dialog-backdrop" />
			<DialogPrimitive.Content className={cn("dialog", className)} {...props} />
		</DialogPrimitive.Portal>
	);
}

export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
	return <div className={cn("dialog-header", className)} {...props} />;
}
