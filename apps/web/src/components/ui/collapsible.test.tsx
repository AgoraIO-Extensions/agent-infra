import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "./collapsible.js";

function Counter() {
	const [count, setCount] = useState(0);
	return (
		<button type="button" onClick={() => setCount((value) => value + 1)}>
			已点击 {count} 次
		</button>
	);
}

describe("Collapsible", () => {
	it("keeps the panel content mounted while collapsed so its state survives", () => {
		render(
			<Collapsible>
				<CollapsibleTrigger aria-controls="panel">
					会话上下文
				</CollapsibleTrigger>
				<CollapsiblePanel id="panel">
					<Counter />
				</CollapsiblePanel>
			</Collapsible>,
		);
		const trigger = screen.getByRole("button", { name: "会话上下文" });
		const panel = document.getElementById("panel");
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(panel).not.toBeNull();
		expect(panel?.hidden).toBe(true);

		fireEvent.click(trigger);
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(panel?.hidden).toBe(false);
		fireEvent.click(screen.getByRole("button", { name: "已点击 0 次" }));

		fireEvent.click(trigger);
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		// 收起后面板仍在 DOM 中，aria-controls 指向的元素始终存在。
		expect(
			document.getElementById(trigger.getAttribute("aria-controls") ?? ""),
		).toBe(panel);
		fireEvent.click(trigger);
		expect(screen.getByRole("button", { name: "已点击 1 次" })).toBeTruthy();
	});

	it("follows a controlled open state", () => {
		const { rerender } = render(
			<Collapsible open={false}>
				<CollapsibleTrigger>文件</CollapsibleTrigger>
				<CollapsiblePanel data-testid="panel">内容</CollapsiblePanel>
			</Collapsible>,
		);
		expect(screen.getByTestId("panel").hidden).toBe(true);
		rerender(
			<Collapsible open>
				<CollapsibleTrigger>文件</CollapsibleTrigger>
				<CollapsiblePanel data-testid="panel">内容</CollapsiblePanel>
			</Collapsible>,
		);
		expect(screen.getByTestId("panel").hidden).toBe(false);
		expect(
			screen
				.getByRole("button", { name: "文件" })
				.getAttribute("aria-expanded"),
		).toBe("true");
	});
});
