import { type RefObject, useCallback, useEffect, useRef } from "react";

/**
 * 「加载更多」类按钮的焦点（#3242 K7-02）：读取中按钮是可聚焦的禁用（focusableWhenDisabled），
 * 焦点留在按钮上；读完后还有下一页、按钮仍在时焦点留在原处；没有更多、按钮随之卸载时，焦点移到
 * 新加载的第一项（读取前列表里有 n 项，就是第 n + 1 项），不落到 body。
 *
 * 用户触发时调用 arm()；items 返回列表里可聚焦的条目（例如每行的链接）。用户已把焦点移到别处时
 * 不移动。
 */
export function useLoadMoreFocus(
	loading: boolean,
	items: () => readonly HTMLElement[],
) {
	const before = useRef<number | null>(null);
	const latestItems = useRef(items);
	useEffect(() => {
		latestItems.current = items;
	});
	useEffect(() => {
		if (loading || before.current === null) return;
		const count = before.current;
		before.current = null;
		const active = document.activeElement;
		if (active && active !== document.body) return;
		const next = latestItems.current();
		(next[count] ?? next.at(-1))?.focus();
	}, [loading]);
	const arm = useCallback(() => {
		before.current = latestItems.current().length;
	}, []);
	return arm;
}

/** 列表容器内每项的链接（最近对话、个人历史）。 */
export function listLinks(list: RefObject<HTMLElement | null>) {
	return () => [
		...(list.current?.querySelectorAll<HTMLElement>(":scope > li a[href]") ??
			[]),
	];
}
