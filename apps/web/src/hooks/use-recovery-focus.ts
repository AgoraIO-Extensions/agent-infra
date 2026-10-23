import { useCallback, useEffect, useRef } from "react";

/**
 * 恢复成功后的焦点目标：主内容区第一个可程序聚焦的 h1（页面标题，tabIndex=-1）；页面标题
 * 不可聚焦时落到 #main-content（壳层跳转目标，同样是 tabIndex=-1），不让焦点留在 body。
 */
export function pageRecoveryTarget(): HTMLElement | null {
	const main = document.getElementById("main-content");
	return (main ?? document).querySelector<HTMLElement>("h1[tabindex]") ?? main;
}

/**
 * 进行中的恢复：触发按钮卸载、焦点已落到 body 时建立，直到同一个恢复操作重新出现（读取仍
 * 失败）或用户把焦点移到别处。期间焦点停在「中性位置」（body、#main-content 或这里移过去的
 * 页面标题），页面后续渲染出可聚焦的 h1 时移过去。
 *
 * 读取失败后重读（TanStack Query 没有数据时重读会回到 pending）常常先显示读取中、整页换掉，
 * 触发按钮因此在请求中途卸载；只看卸载那一刻无法区分恢复成功与仍在读取，所以要跟到结果出来。
 */
let pending: {
	key: string;
	/** 建立时的页面地址：页面换了（路由跳转）就不再代管。 */
	path: string;
	focused: HTMLElement | null;
	observer: MutationObserver | null;
	/** 调用方指定的恢复目标（例如所在分区标题）；没有或取不到时用页面标题。 */
	target?: () => HTMLElement | null;
} | null = null;

function isNeutral(element: Element | null) {
	return (
		!element ||
		element === document.body ||
		element.id === "main-content" ||
		element === pending?.focused
	);
}

function clearPending() {
	pending?.observer?.disconnect();
	pending = null;
	document.removeEventListener("focusin", onFocusIn, true);
}

// 用户（或页面自己的焦点管理）把焦点移到中性位置以外：不再代管焦点。
function onFocusIn(event: FocusEvent) {
	if (!isNeutral(event.target as Element | null)) clearPending();
}

/** 焦点仍在中性位置时，把它移到页面标题；还没有可聚焦标题时暂放 #main-content。 */
function settleFocus() {
	const current = pending;
	if (!current) return;
	if (current.path !== location.pathname) {
		clearPending();
		return;
	}
	if (!isNeutral(document.activeElement)) return;
	const target = current.target?.() ?? pageRecoveryTarget();
	if (!target || target === document.activeElement) return;
	current.focused = target;
	// #main-content 只是兜底，不为它把页面滚回顶部。
	target.focus({ preventScroll: target.id === "main-content" });
}

function startPending(key: string, target?: () => HTMLElement | null) {
	clearPending();
	const main = document.getElementById("main-content") ?? document.body;
	const observer =
		typeof MutationObserver === "undefined"
			? null
			: new MutationObserver(settleFocus);
	pending = { key, path: location.pathname, focused: null, observer, target };
	// 页面标题可能是新插入的，也可能是复用的元素补上了 tabindex。
	observer?.observe(main, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["tabindex"],
	});
	document.addEventListener("focusin", onFocusIn, true);
	settleFocus();
}

/**
 * 读取失败后的恢复操作（「重新登录」「重新加载…」「重新读取」）与焦点。
 *
 * - 用户触发时调用 arm()；触发按钮卸载时若焦点已落到 body，就移到页面标题
 *   （pageRecoveryTarget），页面还在读取时先放 #main-content，标题出现后再移过去；
 * - 焦点仍在别处（用户已主动移开，或在另一条失败提示上）时不抢焦点；
 * - 请求进行中按钮保持可聚焦（调用方用 aria-disabled，不用原生 disabled），失败后焦点仍在
 *   按钮上；按钮在请求中卸载、又以同一个 key 重新挂载（仍然失败）时取回焦点。
 *
 * key 用按钮空闲时的名称；同一页面内不同的恢复操作 key 不同。target 可选：按钮所在分区离页面
 * 标题很远时（例如 API 凭证页底部的「应用管理」），恢复后焦点交给它返回的元素（需可程序聚焦），
 * 取不到时仍用页面标题（#3269 N8-3-02）。
 */
export function useRecoveryTrigger<T extends HTMLElement = HTMLButtonElement>(
	key: string,
	target?: () => HTMLElement | null,
) {
	const ref = useRef<T>(null);
	const armed = useRef(false);
	const latestKey = useRef(key);
	const latestTarget = useRef(target);
	useEffect(() => {
		latestKey.current = key;
		latestTarget.current = target;
	});
	useEffect(() => {
		const current = pending;
		if (current?.key === latestKey.current) {
			// 同一页面、焦点仍在中性位置：读取仍然失败，把焦点还给重新出现的按钮。
			const live =
				current.path === location.pathname &&
				(!current.focused || current.focused.isConnected);
			const take = live && isNeutral(document.activeElement);
			clearPending();
			if (take) ref.current?.focus();
		}
		return () => {
			if (!armed.current) return;
			armed.current = false;
			const active = document.activeElement;
			if (active && active !== document.body) return;
			startPending(latestKey.current, latestTarget.current);
		};
	}, []);
	const arm = useCallback(() => {
		armed.current = true;
	}, []);
	return { ref, arm };
}
