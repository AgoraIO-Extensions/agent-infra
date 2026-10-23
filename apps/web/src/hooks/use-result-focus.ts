import { useEffect, useRef } from "react";

// A successful command can remove its trigger or the whole form.
export function useResultFocus(result: unknown) {
	const ref = useRef<HTMLParagraphElement>(null);
	useEffect(() => {
		if (result) ref.current?.focus();
	}, [result]);
	return ref;
}

/**
 * 动作结果或失败提示出现在视口外时（#3269 N8-3-09）：例如页底「签发个人凭证」的一次性凭证与失败
 * 提示渲染在页顶。把整条提示滚入可见区域（提示带 `.action-reveal`，scroll-margin 让出吸顶顶栏），
 * 再把焦点交给 focusTarget（默认提示本身，需 tabIndex=-1），不让焦点留在页面另一端的触发按钮上。
 */
export function revealAndFocus(
	element: HTMLElement | null,
	focusTarget: HTMLElement | null = element,
) {
	if (!element) return;
	element.scrollIntoView?.({ block: "nearest" });
	focusTarget?.focus({ preventScroll: true });
}
