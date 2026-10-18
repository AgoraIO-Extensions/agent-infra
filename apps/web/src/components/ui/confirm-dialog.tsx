import { useState } from "react";
import { Button, buttonVariants } from "./button.js";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "./dialog.js";

export function ConfirmDialog({
	confirmLabel = "确认",
	description,
	disabled,
	ariaLabel,
	label,
	onConfirm,
	title,
	triggerVariant,
	variant = "destructive",
}: {
	confirmLabel?: string;
	ariaLabel?: string;
	description: string;
	disabled?: boolean;
	label: string;
	onConfirm: () => void;
	title: string;
	triggerVariant?:
		| "default"
		| "outline"
		| "secondary"
		| "ghost"
		| "destructive"
		| "link";
	variant?: "destructive" | "default";
}) {
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger
				disabled={disabled}
				render={
					<Button
						type="button"
						variant={triggerVariant ?? variant}
						aria-label={ariaLabel}
					/>
				}
			>
				{label}
			</DialogTrigger>
			<DialogContent>
				<DialogTitle>{title}</DialogTitle>
				<DialogDescription>{description}</DialogDescription>
				<div className="mt-5 flex justify-end gap-2">
					<DialogClose className={buttonVariants({ variant: "ghost" })}>
						取消
					</DialogClose>
					<Button
						variant={variant}
						onClick={() => {
							setOpen(false);
							onConfirm();
						}}
					>
						{confirmLabel}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
