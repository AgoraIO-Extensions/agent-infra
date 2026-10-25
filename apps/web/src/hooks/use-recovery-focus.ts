import { type QueryClient, QueryClientContext } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";

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
 * 页面查询串中代表另一个资源的参数（例如 Skill 编辑器按 ?project= 换项目重挂载），由调用方在页面外层
 * 声明。代管期间这些参数变了视为离开页面；其余查询串变化（筛选、分页、Tab、?view=、?applicationId=
 * 后退等）仍是同一页面，代管继续（#3388 N13-03）。
 */
export const RecoveryPageParams = createContext<readonly string[]>([]);

/** 代管用的页面身份：路径，加上调用方声明的资源参数。 */
function pageIdentity(
	params: readonly string[],
	pathname = location.pathname,
	search = location.search,
) {
	if (params.length === 0) return pathname;
	const query = new URLSearchParams(search);
	return `${pathname}?${params.map((name) => `${name}=${query.get(name) ?? ""}`).join("&")}`;
}

/** 当前地址（路径加查询串）：判断按钮是否随导航一起卸载。 */
function currentHref() {
	return location.pathname + location.search;
}

/**
 * 最近一次获得焦点的元素与当时的地址。持有焦点的控件因非用户发起的重绘卸载或变为原生禁用时，焦点
 * 落到 body、不会再触发 focusin，据此判断焦点是丢失而不是用户移走的（#3388 N13-05、N13-06）。
 * 用户按下指针（点空白处由用户决定焦点去处）或换了路径后清空。
 */
let lastFocus: {
	element: Element;
	pathname: string;
	search: string;
	inMain: boolean;
	/** 获得焦点时的序号：大于 userActionSeq 表示获得焦点后用户还没有按键、按下指针或点击。 */
	seq: number;
} | null = null;

/** 焦点与用户操作共用的递增序号，比较先后不依赖时钟精度。 */
let seq = 0;
let userActionSeq = 0;

if (typeof document !== "undefined") {
	document.addEventListener(
		"focusin",
		(event) => {
			const element = event.target;
			// 焦点落到 body（浏览器的焦点修正）不是用户移走焦点，保留之前的记录。
			if (!(element instanceof Element) || element === document.body) return;
			seq += 1;
			lastFocus = {
				element,
				pathname: location.pathname,
				search: location.search,
				inMain: Boolean(
					document.getElementById("main-content")?.contains(element),
				),
				seq,
			};
		},
		true,
	);
	for (const type of ["keydown", "pointerdown", "click"] as const)
		document.addEventListener(
			type,
			() => {
				seq += 1;
				userActionSeq = seq;
				if (type === "pointerdown") lastFocus = null;
			},
			true,
		);
}

/**
 * element 持有焦点，且获得焦点后用户没有再按键、按下指针或点击：它此时卸载不是用户操作的结果
 * （例如按 Escape 关闭所在弹窗），而是后台重读、自动重连等非用户发起的重绘（#3388 N13-05）。
 */
function holdsUntouchedFocus(element: Element | null) {
	const active = document.activeElement;
	return Boolean(
		element &&
			active &&
			element.contains(active) &&
			lastFocus &&
			element.contains(lastFocus.element) &&
			lastFocus.seq > userActionSeq,
	);
}

function focusIsLost() {
	const active = document.activeElement;
	return !active || active === document.body || !active.isConnected;
}

/**
 * 之前持有焦点的正是 element，它随后被禁用或卸载、焦点已落到 body（或浏览器还没把焦点从变为禁用的
 * element 上移走），不是用户把焦点移到了别处。供页面自己的焦点交接使用（例如审计分页按钮读完后变为
 * 禁用，#3388 N13-06）。
 */
export function focusLostFrom(element: Element | null) {
	if (!element || lastFocus?.element !== element) return false;
	return (
		focusIsLost() ||
		(document.activeElement === element && element.matches(":disabled"))
	);
}

/** 主内容区里持有焦点的控件在同一页面上卸载或变为禁用，焦点因此落到 body（或即将落到 body）。 */
function focusLostOnPage(params: readonly string[]) {
	const last = lastFocus;
	if (!last?.inMain) return false;
	const gone = !last.element.isConnected;
	const disabled = !gone && last.element.matches(":disabled");
	return (
		(gone || disabled) &&
		(focusIsLost() || (disabled && document.activeElement === last.element)) &&
		pageIdentity(params, last.pathname, last.search) === pageIdentity(params)
	);
}

const trackedRouters = new WeakSet<object>();

/** 换了路径（导航到别的页面）后，上一页的焦点记录不再用于补回。 */
function trackNavigation(router: Router) {
	if (trackedRouters.has(router)) return;
	trackedRouters.add(router);
	router.subscribe("onResolved", (event) => {
		if (event.pathChanged) lastFocus = null;
	});
}

type Router = ReturnType<typeof useRouter>;

/** 能订阅导航完成事件的路由；没有路由（或单元测试里只替身了部分接口）时为 undefined。 */
function usableRouter(router: Router | null | undefined) {
	return typeof router?.subscribe === "function" ? router : undefined;
}

/**
 * 本次恢复请求是否仍在进行：onClick 返回的 Promise 未结束，或页面所用的 QueryClient 仍有读取 / 写入
 * （重读多由 TanStack Query 发出，按钮的 onClick 不一定返回 Promise）。
 */
type RequestWatch = {
	busy(): boolean;
	subscribe(listener: () => void): () => void;
};

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as PromiseLike<unknown>).then === "function"
	);
}

/** 没有 Promise、也没有 QueryClient 时无从得知请求何时结束，返回 null（代管到用户操作为止）。 */
function watchRequest(
	result: unknown,
	clients: readonly (QueryClient | undefined)[],
): RequestWatch | null {
	const live = [
		...new Set(clients.filter((client) => client !== undefined)),
	] as QueryClient[];
	const thenable = isThenable(result);
	if (!thenable && live.length === 0) return null;
	let running = thenable;
	const listeners = new Set<() => void>();
	if (thenable) {
		const done = () => {
			running = false;
			for (const listener of listeners) listener();
		};
		// 只关心请求何时结束：失败由调用方在界面上表达（失败提示与按钮），这里不再派生新的未处理拒绝。
		void Promise.resolve(result).then(done, done);
	}
	return {
		busy: () =>
			running ||
			live.some((client) => client.isFetching() + client.isMutating() > 0),
		subscribe(listener) {
			listeners.add(listener);
			const stops = live.flatMap((client) => [
				client.getQueryCache().subscribe(listener),
				client.getMutationCache().subscribe(listener),
			]);
			return () => {
				listeners.delete(listener);
				for (const stop of stops) stop();
			};
		},
	};
}

/** 恢复请求结束后这么久没有新的读取（页面已换上结果），本次恢复才算有了结果。 */
const settleMs = 300;

/**
 * 进行中的恢复：触发按钮（或持有焦点、未按下的恢复按钮）卸载、焦点已落到 body 时建立。期间焦点停在
 * 「中性位置」（body 或这里移过去的元素），页面后续渲染出恢复目标时移过去。
 *
 * 读取失败后重读（TanStack Query 没有数据时重读会回到 pending）常常先显示读取中、整页换掉，
 * 触发按钮因此在请求中途卸载；只看卸载那一刻无法区分恢复成功与仍在读取，所以要跟到结果出来。
 *
 * 焦点只交接一次（#3364 N12-3-01、#3388 N13-04）：本次恢复请求进行中，同一个恢复操作重新出现（仍失败）
 * 时取回焦点；请求结束、页面换上结果后（final），之后同一个按钮因后台重读再次出现（成功或失败）都不取回
 * 焦点、不滚动。交给恢复目标后不再把焦点拉过去，只在焦点随重绘丢到 body 时就地补回（不滚动）。用户按下
 * 指针、按键或点击，焦点移到别处（含点主区空白处使焦点到 #main-content），或换了页面，就不再代管。
 */
let pending: {
	key: string;
	/** 建立代管时的页面身份（路径加声明的资源参数）：换了页面就不再代管。 */
	page: string;
	params: readonly string[];
	focused: HTMLElement | null;
	/** 已把焦点交给恢复目标（调用方指定的目标，没有指定时为页面标题；#main-content 兜底不算）。 */
	handedOff: boolean;
	/** 本次恢复请求已有结果：同一个恢复操作再出现时不再取回焦点（#3388 N13-04）。 */
	final: boolean;
	/** 不是用户按下的恢复（持有焦点的按钮被后台重绘卸载）：交接与补回都不滚动页面（#3388 N13-05）。 */
	quiet: boolean;
	observer: MutationObserver | null;
	/** 调用方指定的恢复目标（例如所在分区标题）；没有或取不到时用页面标题。 */
	target?: () => HTMLElement | null;
	stopWatching?: () => void;
} | null = null;

/** 用户自己的操作：结束代管，之后的重读与重绘不再移动焦点。 */
const userActions = ["pointerdown", "keydown", "click"] as const;

function isNeutral(element: Element | null) {
	return !element || element === document.body || element === pending?.focused;
}

function clearPending() {
	const current = pending;
	pending = null;
	current?.observer?.disconnect();
	current?.stopWatching?.();
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
 * 丢到 body 时补回，不滚动。本次恢复已有结果（final）或不是用户按下的恢复（quiet）时同样不滚动。
 */
function settleFocus() {
	const current = pending;
	if (!current) return;
	if (current.page !== pageIdentity(current.params)) {
		clearPending();
		return;
	}
	const active = document.activeElement;
	const lost = focusIsLost();
	if (current.handedOff ? !lost : !isNeutral(active)) return;
	const preferred = current.target ? current.target() : pageHeading();
	const target =
		preferred ?? pageHeading() ?? document.getElementById("main-content");
	if (!target || target === active) return;
	// #main-content 只是兜底，交接后的补回只为不落到 body：都不为它把页面滚回顶部。
	const preventScroll =
		current.handedOff ||
		current.final ||
		current.quiet ||
		target.id === "main-content";
	current.focused = target;
	if (target === preferred) current.handedOff = true;
	target.focus({ preventScroll });
}

/** 本次恢复请求结束、之后 settleMs 内没有新的读取时，本次恢复有了结果（final）。 */
function finishWhenSettled(
	current: NonNullable<typeof pending>,
	watch: RequestWatch,
) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const check = () => {
		clearTimeout(timer);
		if (watch.busy()) return;
		timer = setTimeout(() => {
			if (pending !== current || watch.busy()) return;
			current.final = true;
			current.stopWatching?.();
			current.stopWatching = undefined;
		}, settleMs);
	};
	const stop = watch.subscribe(check);
	check();
	return () => {
		clearTimeout(timer);
		stop();
	};
}

function startPending(
	key: string,
	params: readonly string[],
	target: (() => HTMLElement | null) | undefined,
	watch: RequestWatch | null,
	quiet: boolean,
) {
	clearPending();
	const main = document.getElementById("main-content") ?? document.body;
	const observer =
		typeof MutationObserver === "undefined"
			? null
			: new MutationObserver(settleFocus);
	const current: NonNullable<typeof pending> = {
		key,
		page: pageIdentity(params),
		params,
		focused: null,
		handedOff: false,
		final: false,
		quiet,
		observer,
		target,
	};
	pending = current;
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
	if (watch) current.stopWatching = finishWhenSettled(current, watch);
	settleFocus();
}

/**
 * 页面级失败态替换主内容（筛选与表格收起、详情整页换成失败卡等）时，原来持有焦点的控件随之卸载、焦点
 * 落到 body：新的恢复按钮挂载后交给页面 h1（不可聚焦时 #main-content），不滚动（#3388 N13-05）。
 * 放到下一个任务再做，先让页面自己的焦点交接（同一次提交的 effect）处理。
 */
function restoreLostFocusSoon(params: readonly string[]) {
	if (!focusLostOnPage(params)) return;
	setTimeout(() => {
		if (!pending && focusLostOnPage(params))
			pageRecoveryTarget()?.focus({ preventScroll: true });
	}, 0);
}

/**
 * 页面级状态卡（读取失败、登录失效、无权、不存在、响应无效）挂载时调用：它替换了主内容、卸载了持有焦点的
 * 控件（例如回到标签页的后台重读读到无权，Agent 管理收起筛选）时，焦点交给页面 h1，不落到 body、不滚动
 * （#3388 N13-05）。卡片里的恢复按钮挂载时同样会检查，没有恢复按钮的卡片（无法访问等）靠这里。
 */
export function useRestoreLostFocus() {
	const params = useContext(RecoveryPageParams);
	const latestParams = useRef(params);
	latestParams.current = params;
	useEffect(() => {
		if (!pending) restoreLostFocusSoon(latestParams.current);
	}, []);
}

/**
 * 读取失败后的恢复操作（「重新登录」「重新加载…」「重新读取」）与焦点。
 *
 * - 用户触发时调用 run(onClick)，跟踪本次恢复请求（onClick 返回的 Promise 与页面的 QueryClient）；
 *   触发按钮卸载时若仍在这个页面、焦点已落到 body，就移到页面标题（pageRecoveryTarget），页面还在
 *   读取时先放 #main-content，标题出现后再移过去；
 * - 未按下但持有焦点的恢复按钮（获得焦点后用户没有再操作）因后台重读、自动重连等卸载时同样处理，
 *   交接不滚动页面（#3388 N13-05）；
 * - 焦点仍在别处（用户已主动移开，或在另一条失败提示上），或按钮随导航一起卸载（换了页面，例如
 *   重读进行中浏览器后退到上一页）时不抢焦点；按钮在地址变化后仍挂载（同页查询串变化、壳层状态卡
 *   跨路由保留）时，以变化后的地址为它所在的页面（#3388 N13-03）；
 * - 请求进行中按钮保持可聚焦（调用方用 aria-disabled，不用原生 disabled），失败后焦点仍在
 *   按钮上；按钮在请求中卸载、又以同一个 key 重新挂载（仍然失败）时取回焦点；
 * - 焦点只交接一次：本次恢复请求有了结果后，同一个恢复操作因后台重读再次出现时不取回焦点；交给恢复
 *   目标后，或用户按下指针、按键、点击后，之后的重读与重绘不再移动焦点，只补回丢到 body 的焦点。
 *
 * key 用按钮空闲时的名称；同一页面内不同的恢复操作 key 不同。target 可选：按钮所在分区离页面
 * 标题很远时（例如 API 凭证页底部的「应用管理」），恢复后焦点交给它返回的元素（需可程序聚焦），
 * 取不到时仍用页面标题（#3269 N8-3-02）。clients 是页面 QueryClient 之外还要跟踪的 QueryClient
 * （例如壳层会话）。
 */
export function useRecoveryTrigger<T extends HTMLElement = HTMLButtonElement>(
	key: string,
	target?: () => HTMLElement | null,
	clients: readonly (QueryClient | undefined)[] = [],
) {
	const ref = useRef<T>(null);
	const queryClient = useContext(QueryClientContext);
	const params = useContext(RecoveryPageParams);
	const router = usableRouter(useRouter({ warn: false }));
	/** 按钮所在页面的地址：挂载、触发时记下，导航后按钮仍挂载时更新为新地址。 */
	const href = useRef<string | null>(null);
	/** 触发后跟踪的恢复请求；没有触发时为 undefined。 */
	const armed = useRef<{ watch: RequestWatch | null } | undefined>(undefined);
	/** 卸载那一刻按钮自身是否持有焦点。 */
	const holding = useRef(false);
	const latest = useRef({
		key,
		target,
		params,
		clients: [queryClient, ...clients],
	});
	useEffect(() => {
		latest.current = {
			key,
			target,
			params,
			clients: [queryClient, ...clients],
		};
	});
	// 没有路由（单元测试）时，按钮每次提交仍在文档中即确认它在当前地址。
	useEffect(() => {
		if (!router && ref.current?.isConnected) href.current = currentHref();
	});
	// 有路由时只在导航完成、新页面已渲染后确认：按钮随旧页面卸载时这里已不在文档中。
	useEffect(() => {
		if (!router) return;
		trackNavigation(router);
		return router.subscribe("onResolved", () => {
			if (ref.current?.isConnected) href.current = currentHref();
		});
	}, [router]);
	// 卸载时 DOM 移除之前（layout 清理）记下按钮是否持有焦点、且获得焦点后用户没有再操作；之后的处理
	// 放在 passive 清理里。
	useLayoutEffect(() => {
		const element = ref.current;
		return () => {
			holding.current = holdsUntouchedFocus(element);
		};
	}, []);
	useEffect(() => {
		href.current = currentHref();
		const current = pending;
		if (current?.key === latest.current.key && !current.final) {
			// 同一页面、本次恢复请求仍在进行、焦点仍在中性位置：读取仍然失败，把焦点还给重新出现的按钮。
			const live =
				current.page === pageIdentity(current.params) &&
				(!current.focused || current.focused.isConnected);
			const take = live && isNeutral(document.activeElement);
			clearPending();
			if (take) ref.current?.focus();
		} else if (!current) restoreLostFocusSoon(latest.current.params);
		return () => {
			const trigger = armed.current;
			armed.current = undefined;
			if (!trigger && !holding.current) return;
			// 按钮随导航一起卸载（换了页面）：新页面的焦点同普通导航，不把代管带过去。
			if (href.current !== currentHref()) return;
			const active = document.activeElement;
			if (active && active !== document.body) return;
			const { key, target, params, clients } = latest.current;
			startPending(
				key,
				params,
				target,
				trigger ? trigger.watch : watchRequest(undefined, clients),
				!trigger,
			);
		};
	}, []);
	const run = useCallback((action: () => unknown) => {
		href.current = currentHref();
		armed.current = { watch: null };
		const result = action();
		armed.current = {
			watch: watchRequest(result, latest.current.clients),
		};
	}, []);
	return { ref, run };
}
