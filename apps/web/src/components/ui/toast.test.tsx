import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./dialog.js";
import { ToastProvider, useToast } from "./toast.js";

let toast: ((message: string) => void) | undefined;

function Capture() {
	const value = useToast();
	useEffect(() => {
		toast = value;
	}, [value]);
	return null;
}

function host() {
	const element = document.querySelector('[data-slot="toast"]');
	if (!(element instanceof HTMLElement)) throw new Error("missing toast host");
	return element;
}

function show(message: string) {
	act(() => toast?.(message));
}

function advance(ms: number) {
	act(() => {
		vi.advanceTimersByTime(ms);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	toast = undefined;
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("Toast", () => {
	it("renders one persistent, empty polite live region", () => {
		render(
			<ToastProvider>
				<Capture />
			</ToastProvider>,
		);
		const element = host();
		expect(element.getAttribute("role")).toBe("status");
		expect(element.getAttribute("aria-live")).toBe("polite");
		expect(element.getAttribute("aria-atomic")).toBe("true");
		expect(element.textContent).toBe("");
		expect(element.dataset.state).toBe("closed");
		expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(1);
		// 不抢焦点：宿主没有 tabindex，也没有可聚焦的后代。
		expect(element.hasAttribute("tabindex")).toBe(false);
		expect(element.querySelector("button, a, [tabindex]")).toBeNull();
		expect(element.className).toContain("pointer-events-none");
	});

	it("shows for 2.6s, exits for 180ms and then clears its text", () => {
		render(
			<ToastProvider>
				<Capture />
			</ToastProvider>,
		);
		show("A");
		expect(host().textContent).toBe("A");
		expect(host().dataset.state).toBe("open");
		advance(2599);
		expect(host().dataset.state).toBe("open");
		advance(1);
		expect(host().dataset.state).toBe("closed");
		expect(host().textContent).toBe("A");
		advance(180);
		expect(host().textContent).toBe("");
	});

	it("ignores an empty message", () => {
		render(
			<ToastProvider>
				<Capture />
			</ToastProvider>,
		);
		show("");
		expect(host().textContent).toBe("");
		expect(host().dataset.state).toBe("closed");
	});

	it("replaces the message and restarts the timer", () => {
		render(
			<ToastProvider>
				<Capture />
			</ToastProvider>,
		);
		show("A");
		advance(2000);
		show("B");
		expect(host().textContent).toBe("B");
		advance(2000);
		expect(host().dataset.state).toBe("open");
		advance(600);
		expect(host().dataset.state).toBe("closed");
		advance(180);
		expect(host().textContent).toBe("");
	});

	it("clears before writing the same message again so it is re-announced", () => {
		render(
			<ToastProvider>
				<Capture />
			</ToastProvider>,
		);
		show("A");
		advance(1000);
		show("A");
		expect(host().textContent).toBe("");
		advance(50);
		expect(host().textContent).toBe("A");
		expect(host().dataset.state).toBe("open");
		advance(2600);
		expect(host().dataset.state).toBe("closed");
	});

	it("keeps timing after the caller unmounts", () => {
		function Caller() {
			const value = useToast();
			useEffect(() => {
				value("已重新发送");
			}, [value]);
			return null;
		}
		function Page() {
			const [visible, setVisible] = useState(true);
			useEffect(() => {
				const timer = window.setTimeout(() => setVisible(false), 100);
				return () => window.clearTimeout(timer);
			}, []);
			return visible ? <Caller /> : null;
		}
		render(
			<ToastProvider>
				<Page />
			</ToastProvider>,
		);
		expect(host().textContent).toBe("已重新发送");
		advance(100);
		expect(host().textContent).toBe("已重新发送");
		advance(2500);
		expect(host().dataset.state).toBe("closed");
		advance(180);
		expect(host().textContent).toBe("");
	});

	it("never moves focus away from the focused control", () => {
		render(
			<ToastProvider>
				<Capture />
				<button type="button">触发</button>
			</ToastProvider>,
		);
		const button = screen.getByRole("button", { name: "触发" });
		act(() => button.focus());
		show("已保存");
		expect(document.activeElement).toBe(button);
		advance(3000);
		expect(document.activeElement).toBe(button);
		expect(document.activeElement).not.toBe(document.body);
	});

	it("stays exposed to assistive technology while a modal dialog is open", () => {
		render(
			<ToastProvider>
				<Capture />
				<Dialog open>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>撤回这条申请？</DialogTitle>
						</DialogHeader>
					</DialogContent>
				</Dialog>
			</ToastProvider>,
		);
		show("已撤回");
		let node: HTMLElement | null = host();
		while (node && node !== document.body) {
			expect(node.getAttribute("aria-hidden")).not.toBe("true");
			expect(node.hasAttribute("inert")).toBe(false);
			node = node.parentElement;
		}
		expect(host().textContent).toBe("已撤回");
	});
});
