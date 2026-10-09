import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserGuide } from "./user-guide";

beforeEach(() => {
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
		configurable: true,
		value: vi.fn(),
	});
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});
function Guide({ initial = "01" }: { initial?: string }) {
	const [chapter, setChapter] = useState(initial);
	return <UserGuide chapter={chapter} onChapterChange={setChapter} />;
}

describe("user guide", () => {
	it("shows the selected handbook chapter with a complete download", () => {
		render(<Guide initial="07" />);
		expect(
			screen.getByRole("heading", { name: "模型与 Relay Key" }),
		).toBeTruthy();
		expect(screen.getByRole("article").textContent).toContain("个人 Key 缺失");
		expect(
			screen.getByRole("link", { name: "完整说明书" }).getAttribute("download"),
		).toBe("Agent-Infra-使用说明书.md");
		expect(screen.queryByRole("button", { name: "下一种设计" })).toBeNull();
	});
	it("finds a term inside the real manual and opens that chapter", () => {
		render(<Guide />);
		fireEvent.change(screen.getByRole("textbox", { name: "搜索使用说明" }), {
			target: { value: "uncertain" },
		});
		const results = screen.getByRole("region", { name: "搜索结果" });
		const result = within(results).getByRole("button", {
			name: /外部写入与结果未知/,
		});
		expect(result.textContent).toContain("UNCERTAIN");
		fireEvent.click(result);
		expect(screen.getByRole("heading", { name: "外部写入与结果未知" })).toBe(
			document.activeElement,
		);
		expect(screen.queryByRole("region", { name: "搜索结果" })).toBeNull();
	});
	it("recovers from no results without changing the selected chapter", () => {
		render(<Guide initial="07" />);
		const input = screen.getByRole("textbox", { name: "搜索使用说明" });
		fireEvent.change(input, { target: { value: "qzx-no-user-guide-topic" } });
		expect(screen.getByRole("status").textContent).toContain("找到 0 个章节");
		fireEvent.keyDown(input, { key: "ArrowRight" });
		expect(screen.getByRole("status").textContent).toContain("找到 0 个章节");
		fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
		expect(
			screen.getByRole("heading", { name: "模型与 Relay Key" }),
		).toBeTruthy();
	});
	it("moves between chapters while keeping the first and last boundaries", () => {
		render(<Guide initial="15" />);
		expect(
			screen.getByRole("button", { name: "下一节" }).hasAttribute("disabled"),
		).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "上一节" }));
		expect(
			screen.getByRole("heading", { name: "常见问题与处理顺序" }),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /先了解两个入口/ }));
		expect(
			screen.getByRole("button", { name: "上一节" }).hasAttribute("disabled"),
		).toBe(true);
	});
});
