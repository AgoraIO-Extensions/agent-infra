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

type ConfirmDialogContent =
	| {
			// 写明后果。渲染为 <p>（DialogDescription），只放文字与行内元素。
			description: React.ReactNode;
			children?: undefined;
	  }
	| {
			description?: undefined;
			// 块级说明（如事实列表 <dl>）：渲染为 <div>，同样作为弹窗的可访问描述。
			children: React.ReactNode;
	  };

type ConfirmDialogProps = ConfirmDialogContent & {
	title: React.ReactNode;
	// 写明动作（如「撤销凭证」「停止 Agent」「确认撤回」），没有默认值。
	confirmLabel: string;
	onConfirm: () => void;
	// 作为 DialogTrigger 的 render，由调用方决定按钮变体与可访问名称。
	trigger: React.ReactElement;
	// 在说明上方显示操作对象。
	subject?: { name: React.ReactNode; detail?: React.ReactNode };
	tone?: "danger" | "default";
	// 传 null 时不渲染「取消」次按钮，只保留页眉的关闭钮（例如设计稿的撤回申请弹窗）。
	cancelLabel?: string | null;
	// 同时禁用触发器与确认钮。
	disabled?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	finalFocus?: DialogPrimitive.Popup.Props["finalFocus"];
	// 传 "skill" 时使用设计 .skill-dialog 外观（Skill 的撤销、绑定与解除绑定确认）。
	variant?: React.ComponentProps<typeof DialogContent>["variant"];
};

// 所有「标题 + 后果 + 取消 / 确认」型确认都用它；确认前不发请求，
// 进行中状态与结果反馈由调用方负责。
function ConfirmDialog({
	title,
	description,
	children,
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
	variant,
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
			<DialogContent finalFocus={finalFocus} variant={variant}>
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
					{description === undefined ? (
						// <p> 不能包含 dl 等块级元素（#3075），块级说明改用 div 承载。
						<DialogDescription render={<div />}>{children}</DialogDescription>
					) : (
						<DialogDescription>{description}</DialogDescription>
					)}
				</DialogBody>
				<DialogFooter>
					{cancelLabel === null ? null : (
						<DialogClose render={<Button variant="ghost" />}>
							{cancelLabel}
						</DialogClose>
					)}
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
