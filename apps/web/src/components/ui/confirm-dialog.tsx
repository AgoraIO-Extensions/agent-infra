import type { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";

type ConfirmDialogProps = {
	title: React.ReactNode;
	// 写明后果。
	description: React.ReactNode;
	// 写明动作（如「撤销凭证」「停止 Agent」「确认撤回」），没有默认值。
	confirmLabel: string;
	onConfirm: () => void;
	// 作为 DialogTrigger 的 render，由调用方决定按钮变体与可访问名称。
	trigger: React.ReactElement;
	// 在说明上方显示操作对象。
	subject?: { name: React.ReactNode; detail?: React.ReactNode };
	tone?: "danger" | "default";
	cancelLabel?: string;
	// 同时禁用触发器与确认钮。
	disabled?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	finalFocus?: DialogPrimitive.Popup.Props["finalFocus"];
};

// 所有「标题 + 后果 + 取消 / 确认」型确认都用它；确认前不发请求，
// 进行中状态与结果反馈由调用方负责。
function ConfirmDialog({
	title,
	description,
	confirmLabel,
	onConfirm,
	trigger,
	subject,
	tone = "danger",
	cancelLabel = "取消",
	disabled = false,
	open: controlledOpen,
	onOpenChange,
	finalFocus,
}: ConfirmDialogProps) {
	const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
	const open = controlledOpen ?? uncontrolledOpen;
	// 一次打开只允许确认一次，连续点击不会重复调用 onConfirm。
	const confirmed = React.useRef(false);
	React.useEffect(() => {
		if (open) confirmed.current = false;
	}, [open]);
	const setOpen = (next: boolean) => {
		if (next) confirmed.current = false;
		if (controlledOpen === undefined) setUncontrolledOpen(next);
		onOpenChange?.(next);
	};
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger render={trigger} disabled={disabled} />
			<DialogContent finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
				</DialogHeader>
				<DialogBody className="space-y-2">
					{subject ? (
						// 对象名可能是目录记录等块级内容，这里用 div 而不是 p / strong。
						<div data-slot="confirm-dialog-subject" className="break-words">
							<div className="font-[650]">{subject.name}</div>
							{subject.detail ? (
								<div className="text-[13px] text-muted-foreground">
									{subject.detail}
								</div>
							) : null}
						</div>
					) : null}
					<DialogDescription>{description}</DialogDescription>
				</DialogBody>
				<DialogFooter>
					<DialogClose render={<Button variant="ghost" />}>
						{cancelLabel}
					</DialogClose>
					<Button
						type="button"
						variant={tone === "danger" ? "destructive" : "default"}
						disabled={disabled}
						onClick={() => {
							if (disabled || confirmed.current) return;
							confirmed.current = true;
							setOpen(false);
							onConfirm();
						}}
					>
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export type { ConfirmDialogProps };
export { ConfirmDialog };
