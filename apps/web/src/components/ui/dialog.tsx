import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { pageRecoveryTarget } from "@/hooks/use-recovery-focus";
import { cn } from "@/lib/utils";

/**
 * 关闭后的焦点看护（#3037 AC-2）：Base UI 关闭弹窗时把焦点还给触发按钮。触发按钮当时被禁用
 * 或已卸载，或之后随列表回读卸载（例如审阅、解除绑定后该行离开列表）时，焦点会落到 body，
 * 读屏与 Tab 都从页首重来。看护期间焦点一旦落到 body，就移到页面标题（pageRecoveryTarget：
 * 主内容区 h1[tabindex]，否则 #main-content）。焦点被移到别处、用户按下指针、地址（含查询与
 * hash）变化、再次打开弹窗或 10 秒后停止看护；调用方传了 finalFocus 时不看护。
 */
let closeFocusGuard: {
	/** 开始看护时的完整地址：路由或查询参数变化后由页面自己的焦点管理接手。 */
	address: string;
	observer: MutationObserver | null;
	timer: ReturnType<typeof setTimeout>;
	/** 关闭后第一次获得焦点的元素，通常是触发按钮。 */
	restored: Element | null;
	/** 看护移过去的页面标题，不算作用户移动焦点。 */
	settled: HTMLElement | null;
} | null = null;

function stopCloseFocusGuard() {
	const current = closeFocusGuard;
	if (!current) return;
	closeFocusGuard = null;
	current.observer?.disconnect();
	clearTimeout(current.timer);
	document.removeEventListener("focusin", onCloseFocusIn, true);
	document.removeEventListener("pointerdown", stopCloseFocusGuard, true);
}

function onCloseFocusIn(event: FocusEvent) {
	const current = closeFocusGuard;
	const target = event.target;
	if (!current || !(target instanceof Element)) return;
	if (target === document.body || target === current.settled) return;
	if (!current.restored) current.restored = target;
	else if (target !== current.restored) stopCloseFocusGuard();
}

function settleCloseFocus() {
	const current = closeFocusGuard;
	if (!current) return;
	if (current.address !== currentAddress()) {
		stopCloseFocusGuard();
		return;
	}
	const active = document.activeElement;
	if (active && active !== document.body) return;
	const target = pageRecoveryTarget();
	if (!target) return;
	current.settled = target;
	// #main-content 只是兜底，不为它把页面滚回顶部。
	target.focus({ preventScroll: target.id === "main-content" });
}

function currentAddress() {
	return `${location.pathname}${location.search}${location.hash}`;
}

function startCloseFocusGuard() {
	stopCloseFocusGuard();
	const observer =
		typeof MutationObserver === "undefined"
			? null
			: new MutationObserver(settleCloseFocus);
	closeFocusGuard = {
		address: currentAddress(),
		observer,
		timer: setTimeout(stopCloseFocusGuard, 10_000),
		restored: null,
		settled: null,
	};
	// 弹窗卸载、触发按钮卸载或被禁用都会改动 DOM；每次改动后检查焦点是否落到 body。
	observer?.observe(document.body, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["disabled"],
	});
	document.addEventListener("focusin", onCloseFocusIn, true);
	document.addEventListener("pointerdown", stopCloseFocusGuard, true);
	setTimeout(settleCloseFocus, 0);
}

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

// DialogHeader、DialogTitle、DialogFooter 随 DialogContent 的 variant 与 showCloseButton 变化。
type DialogVariant = "modal" | "skill";
const DialogLayoutContext = React.createContext<{
	showCloseButton: boolean;
	variant: DialogVariant;
}>({ showCloseButton: true, variant: "modal" });

type DialogContentProps = Omit<DialogPrimitive.Popup.Props, "className"> & {
	// 只用于内容排版，不得覆盖宽高、padding、圆角、边框、阴影或字号。
	className?: string;
	showCloseButton?: boolean;
	// modal：设计 .modal（默认）；skill：设计 .skill-dialog，只用于 Skill 的确认与审阅弹窗。
	variant?: DialogVariant;
};

const dialogSurface = {
	// 设计 .modal：宽 min(100%, 620px)（遮罩左右各留 20px）、圆角 16px、深阴影，
	// 内边距 24px，窄屏 19px。
	modal:
		"max-h-[min(88dvh,760px)] w-[calc(100%-40px)] max-w-[620px] rounded-[16px] p-[19px] [box-shadow:0_24px_80px_color-mix(in_oklch,var(--foreground)_25%,transparent)] md:p-6",
	// 设计 .skill-dialog：原生 dialog，宽 min(620px, 100vw − 32px) 且受浏览器 modal 默认的
	// max-width（100% − 6px − 2em）约束，实际左右各留 18px；高 86dvh、圆角 14px、
	// var(--shadow)，内边距 24px，窄屏 18px。
	skill:
		"max-h-[86dvh] w-[calc(100%-36px)] max-w-[620px] rounded-[14px] p-[18px] [box-shadow:var(--shadow)] md:p-6",
} satisfies Record<DialogVariant, string>;

function DialogContent({
	className,
	children,
	showCloseButton = true,
	variant = "modal",
	initialFocus,
	finalFocus,
	ref,
	...props
}: DialogContentProps) {
	const popupRef = React.useRef<HTMLDivElement | null>(null);
	const explicitFinalFocus = React.useRef(finalFocus !== undefined);
	React.useEffect(() => {
		explicitFinalFocus.current = finalFocus !== undefined;
	});
	const setPopupRef = React.useCallback(
		(node: HTMLDivElement | null) => {
			popupRef.current = node;
			// 打开时停止上一次关闭的看护；弹窗卸载（关闭）时开始看护，焦点归还仍按 Base UI 默认规则。
			if (node) stopCloseFocusGuard();
			else if (!explicitFinalFocus.current) startCloseFocusGuard();
			if (typeof ref === "function") ref(node);
			else if (ref) ref.current = node;
		},
		[ref],
	);
	const layout = React.useMemo(
		() => ({ showCloseButton, variant }),
		[showCloseButton, variant],
	);
	return (
		<DialogPortal>
			<DialogOverlay />
			<DialogPrimitive.Popup
				data-slot="dialog-content"
				data-variant={variant}
				aria-modal="true"
				ref={setPopupRef}
				// 打开时默认聚焦弹窗容器本身，调用方可覆盖（例如驳回表单聚焦 Textarea）。
				initialFocus={initialFocus ?? popupRef}
				finalFocus={finalFocus}
				className={cn(
					"fixed top-1/2 left-1/2 z-[80] -translate-x-1/2 -translate-y-1/2 overflow-auto border border-border bg-card text-[15px] text-foreground leading-[1.65] outline-none",
					dialogSurface[variant],
					className,
				)}
				{...props}
			>
				<DialogLayoutContext.Provider value={layout}>
					{children}
				</DialogLayoutContext.Provider>
			</DialogPrimitive.Popup>
		</DialogPortal>
	);
}

// 标题行：标题在左，唯一的关闭钮在右。modal 为 44×44 ghost 图标按钮，可访问名称
// 「关闭弹窗」，与页脚的「关闭」「取消」等文字按钮区分（同页不出现同名控件，X-04）；
// skill 与设计 .skill-dialog 相同，是 ghost 文字按钮「关闭」。
function DialogHeader({
	className,
	children,
	...props
}: React.ComponentProps<"div">) {
	const { showCloseButton, variant } = React.useContext(DialogLayoutContext);
	return (
		<div
			data-slot="dialog-header"
			className={cn("flex items-start justify-between gap-4", className)}
			{...props}
		>
			<div className="min-w-0 flex-1">{children}</div>
			{showCloseButton && variant === "skill" ? (
				<DialogPrimitive.Close
					data-slot="dialog-close"
					render={<Button variant="ghost" className="shrink-0" />}
				>
					关闭
				</DialogPrimitive.Close>
			) : showCloseButton ? (
				<DialogPrimitive.Close
					data-slot="dialog-close"
					aria-label="关闭弹窗"
					render={<Button variant="ghost" size="icon" className="shrink-0" />}
				>
					<XIcon aria-hidden="true" className="size-[18px]" />
				</DialogPrimitive.Close>
			) : null}
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

// 设计 .modal-actions：右对齐、可换行、gap 8px、上距 24px（.skill-dialog 为 20px）；窄屏不改为纵向。
function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
	const { variant } = React.useContext(DialogLayoutContext);
	return (
		<div
			data-slot="dialog-footer"
			className={cn(
				"flex flex-wrap justify-end gap-2",
				variant === "skill" ? "mt-5" : "mt-6",
				className,
			)}
			{...props}
		/>
	);
}

// 设计 .modal-head h2：19px / 620；.skill-dialog h2：20px / 600 / 1.4。均为正文字体、不收紧字距。
function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
	const { variant } = React.useContext(DialogLayoutContext);
	return (
		<DialogPrimitive.Title
			data-slot="dialog-title"
			className={cn(
				"tracking-normal [font-family:inherit]",
				variant === "skill"
					? "font-semibold text-[20px] leading-[1.4]"
					: "font-[620] text-[19px] leading-[1.35]",
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
