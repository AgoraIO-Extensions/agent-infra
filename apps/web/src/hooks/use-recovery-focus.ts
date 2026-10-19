import { useCallback, useEffect, useRef } from "react";

/**
 * 读取失败后点「重新登录」「重新读取 / 重新加载」：恢复成功时触发按钮随失败提示一起卸载，
 * 焦点会落到 body。用户触发恢复时调用 arm()；之后未就绪（读取中或失败）的分区数 unsettled
 * 比触发时少，且焦点确实已落到 body，就把焦点移到 ref 指向的页面标题（需 tabIndex=-1）。
 *
 * - 恢复失败时 unsettled 不变，保持待命，之后真正恢复时再移动焦点；
 * - 焦点仍在别处（另一条失败提示的按钮，或用户已主动移开）时不抢焦点。
 */
export function useRecoveryFocus<T extends HTMLElement = HTMLHeadingElement>(
	unsettled: number,
) {
	const ref = useRef<T>(null);
	const armedAt = useRef<number | null>(null);
	useEffect(() => {
		const armed = armedAt.current;
		if (armed === null || unsettled >= armed) return;
		armedAt.current = null;
		const active = document.activeElement;
		if (!active || active === document.body) ref.current?.focus();
	}, [unsettled]);
	const arm = useCallback(() => {
		armedAt.current = unsettled;
	}, [unsettled]);
	return { ref, arm };
}

/** 包装恢复操作：先 arm() 再执行；未提供操作时保持 undefined，不凭空多出按钮。 */
export function armBefore(
	arm: () => void,
	action: (() => void) | undefined,
): (() => void) | undefined {
	return action
		? () => {
				arm();
				action();
			}
		: undefined;
}
