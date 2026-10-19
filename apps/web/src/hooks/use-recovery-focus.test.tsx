import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { armBefore, useRecoveryFocus } from "./use-recovery-focus.js";

afterEach(cleanup);

// 失败时显示「重新加载」按钮，恢复后按钮卸载、只剩标题与内容。
function Page({
	unsettled,
	onRetry,
	other = false,
}: {
	unsettled: number;
	onRetry: () => void;
	other?: boolean;
}) {
	const recovery = useRecoveryFocus(unsettled);
	return (
		<>
			<h1 ref={recovery.ref} tabIndex={-1}>
				页面标题
			</h1>
			{other ? <button type="button">另一个按钮</button> : null}
			{unsettled ? (
				<button type="button" onClick={armBefore(recovery.arm, onRetry)}>
					重新加载
				</button>
			) : (
				<p>内容</p>
			)}
		</>
	);
}

describe("useRecoveryFocus", () => {
	it("moves focus to the heading after an armed recovery removes the trigger", () => {
		const onRetry = vi.fn();
		const view = render(<Page unsettled={1} onRetry={onRetry} />);
		const retry = screen.getByRole("button", { name: "重新加载" });
		retry.focus();
		fireEvent.click(retry);
		expect(onRetry).toHaveBeenCalledOnce();
		view.rerender(<Page unsettled={0} onRetry={onRetry} />);
		expect(document.activeElement).toBe(
			screen.getByRole("heading", { name: "页面标题" }),
		);
	});

	it("waits through a failed retry and does not move focus without a user retry", () => {
		const onRetry = vi.fn();
		const view = render(<Page unsettled={2} onRetry={onRetry} />);
		// 没有触发恢复：自行恢复时不移动焦点。
		view.rerender(<Page unsettled={0} onRetry={onRetry} />);
		expect(document.activeElement).toBe(document.body);
		view.rerender(<Page unsettled={1} onRetry={onRetry} />);
		fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
		// 恢复失败：未就绪数不变，保持待命。
		view.rerender(<Page unsettled={1} onRetry={onRetry} />);
		expect(document.activeElement).toBe(document.body);
		view.rerender(<Page unsettled={0} onRetry={onRetry} />);
		expect(document.activeElement).toBe(
			screen.getByRole("heading", { name: "页面标题" }),
		);
	});

	it("does not steal focus the user already moved elsewhere", () => {
		const onRetry = vi.fn();
		const view = render(<Page unsettled={1} onRetry={onRetry} other />);
		fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
		const other = screen.getByRole("button", { name: "另一个按钮" });
		other.focus();
		view.rerender(<Page unsettled={0} onRetry={onRetry} other />);
		expect(document.activeElement).toBe(other);
	});

	it("keeps a missing action undefined so no retry control appears", () => {
		expect(armBefore(vi.fn(), undefined)).toBeUndefined();
	});
});
