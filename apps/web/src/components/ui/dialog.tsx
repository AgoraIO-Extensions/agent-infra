import { Dialog as Primitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "./button";

export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogClose = Primitive.Close;

export function DialogContent({
	children,
	className,
	showCloseButton = true,
	...props
}: ComponentProps<typeof Primitive.Popup> & { showCloseButton?: boolean }) {
	return (
		<Primitive.Portal>
			<Primitive.Backdrop className="fixed inset-0 z-40 bg-black/30" />
			<Primitive.Popup
				className={cn(
					"fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-40px)] w-[calc(100%-32px)] max-w-[620px] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-md border border-border bg-background p-6 text-foreground outline-none sm:p-7",
					className,
				)}
				{...props}
			>
				{children}
				{showCloseButton && (
					<Primitive.Close
						className={buttonVariants({
							variant: "ghost",
							size: "icon",
							className: "absolute top-3 right-3",
						})}
						aria-label="关闭窗口"
					>
						<X aria-hidden="true" />
					</Primitive.Close>
				)}
			</Primitive.Popup>
		</Primitive.Portal>
	);
}

export function DialogTitle({
	className,
	...props
}: ComponentProps<typeof Primitive.Title>) {
	return (
		<Primitive.Title
			className={cn("pr-10 font-semibold text-xl", className)}
			{...props}
		/>
	);
}

export function DialogDescription({
	className,
	...props
}: ComponentProps<typeof Primitive.Description>) {
	return (
		<Primitive.Description
			className={cn("mt-2 text-muted-foreground text-sm", className)}
			{...props}
		/>
	);
}
