import { useState } from "react";
import { Button, buttonVariants } from "../../components/ui/button.js";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "../../components/ui/dialog.js";

export function WecomUnbindDialog({
	disabled,
	label,
	title = "解除企微机器人绑定？",
	onConfirm,
}: {
	disabled?: boolean;
	label: string;
	title?: string;
	onConfirm: () => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger
				disabled={disabled}
				render={<Button type="button" variant="outline" />}
			>
				{label}
			</DialogTrigger>
			<DialogContent>
				<DialogTitle>{title}</DialogTitle>
				<DialogDescription>
					解除后不会删除已有会话和历史记录；新的群消息将停止进入此 Agent。
				</DialogDescription>
				<div className="mt-5 flex flex-wrap justify-end gap-2">
					<DialogClose className={buttonVariants({ variant: "ghost" })}>
						取消
					</DialogClose>
					<Button
						variant="destructive"
						onClick={() => {
							setOpen(false);
							onConfirm();
						}}
					>
						确认解除
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
