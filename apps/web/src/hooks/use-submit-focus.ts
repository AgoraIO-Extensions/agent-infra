import { type RefObject, useLayoutEffect } from "react";

/**
 * 提交进行中的焦点（#3242 K7-02）：提交期间表单字段随之禁用（`<fieldset disabled>` 或逐个
 * disabled），在输入框里按 Enter 隐式提交时焦点还在字段上，字段被禁用后浏览器会把焦点移到
 * body。提交开始时把焦点交给提交按钮——它在请求进行中是可聚焦的禁用（`focusableWhenDisabled`），
 * 完成后再由页面按 D2-59 交出焦点。
 *
 * 只在提交开始的那次提交里检查一次：焦点已经在提交按钮上（点击或在按钮上按 Enter），或在
 * 禁用范围之外（例如弹窗里）时不移动。
 */
export function useSubmitFocus(
	submitting: boolean,
	scope: RefObject<HTMLElement | null>,
	submit: RefObject<HTMLElement | null>,
) {
	useLayoutEffect(() => {
		if (!submitting) return;
		const button = submit.current;
		const active = document.activeElement;
		if (!button || active === button) return;
		if (!active || active === document.body || scope.current?.contains(active))
			button.focus();
	}, [submitting, scope, submit]);
}
