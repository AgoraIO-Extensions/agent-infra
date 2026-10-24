import { useCallback, useEffect, useRef } from "react";

function pageHeading() {
	return (
		document.getElementById("main-content") ?? document
	).querySelector<HTMLElement>("h1[tabindex]");
}

/**
 * 恢复成功后的焦点目标：主内容区第一个可程序聚焦的 h1（页面标题，tabIndex=-1）；页面标题
 * 不可聚焦时落到 #main-content（壳层跳转目标，同样是 tabIndex=-1），不让焦点留在 body。
 */
export function pageRecoveryTarget(): HTMLElement | null {
	return pageHeading() ?? document.getElementById("main-content");
}

/**
 * 进行中的恢复：触发按钮卸载、焦点已落到 body 时建立。期间焦点停在「中性位置」（body 或这里移过去
 * 的元素），页面后续渲染出恢复目标时移过去。
 *
 * 读取失败后重读（TanStack Query 没有数据时重读会回到 pending）常常先显示读取中、整页换掉，
 * 触发按钮因此在请求中途卸载；只看卸载那一刻无法区分恢复成功与仍在读取，所以要跟到结果出来。
 *
 * 焦点只交接一次（#3364 N12-3-01）：交给恢复目标后不再把焦点拉过去，只在它随重绘卸载、焦点丢到
 * body 时就地补回（不滚动）；同一个恢复操作重新出现（读取仍失败）时取回焦点。用户按下指针、按键或
 * 点击，焦点移到别处（含点主区空白处使焦点到 #main-content），或页面换了，就不再代管。
 */
let pending: {
	key: string;
	/** 触发时的页面地址（路径加查询串）：页面换了（路由跳转、浏览器后退）就不再代管。 */
	path: string;
	focused: HTMLElement | null;
	/** 已把焦点交给恢复目标（调用方指定的目标，没有指定时为页面标题；#main-content 兜底不算）。 */
	handedOff: boolean;
	observer: MutationObserver | null;
	/** 调用方指定的恢复目标（例如所在分区标题）；没有或取不到时用页面标题。 */
	target?: () => HTMLElement | null;
} | null = null;

/**
 * 当前页面：路径加查询串。同一路径换了查询（例如编辑另一个 Skill 项目，?project=…）也是另一个页面。
 */
function currentPage() {
	return location.pathname + location.search;
}

/** 用户自己的操作：结束代管，之后的重读与重绘不再移动焦点。 */
const userActions = ["pointerdown", "keydown", "click"] as const;

function isNeutral(element: Element | null) {
	return !element || element === document.body || element === pending?.focused;
}

function clearPending() {
	pending?.observer?.disconnect();
	pending = null;
	document.removeEventListener("focusin", onFocusIn, true);
	for (const type of userActions)
		document.removeEventListener(type, clearPending, true);
}

// 用户（或页面自己的焦点管理）把焦点移到中性位置以外：不再代管焦点。
function onFocusIn(event: FocusEvent) {
	if (!isNeutral(event.target as Element | null)) clearPending();
}

/**
 * 焦点仍在中性位置时，把它移到恢复目标；还没有可聚焦的目标时暂放 #main-content。已交接后只在焦点
 * 丢到 body 时补回。
 */
function settleFocus() {
	const current = pending;
	if (!current) return;
	if (current.path !== currentPage()) {
		clearPending();
		return;
	}
	const active = document.activeElement;
	const lost = !active || active === document.body;
	if (current.handedOff ? !lost : !isNeutral(active)) return;
	const preferred = current.target ? current.target() : pageHeading();
	const target =
		preferred ?? pageHeading() ?? document.getElementById("main-content");
	if (!target || target === active) return;
	// #main-content 只是兜底，交接后的补回只为不落到 body：都不为它把页面滚回顶部。
	const preventScroll = current.handedOff || target.id === "main-content";
	current.focused = target;
	if (target === preferred) current.handedOff = true;
	target.focus({ preventScroll });
}

function startPending(
	key: string,
	path: string,
	target?: () => HTMLElement | null,
) {
	clearPending();
	const main = document.getElementById("main-content") ?? document.body;
	const observer =
		typeof MutationObserver === "undefined"
			? null
			: new MutationObserver(settleFocus);
	pending = { key, path, focused: null, handedOff: false, observer, target };
	// 页面标题可能是新插入的，也可能是复用的元素补上了 tabindex。
	observer?.observe(main, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["tabindex"],
	});
	document.addEventListener("focusin", onFocusIn, true);
	for (const type of userActions)
		document.addEventListener(type, clearPending, true);
	settleFocus();
}

/**
 * 读取失败后的恢复操作（「重新登录」「重新加载…」「重新读取」）与焦点。
 *
 * - 用户触发时调用 arm()，记下当时的页面；触发按钮卸载时若仍在这个页面、焦点已落到 body，就移到
 *   页面标题（pageRecoveryTarget），页面还在读取时先放 #main-content，标题出现后再移过去；
 * - 焦点仍在别处（用户已主动移开，或在另一条失败提示上），或页面已经换了（例如重读进行中浏览器
 *   后退）时不抢焦点；
 * - 请求进行中按钮保持可聚焦（调用方用 aria-disabled，不用原生 disabled），失败后焦点仍在
 *   按钮上；按钮在请求中卸载、又以同一个 key 重新挂载（仍然失败）时取回焦点；
 * - 焦点只交接一次：交给恢复目标后，或用户按下指针、按键、点击后，之后的重读与重绘不再移动焦点。
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
	/** 触发时的页面地址；没有触发时为 null。 */
	const armed = useRef<string | null>(null);
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
				current.path === currentPage() &&
				(!current.focused || current.focused.isConnected);
			const take = live && isNeutral(document.activeElement);
			clearPending();
			if (take) ref.current?.focus();
		}
		return () => {
			const path = armed.current;
			if (path === null) return;
			armed.current = null;
			// 触发后已离开这个页面：新页面的焦点同普通导航，不把代管带过去。
			if (path !== currentPage()) return;
			const active = document.activeElement;
			if (active && active !== document.body) return;
			startPending(latestKey.current, path, latestTarget.current);
		};
	}, []);
	const arm = useCallback(() => {
		armed.current = currentPage();
	}, []);
	return { ref, arm };
}
