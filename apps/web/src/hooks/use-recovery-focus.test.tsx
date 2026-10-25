import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecoveryButton } from "../features/recovery-button.js";
import {
	focusLostFrom,
	pageRecoveryTarget,
	RecoveryPageParams,
} from "./use-recovery-focus.js";

// 恢复代管与焦点记录是模块级状态：每个用例结束时模拟一次用户按下指针，结束代管、清空焦点记录。
afterEach(() => {
	fireEvent.pointerDown(document.body);
	cleanup();
});

type State = "failed" | "retrying" | "loading" | "ready";

// 失败时显示「重新加载」按钮；loading 模拟重置查询后先显示读取中、按钮卸载。
function Page({
	state,
	onRetry,
	other = false,
	focusableHeading = true,
}: {
	state: State;
	onRetry: () => void;
	other?: boolean;
	focusableHeading?: boolean;
}) {
	return (
		<div id="main-content" tabIndex={-1}>
			<h1 tabIndex={focusableHeading ? -1 : undefined}>页面标题</h1>
			{other ? <button type="button">另一个按钮</button> : null}
			{state === "failed" || state === "retrying" ? (
				<RecoveryButton
					recoveryKey="重新加载"
					busy={state === "retrying"}
					onClick={onRetry}
				>
					{state === "retrying" ? "正在重新加载…" : "重新加载"}
				</RecoveryButton>
			) : state === "loading" ? (
				<p>正在读取…</p>
			) : (
				<p>内容</p>
			)}
		</div>
	);
}

const heading = () => screen.getByRole("heading", { name: "页面标题" });
const retry = () =>
	screen.getByRole("button", { name: /^(重新加载|正在重新加载…)$/ });

describe("RecoveryButton / useRecoveryTrigger", () => {
	it("keeps focus on the busy retry and on it again after the retry fails", () => {
		const onRetry = vi.fn();
		const view = render(<Page state="failed" onRetry={onRetry} />);
		retry().focus();
		fireEvent.click(retry());
		expect(onRetry).toHaveBeenCalledOnce();
		view.rerender(<Page state="retrying" onRetry={onRetry} />);
		// 请求中不设原生 disabled：焦点不丢到 body，重复点击被忽略。
		expect(retry().hasAttribute("disabled")).toBe(false);
		expect(retry().getAttribute("aria-disabled")).toBe("true");
		expect(document.activeElement).toBe(retry());
		fireEvent.click(retry());
		expect(onRetry).toHaveBeenCalledOnce();
		view.rerender(<Page state="failed" onRetry={onRetry} />);
		expect(document.activeElement).toBe(retry());
	});

	it("moves focus to the page h1 after a user-triggered recovery removes the button", () => {
		const onRetry = vi.fn();
		const view = render(<Page state="failed" onRetry={onRetry} />);
		retry().focus();
		fireEvent.click(retry());
		view.rerender(<Page state="retrying" onRetry={onRetry} />);
		view.rerender(<Page state="ready" onRetry={onRetry} />);
		expect(document.activeElement).toBe(heading());
	});

	it("does not move focus when the failure clears on its own", () => {
		const view = render(<Page state="failed" onRetry={vi.fn()} />);
		view.rerender(<Page state="ready" onRetry={vi.fn()} />);
		expect(document.activeElement).toBe(document.body);
	});

	it("does not steal focus the user already moved elsewhere", () => {
		const onRetry = vi.fn();
		const view = render(<Page state="failed" onRetry={onRetry} other />);
		fireEvent.click(retry());
		const other = screen.getByRole("button", { name: "另一个按钮" });
		other.focus();
		view.rerender(<Page state="ready" onRetry={onRetry} other />);
		expect(document.activeElement).toBe(other);
	});

	it("returns focus to the remounted retry when a reset reload fails again", () => {
		const onRetry = vi.fn();
		const view = render(<Page state="failed" onRetry={onRetry} />);
		retry().focus();
		fireEvent.click(retry());
		// 重置查询：先显示读取中，按钮卸载，焦点暂放页面标题。
		view.rerender(<Page state="loading" onRetry={onRetry} />);
		expect(document.activeElement).toBe(heading());
		// 再次失败：同一个恢复操作重新出现，焦点还给它。
		view.rerender(<Page state="failed" onRetry={onRetry} />);
		expect(document.activeElement).toBe(retry());
	});

	it("keeps the heading focused when the reset reload recovers", () => {
		const onRetry = vi.fn();
		const view = render(<Page state="failed" onRetry={onRetry} />);
		retry().focus();
		fireEvent.click(retry());
		view.rerender(<Page state="loading" onRetry={onRetry} />);
		view.rerender(<Page state="ready" onRetry={onRetry} />);
		expect(document.activeElement).toBe(heading());
	});

	it("does not pull focus back once the user moved away from the heading", () => {
		const onRetry = vi.fn();
		const view = render(<Page state="failed" onRetry={onRetry} other />);
		retry().focus();
		fireEvent.click(retry());
		view.rerender(<Page state="loading" onRetry={onRetry} other />);
		const other = screen.getByRole("button", { name: "另一个按钮" });
		other.focus();
		view.rerender(<Page state="failed" onRetry={onRetry} other />);
		expect(document.activeElement).toBe(other);
	});
});

// 详情页：重读时整页换成读取中（标题不可聚焦），恢复后换成就绪页（新的可聚焦 h1）。
function DetailPage({ state, onRetry }: { state: State; onRetry: () => void }) {
	return (
		<div id="main-content" tabIndex={-1}>
			{state === "loading" ? (
				<h1>读取中</h1>
			) : state === "ready" ? (
				<h1 tabIndex={-1}>就绪标题</h1>
			) : (
				<>
					<h1>详情</h1>
					<RecoveryButton recoveryKey="重新加载" onClick={onRetry}>
						重新加载
					</RecoveryButton>
				</>
			)}
		</div>
	);
}

describe("RecoveryButton on a page that shows a loading page while re-reading", () => {
	it("parks focus on #main-content while loading, then moves it to the ready h1", async () => {
		const onRetry = vi.fn();
		const view = render(<DetailPage state="failed" onRetry={onRetry} />);
		retry().focus();
		fireEvent.click(retry());
		view.rerender(<DetailPage state="loading" onRetry={onRetry} />);
		expect(document.activeElement?.id).toBe("main-content");
		view.rerender(<DetailPage state="ready" onRetry={onRetry} />);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("heading", { name: "就绪标题" }),
			),
		);
	});

	it("returns focus to the retry when the re-read fails again", async () => {
		const onRetry = vi.fn();
		const view = render(<DetailPage state="failed" onRetry={onRetry} />);
		retry().focus();
		fireEvent.click(retry());
		view.rerender(<DetailPage state="loading" onRetry={onRetry} />);
		view.rerender(<DetailPage state="failed" onRetry={onRetry} />);
		await waitFor(() => expect(document.activeElement).toBe(retry()));
	});
});

// #3269 N8-3-02：按钮所在分区离页面标题很远时，恢复后焦点交给调用方指定的分区标题。
function SectionPage({
	state,
	onRetry,
	withTarget = true,
}: {
	state: State;
	onRetry: () => void;
	withTarget?: boolean;
}) {
	return (
		<div id="main-content" tabIndex={-1}>
			<h1 tabIndex={-1}>页面标题</h1>
			<h2 id="section-title" tabIndex={-1}>
				分区标题
			</h2>
			{state === "failed" ? (
				<RecoveryButton
					recoveryKey="重新加载分区"
					recoveryTarget={
						withTarget
							? () => document.getElementById("section-title")
							: () => null
					}
					onClick={onRetry}
				>
					重新加载
				</RecoveryButton>
			) : state === "loading" ? (
				<p>正在读取…</p>
			) : (
				<p>内容</p>
			)}
		</div>
	);
}

describe("RecoveryButton with a recovery target", () => {
	it("moves focus to the given section heading while loading and after recovery", () => {
		const onRetry = vi.fn();
		const view = render(<SectionPage state="failed" onRetry={onRetry} />);
		retry().focus();
		fireEvent.click(retry());
		expect(onRetry).toHaveBeenCalledOnce();
		view.rerender(<SectionPage state="loading" onRetry={onRetry} />);
		const section = screen.getByRole("heading", { name: "分区标题" });
		expect(document.activeElement).toBe(section);
		view.rerender(<SectionPage state="ready" onRetry={onRetry} />);
		expect(document.activeElement).toBe(section);
	});

	it("returns focus to the retry when it fails again, and falls back to the h1 without a target", () => {
		const onRetry = vi.fn();
		const view = render(<SectionPage state="failed" onRetry={onRetry} />);
		retry().focus();
		fireEvent.click(retry());
		view.rerender(<SectionPage state="loading" onRetry={onRetry} />);
		view.rerender(<SectionPage state="failed" onRetry={onRetry} />);
		expect(document.activeElement).toBe(retry());
		view.rerender(
			<SectionPage state="failed" onRetry={onRetry} withTarget={false} />,
		);
		fireEvent.click(retry());
		view.rerender(
			<SectionPage state="ready" onRetry={onRetry} withTarget={false} />,
		);
		expect(document.activeElement).toBe(heading());
	});
});

// #3364 N12-3-01：恢复焦点只交接一次。交给恢复目标后，用户点主区空白处（焦点到 #main-content）、按下
// 指针、按键或点击后，之后的重读与重绘不再把焦点拉回标题；触发后离开页面也不把代管带到新页面。
describe("RecoveryButton hands recovery focus over only once", () => {
	function recoverToHeading(other = false) {
		const onRetry = vi.fn();
		const view = render(
			<Page state="failed" onRetry={onRetry} other={other} />,
		);
		retry().focus();
		fireEvent.click(retry());
		view.rerender(<Page state="loading" onRetry={onRetry} other={other} />);
		view.rerender(<Page state="ready" onRetry={onRetry} other={other} />);
		expect(document.activeElement).toBe(heading());
		return { view, onRetry };
	}
	const main = () => document.getElementById("main-content");

	it("does not pull focus back after the user puts it on #main-content", async () => {
		const { view, onRetry } = recoverToHeading();
		// 点主区空白处：浏览器把焦点交给 tabIndex=-1 的 #main-content。
		main()?.focus();
		view.rerender(<Page state="loading" onRetry={onRetry} />);
		view.rerender(<Page state="ready" onRetry={onRetry} />);
		await Promise.resolve();
		expect(document.activeElement).toBe(main());
	});

	it.each([
		["pointerdown", () => fireEvent.pointerDown(document.body)],
		["keydown", () => fireEvent.keyDown(document.body, { key: "PageDown" })],
		["click", () => fireEvent.click(document.body)],
	])("ends the handoff on a user %s", async (_name, act) => {
		const { view, onRetry } = recoverToHeading();
		act();
		// 之后重绘把焦点丢到 body，也不再代管；同一个恢复操作重新出现时不抢焦点。
		heading().blur();
		view.rerender(<Page state="loading" onRetry={onRetry} />);
		view.rerender(<Page state="ready" onRetry={onRetry} />);
		await Promise.resolve();
		expect(document.activeElement).toBe(document.body);
		view.rerender(<Page state="failed" onRetry={onRetry} />);
		expect(document.activeElement).toBe(document.body);
	});

	it("stops parking focus once the user acts while the re-read is still loading", async () => {
		const onRetry = vi.fn();
		const view = render(<DetailPage state="failed" onRetry={onRetry} />);
		retry().focus();
		fireEvent.click(retry());
		view.rerender(<DetailPage state="loading" onRetry={onRetry} />);
		expect(document.activeElement?.id).toBe("main-content");
		fireEvent.keyDown(document.body, { key: "Tab" });
		view.rerender(<DetailPage state="ready" onRetry={onRetry} />);
		await Promise.resolve();
		expect(document.activeElement?.id).toBe("main-content");
	});

	it.each([
		["another path", "/previous-page"],
		["the same path with another query", "?project=other"],
	])("does not take a recovery over to %s", async (_name, next) => {
		const onRetry = vi.fn();
		const start = location.pathname + location.search;
		const view = render(<Page state="failed" onRetry={onRetry} />);
		retry().focus();
		fireEvent.click(retry());
		view.rerender(<Page state="retrying" onRetry={onRetry} />);
		// 重读进行中浏览器后退：地址先变，触发按钮随旧页面卸载。
		history.pushState(null, "", next);
		try {
			view.rerender(<Page state="ready" onRetry={onRetry} />);
			await Promise.resolve();
			expect(document.activeElement).toBe(document.body);
			view.rerender(<Page state="failed" onRetry={onRetry} />);
			expect(document.activeElement).toBe(document.body);
		} finally {
			history.replaceState(null, "", start);
		}
	});
});

describe("pageRecoveryTarget", () => {
	it("prefers the focusable page h1 and falls back to #main-content", () => {
		const view = render(<Page state="ready" onRetry={vi.fn()} />);
		expect(pageRecoveryTarget()).toBe(heading());
		view.rerender(
			<Page state="ready" onRetry={vi.fn()} focusableHeading={false} />,
		);
		expect(pageRecoveryTarget()?.id).toBe("main-content");
	});
});

/** 地址改到 next，结束时恢复原地址。 */
async function atAddress(next: string, run: () => Promise<void> | void) {
	const start = location.pathname + location.search;
	history.pushState(null, "", next);
	try {
		await run();
	} finally {
		history.replaceState(null, "", start);
	}
}

// #3388 N13-03：「离开页面」只指路径变化（或调用方声明的资源参数变化），或恢复按钮随导航一起卸载；同一页面的
// 查询串变化（筛选、分页、Tab、?view= 后退等）期间按钮仍在，代管继续，结果按同页规则。
describe("RecoveryButton keeps recovering across same-page query changes", () => {
	it.each([
		["recovers", "ready", () => heading()],
		["fails again", "failed", () => retry()],
	] as const)(
		"moves focus as on the same page when the read %s after a query change",
		(_name, outcome, focused) => {
			const onRetry = vi.fn();
			const view = render(<Page state="failed" onRetry={onRetry} />);
			retry().focus();
			fireEvent.click(retry());
			view.rerender(<Page state="retrying" onRetry={onRetry} />);
			return atAddress("?view=history", () => {
				// 按钮在查询串变化后仍挂载（重绘时仍在文档中）：它所在的页面就是变化后的地址。
				view.rerender(<Page state="retrying" onRetry={onRetry} />);
				expect(document.activeElement).toBe(retry());
				view.rerender(<Page state="loading" onRetry={onRetry} />);
				expect(document.activeElement).toBe(heading());
				view.rerender(<Page state={outcome} onRetry={onRetry} />);
				expect(document.activeElement).toBe(focused());
			});
		},
	);

	it("keeps parking focus when only an undeclared query changes while loading", async () => {
		const onRetry = vi.fn();
		const view = render(<DetailPage state="failed" onRetry={onRetry} />);
		retry().focus();
		fireEvent.click(retry());
		view.rerender(<DetailPage state="loading" onRetry={onRetry} />);
		expect(document.activeElement?.id).toBe("main-content");
		await atAddress("?page=2", async () => {
			view.rerender(<DetailPage state="ready" onRetry={onRetry} />);
			await waitFor(() =>
				expect(document.activeElement).toBe(
					screen.getByRole("heading", { name: "就绪标题" }),
				),
			);
		});
	});

	it("stops recovering when a declared resource parameter changes", async () => {
		const onRetry = vi.fn();
		const view = render(
			<RecoveryPageParams value={["project"]}>
				<DetailPage state="failed" onRetry={onRetry} />
			</RecoveryPageParams>,
		);
		retry().focus();
		fireEvent.click(retry());
		view.rerender(
			<RecoveryPageParams value={["project"]}>
				<DetailPage state="loading" onRetry={onRetry} />
			</RecoveryPageParams>,
		);
		expect(document.activeElement?.id).toBe("main-content");
		await atAddress("?project=other", async () => {
			view.rerender(
				<RecoveryPageParams value={["project"]}>
					<DetailPage state="ready" onRetry={onRetry} />
				</RecoveryPageParams>,
			);
			await Promise.resolve();
			expect(document.activeElement?.id).toBe("main-content");
			expect(document.activeElement).not.toBe(
				screen.getByRole("heading", { name: "就绪标题" }),
			);
		});
	});
});

/** 可控的恢复请求：onRetry 返回的 Promise 由用例结束。 */
function controlledRequest() {
	let finish = () => {};
	const onRetry = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	return { onRetry, finish: () => finish() };
}

const settle = () =>
	act(() => new Promise((resolve) => setTimeout(resolve, 400)));

// #3388 N13-04：恢复焦点只交接一次。本次恢复请求有了结果、焦点交给恢复目标后，同一个恢复按钮因后台重读
// 再次出现（读取又失败）不取回焦点、不滚动；「仍失败回到按钮」只指本次恢复请求本身失败。
describe("RecoveryButton ends the handoff once the recovery request has a result", () => {
	it("does not take focus back when a later background read fails again", async () => {
		const request = controlledRequest();
		const view = render(<Page state="failed" onRetry={request.onRetry} />);
		retry().focus();
		fireEvent.click(retry());
		view.rerender(<Page state="loading" onRetry={request.onRetry} />);
		expect(document.activeElement).toBe(heading());
		await act(async () => request.finish());
		view.rerender(<Page state="ready" onRetry={request.onRetry} />);
		expect(document.activeElement).toBe(heading());
		await settle();
		const scroll = vi.spyOn(HTMLElement.prototype, "focus");
		view.rerender(<Page state="failed" onRetry={request.onRetry} />);
		expect(document.activeElement).toBe(heading());
		expect(scroll).not.toHaveBeenCalled();
		scroll.mockRestore();
	});

	it("still returns focus to the retry when the recovery request itself fails", async () => {
		const request = controlledRequest();
		const view = render(<Page state="failed" onRetry={request.onRetry} />);
		retry().focus();
		fireEvent.click(retry());
		view.rerender(<Page state="loading" onRetry={request.onRetry} />);
		expect(document.activeElement).toBe(heading());
		// 请求结束与页面换上失败结果在同一时刻：仍是本次请求的结果。
		await act(async () => request.finish());
		view.rerender(<Page state="failed" onRetry={request.onRetry} />);
		expect(document.activeElement).toBe(retry());
	});

	it("still hands focus to an h1 that renders after the request finished", async () => {
		const request = controlledRequest();
		const view = render(
			<DetailPage state="failed" onRetry={request.onRetry} />,
		);
		retry().focus();
		fireEvent.click(retry());
		view.rerender(<DetailPage state="loading" onRetry={request.onRetry} />);
		expect(document.activeElement?.id).toBe("main-content");
		// 恢复请求（例如壳层确认会话）先结束，页面内容稍后才读到：仍是本次恢复的交接，焦点到就绪标题。
		await act(async () => request.finish());
		await settle();
		view.rerender(<DetailPage state="ready" onRetry={request.onRetry} />);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("heading", { name: "就绪标题" }),
			),
		);
	});

	it("treats a rejected recovery request as finished without an unhandled rejection", async () => {
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			let reject = (_error: Error) => {};
			const onRetry = vi.fn(
				() =>
					new Promise<void>((_resolve, fail) => {
						reject = fail;
					}),
			);
			const view = render(<Page state="failed" onRetry={onRetry} />);
			retry().focus();
			fireEvent.click(retry());
			view.rerender(<Page state="loading" onRetry={onRetry} />);
			expect(document.activeElement).toBe(heading());
			await act(async () => reject(new Error("恢复请求失败")));
			await settle();
			// 请求已结束（失败也算有了结果）：之后同一个按钮因后台重读再出现，不取回焦点。
			view.rerender(<Page state="failed" onRetry={onRetry} />);
			expect(document.activeElement).toBe(heading());
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", unhandled);
		}
	});

	it("restores a lost focus without scrolling after the handoff", async () => {
		const request = controlledRequest();
		// 就绪页与失败页的标题是不同的元素：后台重读失败整页替换时就绪标题随之卸载。
		function ReplacedPage({ state }: { state: State }) {
			return (
				<div id="main-content" tabIndex={-1}>
					{state === "ready" ? (
						<h1 key="ready" tabIndex={-1}>
							就绪标题
						</h1>
					) : state === "loading" ? (
						<p>正在读取…</p>
					) : (
						<section key="failed">
							<h2>读取失败</h2>
							<RecoveryButton recoveryKey="重新加载" onClick={request.onRetry}>
								重新加载
							</RecoveryButton>
						</section>
					)}
				</div>
			);
		}
		const view = render(<ReplacedPage state="failed" />);
		retry().focus();
		fireEvent.click(retry());
		view.rerender(<ReplacedPage state="loading" />);
		await act(async () => request.finish());
		view.rerender(<ReplacedPage state="ready" />);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("heading", { name: "就绪标题" }),
			),
		);
		await settle();
		// 后台重读又失败，整页换成失败态：就绪标题随之卸载，焦点不落到 body、不取回到按钮。
		const focus = vi.spyOn(HTMLElement.prototype, "focus");
		view.rerender(<ReplacedPage state="failed" />);
		await waitFor(() =>
			expect(document.activeElement?.id).toBe("main-content"),
		);
		expect(focus).toHaveBeenCalledWith({ preventScroll: true });
		focus.mockRestore();
	});

	it("tracks a TanStack Query re-read that the button does not return", async () => {
		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
			},
		});
		let fail = true;
		let release = () => {};
		const read = vi.fn(
			() =>
				new Promise<string>((resolve, reject) => {
					release = () =>
						fail ? reject(new Error("读取失败")) : resolve("内容");
				}),
		);
		function QueryPage() {
			const query = useQuery({ queryKey: ["recovery"], queryFn: read });
			return (
				<Page
					state={
						query.isPending
							? "loading"
							: query.isError
								? query.isFetching
									? "retrying"
									: "failed"
								: "ready"
					}
					onRetry={() => void query.refetch()}
				/>
			);
		}
		render(
			<QueryClientProvider client={client}>
				<QueryPage />
			</QueryClientProvider>,
		);
		await act(async () => release());
		await waitFor(() => expect(retry()).toBeTruthy());
		retry().focus();
		fireEvent.click(retry());
		// 没有数据的查询重读回到 pending：页面换成读取中，按钮卸载，焦点暂放页面标题。
		await waitFor(() => expect(document.activeElement).toBe(heading()));
		fail = false;
		await act(async () => release());
		await waitFor(() => expect(screen.getByText("内容")).toBeTruthy());
		expect(document.activeElement).toBe(heading());
		await settle();
		// 后台重读失败（有数据时 status 变为 error）：同一个按钮再次出现，不取回焦点。
		fail = true;
		await act(async () => {
			const background = client.refetchQueries();
			release();
			await background;
		});
		await waitFor(() => expect(retry()).toBeTruthy());
		await settle();
		expect(document.activeElement).toBe(heading());
		client.clear();
	});
});

// 页面里另有一个控件（例如筛选输入框）；失败态替换主内容时它随之卸载。
function FilterPage({
	state,
	onRetry,
}: {
	state: "ready" | "failed";
	onRetry: () => void;
}) {
	return (
		<div id="main-content" tabIndex={-1}>
			<h1 tabIndex={-1}>页面标题</h1>
			{state === "ready" ? (
				<input aria-label="搜索" />
			) : (
				<RecoveryButton recoveryKey="重新加载" onClick={onRetry}>
					重新加载
				</RecoveryButton>
			)}
		</div>
	);
}

// #3388 N13-05：持有焦点的控件（含未按下的恢复按钮、筛选控件）因非用户发起的重绘卸载或变为原生禁用时，
// 焦点交给同页的页面 h1（不可聚焦时 #main-content），不落到 body、不滚动。
describe("focus held by a control that a background re-render removes", () => {
	it("moves focus to the h1 when a focused, unpressed retry is removed by a background recovery", () => {
		const view = render(<Page state="failed" onRetry={vi.fn()} />);
		retry().focus();
		view.rerender(<Page state="loading" onRetry={vi.fn()} />);
		expect(document.activeElement).toBe(heading());
		view.rerender(<Page state="ready" onRetry={vi.fn()} />);
		expect(document.activeElement).toBe(heading());
	});

	it("returns focus to that retry when the background re-read fails again", () => {
		const view = render(<DetailPage state="failed" onRetry={vi.fn()} />);
		retry().focus();
		view.rerender(<DetailPage state="loading" onRetry={vi.fn()} />);
		expect(document.activeElement?.id).toBe("main-content");
		view.rerender(<DetailPage state="failed" onRetry={vi.fn()} />);
		expect(document.activeElement).toBe(retry());
	});

	it("moves focus to the h1 when a failure replaces the focused filter", async () => {
		const view = render(<FilterPage state="ready" onRetry={vi.fn()} />);
		screen.getByRole("textbox", { name: "搜索" }).focus();
		const focus = vi.spyOn(HTMLElement.prototype, "focus");
		view.rerender(<FilterPage state="failed" onRetry={vi.fn()} />);
		await waitFor(() => expect(document.activeElement).toBe(heading()));
		expect(focus).toHaveBeenCalledWith({ preventScroll: true });
		focus.mockRestore();
	});

	it("leaves focus alone when the failure appears on another page", async () => {
		const view = render(<FilterPage state="ready" onRetry={vi.fn()} />);
		screen.getByRole("textbox", { name: "搜索" }).focus();
		await atAddress("/another-page", async () => {
			view.rerender(<FilterPage state="failed" onRetry={vi.fn()} />);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(document.activeElement).toBe(document.body);
		});
	});

	it("leaves focus alone when the user put it on body before the failure", async () => {
		const view = render(<FilterPage state="ready" onRetry={vi.fn()} />);
		screen.getByRole("textbox", { name: "搜索" }).focus();
		fireEvent.pointerDown(document.body);
		screen.getByRole("textbox", { name: "搜索" }).blur();
		view.rerender(<FilterPage state="failed" onRetry={vi.fn()} />);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(document.activeElement).toBe(document.body);
	});

	it("leaves a focused retry alone when the user's own key press removes it", async () => {
		const view = render(<Page state="failed" onRetry={vi.fn()} />);
		retry().focus();
		// 例如在弹窗里的「重新读取」上按 Escape 关闭弹窗：卸载是用户操作的结果，焦点去处由弹窗决定。
		fireEvent.keyDown(retry(), { key: "Escape" });
		view.rerender(<Page state="loading" onRetry={vi.fn()} />);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(document.activeElement).toBe(document.body);
		view.rerender(<Page state="ready" onRetry={vi.fn()} />);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(document.activeElement).toBe(document.body);
	});

	it("hands a background recovery to the h1 without scrolling", () => {
		const view = render(<Page state="failed" onRetry={vi.fn()} />);
		retry().focus();
		const focus = vi.spyOn(HTMLElement.prototype, "focus");
		view.rerender(<Page state="loading" onRetry={vi.fn()} />);
		expect(document.activeElement).toBe(heading());
		expect(focus).toHaveBeenCalledWith({ preventScroll: true });
		expect(focus).not.toHaveBeenCalledWith({ preventScroll: false });
		focus.mockRestore();
	});

	it("reports focus lost from a control that became disabled", () => {
		const view = render(
			<>
				<button type="button">下一页</button>
				<button type="button">上一页</button>
			</>,
		);
		const next = screen.getByRole("button", { name: "下一页" });
		next.focus();
		expect(focusLostFrom(next)).toBe(false);
		// 浏览器稍后才把焦点从变为禁用的按钮上移走：焦点仍在它上面时同样算丢失。
		view.rerender(
			<>
				<button type="button" disabled>
					下一页
				</button>
				<button type="button">上一页</button>
			</>,
		);
		expect(document.activeElement).toBe(next);
		expect(focusLostFrom(next)).toBe(true);
		// 焦点修正后落到 body（不触发新的 focusin），仍算从它上面丢失。
		next.blur();
		expect(focusLostFrom(next)).toBe(true);
		expect(focusLostFrom(null)).toBe(false);
		// 用户把焦点移到别的控件：不是丢失。
		screen.getByRole("button", { name: "上一页" }).focus();
		expect(focusLostFrom(next)).toBe(false);
	});
});
