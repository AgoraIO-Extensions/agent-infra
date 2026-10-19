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
