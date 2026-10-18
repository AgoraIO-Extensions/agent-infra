import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// 设计 .modal-backdrop / .modal / .modal-head / .modal-body / .modal-actions。
// Dialog 固定为 modal；不对外暴露 modal={false}。
function Dialog({ ...props }: Omit<DialogPrimitive.Root.Props, "modal">) {
	return <DialogPrimitive.Root data-slot="dialog" modal {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
	return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
	return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
	return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

// 遮罩：前景色 36%，无模糊、无入场动画。
function DialogOverlay({
	className,
	...props
}: DialogPrimitive.Backdrop.Props) {
	return (
		<DialogPrimitive.Backdrop
			data-slot="dialog-overlay"
			className={cn(
				"fixed inset-0 z-[80] bg-[color-mix(in_oklch,var(--foreground)_36%,transparent)]",
				className,
			)}
			{...props}
		/>
	);
}

// DialogHeader 中的关闭钮受 DialogContent 的 showCloseButton 控制。
const DialogCloseButtonContext = React.createContext(true);

type DialogContentProps = Omit<DialogPrimitive.Popup.Props, "className"> & {
	// 只用于内容排版，不得覆盖宽高、padding、圆角、边框、阴影或字号。
	className?: string;
	showCloseButton?: boolean;
};

function DialogContent({
	className,
	children,
	showCloseButton = true,
	initialFocus,
	ref,
	...props
}: DialogContentProps) {
	const popupRef = React.useRef<HTMLDivElement | null>(null);
	const setPopupRef = React.useCallback(
		(node: HTMLDivElement | null) => {
			popupRef.current = node;
			if (typeof ref === "function") ref(node);
			else if (ref) ref.current = node;
		},
		[ref],
	);
	return (
		<DialogPortal>
			<DialogOverlay />
			<DialogPrimitive.Popup
				data-slot="dialog-content"
				aria-modal="true"
				ref={setPopupRef}
				// 打开时默认聚焦弹窗容器本身，调用方可覆盖（例如驳回表单聚焦 Textarea）。
				initialFocus={initialFocus ?? popupRef}
				className={cn(
					"fixed top-1/2 left-1/2 z-[80] max-h-[min(88dvh,760px)] w-[calc(100%-40px)] max-w-[620px] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-[16px] border border-border bg-card p-[19px] text-[15px] text-foreground leading-[1.65] outline-none [box-shadow:0_24px_80px_color-mix(in_oklch,var(--foreground)_25%,transparent)] md:p-6",
					className,
				)}
				{...props}
			>
				<DialogCloseButtonContext.Provider value={showCloseButton}>
					{children}
				</DialogCloseButtonContext.Provider>
			</DialogPrimitive.Popup>
		</DialogPortal>
	);
}

// 标题行：标题在左，唯一的关闭钮在右（44×44 ghost 图标按钮）。
function DialogHeader({
	className,
	children,
	...props
}: React.ComponentProps<"div">) {
	const showCloseButton = React.useContext(DialogCloseButtonContext);
	return (
		<div
			data-slot="dialog-header"
			className={cn("flex items-start justify-between gap-4", className)}
			{...props}
		>
			<div className="min-w-0 flex-1">{children}</div>
			{showCloseButton && (
				<DialogPrimitive.Close
					data-slot="dialog-close"
					aria-label="关闭"
					render={<Button variant="ghost" size="icon" className="shrink-0" />}
				>
					<XIcon aria-hidden="true" className="size-[18px]" />
				</DialogPrimitive.Close>
			)}
		</div>
	);
}

// 承载说明、对象摘要、表单与 dl；内部滚动由 DialogContent 提供。
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="dialog-body"
			className={cn("mt-[18px]", className)}
			{...props}
		/>
	);
}

// 设计 .modal-actions：右对齐、可换行、gap 8px、上距 24px；窄屏不改为纵向。
function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="dialog-footer"
			className={cn("mt-6 flex flex-wrap justify-end gap-2", className)}
			{...props}
		/>
	);
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
	return (
		<DialogPrimitive.Title
			data-slot="dialog-title"
			className={cn(
				"font-[620] text-[19px] leading-[1.35] tracking-normal [font-family:inherit]",
				className,
			)}
			{...props}
		/>
	);
}

function DialogDescription({
	className,
	...props
}: DialogPrimitive.Description.Props) {
	return (
		<DialogPrimitive.Description
			data-slot="dialog-description"
			className={cn(
				"text-[15px] text-foreground leading-[1.65] *:[a]:underline *:[a]:underline-offset-3",
				className,
			)}
			{...props}
		/>
	);
}

export {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogOverlay,
	DialogPortal,
	DialogTitle,
	DialogTrigger,
};
