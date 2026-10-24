import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecoveryButton } from "../features/recovery-button.js";
import { pageRecoveryTarget } from "./use-recovery-focus.js";

afterEach(cleanup);

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
