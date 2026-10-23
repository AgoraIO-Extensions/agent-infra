import { useCallback, useEffect, useState } from "react";

/**
 * 移除可重复的行后交出焦点（D2-59、#3268 N8-2-01）：被移除的行连同它的「移除」按钮一起卸载，
 * 焦点不能落到 body。移除后先到同一位置的下一行（移除后占据该位置的行）的对应控件，没有下一行时
 * 到上一行，都没有（或该行没有对应控件）时到 fallback（通常是「添加…」按钮）。
 *
 * 返回的函数在移除时调用：removedIndex 是被移除行的序号，rowTarget 由行序号给出对应控件的 id。
 * 目标在下一次渲染提交后才查找，此时被移除的行已经卸载、后面的行已按新序号渲染。
 */
export function useRowRemovalFocus() {
	const [targets, setTargets] = useState<readonly string[] | null>(null);
	useEffect(() => {
		if (!targets) return;
		setTargets(null);
		for (const id of targets) {
			const element = document.getElementById(id);
			if (element && !element.matches(":disabled")) {
				element.focus();
				return;
			}
		}
	}, [targets]);
	return useCallback(
		(
			removedIndex: number,
			rowTarget: (index: number) => string,
			fallback: string,
		) => {
			setTargets([
				rowTarget(removedIndex),
				...(removedIndex > 0 ? [rowTarget(removedIndex - 1)] : []),
				fallback,
			]);
		},
		[],
	);
}
