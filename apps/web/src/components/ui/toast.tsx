import * as React from "react";
import { cn } from "@/lib/utils";

// 设计 #toast：页面上只有一个常驻的 polite live region，显示 2.6s 后淡出。
// Toast 只做补充确认，不能是失败的唯一反馈；它也从不接收焦点。
const TOAST_VISIBLE_MS = 2600;
const TOAST_EXIT_MS = 180;
// 连续两次相同文案时先清空再写入，让读屏重新播报。
const TOAST_REANNOUNCE_MS = 50;

type ToastFn = (message: string) => void;

const ToastContext = React.createContext<ToastFn | null>(null);

function ToastProvider({ children }: { children?: React.ReactNode }) {
	const [message, setMessage] = React.useState("");
	const [open, setOpen] = React.useState(false);
	const current = React.useRef("");
	const timers = React.useRef<number[]>([]);

	const clearTimers = React.useCallback(() => {
		for (const timer of timers.current) window.clearTimeout(timer);
		timers.current = [];
	}, []);

	const show = React.useCallback((next: string) => {
		current.current = next;
		setMessage(next);
		setOpen(true);
		timers.current.push(
			window.setTimeout(() => {
				setOpen(false);
				timers.current.push(
					window.setTimeout(() => {
						current.current = "";
						setMessage("");
					}, TOAST_EXIT_MS),
				);
			}, TOAST_VISIBLE_MS),
		);
	}, []);

	const toast = React.useCallback<ToastFn>(
		(next) => {
			// 空文案不显示，避免出现一个空的提示框。
			if (!next) return;
			clearTimers();
			if (next === current.current) {
				current.current = "";
				setMessage("");
				timers.current.push(
					window.setTimeout(() => show(next), TOAST_REANNOUNCE_MS),
				);
				return;
			}
			show(next);
		},
		[clearTimers, show],
	);

	React.useEffect(() => clearTimers, [clearTimers]);

	return (
		<ToastContext.Provider value={toast}>
			{children}
			<div
				data-slot="toast"
				data-state={open ? "open" : "closed"}
				role="status"
				aria-live="polite"
				aria-atomic="true"
				className={cn(
					"pointer-events-none fixed right-6 bottom-6 z-[100] max-w-[min(360px,calc(100vw-32px))] rounded-[11px] border border-[color-mix(in_oklch,var(--accent)_24%,var(--border))] bg-card px-[15px] py-3 text-[13px] text-foreground leading-[1.65] transition-[opacity,transform] duration-[180ms] ease-[ease] [box-shadow:var(--shadow)]",
					"data-[state=closed]:opacity-0 data-[state=open]:opacity-100 data-[state=closed]:[transform:translateY(10px)] data-[state=open]:[transform:translateY(0)]",
				)}
			>
				{message}
			</div>
		</ToastContext.Provider>
	);
}

// 页面调用：const toast = useToast(); toast("已重新发送，正在等待 Agent 确认")
function useToast(): ToastFn {
	const toast = React.useContext(ToastContext);
	if (!toast) throw new Error("useToast 需要在 ToastProvider 内使用");
	return toast;
}

export { ToastProvider, useToast };
