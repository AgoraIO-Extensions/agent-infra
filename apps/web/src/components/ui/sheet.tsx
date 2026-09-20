import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { buttonVariants } from "./button";

export function NavigationSheet({
	open,
	onOpenChange,
	trigger,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	trigger: ReactNode;
	children: ReactNode;
}) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Trigger
				className={buttonVariants({
					variant: "ghost",
					size: "icon",
					className: "mobile-menu",
				})}
				aria-label="打开导航"
			>
				{trigger}
			</Dialog.Trigger>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-40 bg-black/30" />
				<Dialog.Popup className="platform-nav-sheet">
					<Dialog.Title className="sr-only">主导航</Dialog.Title>
					<Dialog.Description className="sr-only">
						选择页面，或关闭导航返回当前页面。
					</Dialog.Description>
					<Dialog.Close
						className={buttonVariants({
							variant: "ghost",
							size: "icon",
							className: "absolute top-3 right-3",
						})}
						aria-label="关闭导航"
					>
						<X aria-hidden="true" />
					</Dialog.Close>
					{children}
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
