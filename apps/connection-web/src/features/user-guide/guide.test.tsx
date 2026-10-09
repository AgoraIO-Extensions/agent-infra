// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guideChapter, guideText } from "./content";
import { ConnectionGuide } from "./guide";
import { guideLinkParts } from "./links";

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
	return <ConnectionGuide chapter={chapter} onChapterChange={setChapter} />;
}
describe("Connection manual", () => {
	it("links page references and machine guides into separate tabs", () => {
		render(<Guide initial="10" />);
		const article = screen.getByRole("article");
		expect(
			within(article)
				.getByRole("link", { name: "/connection/agent/llms.txt" })
				.getAttribute("href"),
		).toBe("/connection/agent/llms.txt");
		for (const link of screen.getAllByRole("link")) {
			expect(link.getAttribute("target")).toBe("_blank");
			expect(link.getAttribute("rel")).toBe("noopener noreferrer");
		}
		expect(guideLinkParts("/llmsXtxt").some((part) => part.href)).toBe(false);
	});
	it("offers independent page links in search excerpts without nesting links in buttons", () => {
		render(<Guide />);
		fireEvent.change(
			screen.getByRole("textbox", { name: "搜索 Connection 使用说明" }),
			{ target: { value: "/connection/agent/" } },
		);
		const region = screen.getByRole("region", { name: "搜索结果" });
		expect(
			within(region)
				.getAllByRole("link")
				.some((link) => link.getAttribute("href") === "/connection/agent/"),
		).toBe(true);
		expect(region.querySelector("button a")).toBeNull();
	});

	it("uses Connection-branch account semantics rather than Platform setup", () => {
		expect(guideText(guideChapter("08"))).toContain("不重复做 Provider OAuth");
		expect(guideText(guideChapter("09"))).toContain("共享同一个撤销和审计边界");
		render(<Guide />);
		expect(
			screen.getByRole("link", { name: "Codex 安装" }).getAttribute("href"),
		).toBe("/connection/");
		expect(
			screen.getByRole("link", { name: "Agent 接入" }).getAttribute("href"),
		).toBe("/connection/agent/");
		expect(
			screen.getByRole("link", { name: "完整说明书" }).getAttribute("href"),
		).toBe("/connection/help/user-manual.md");
	});
	it("opens a search result and focuses the current chapter too", () => {
		render(<Guide initial="09" />);
		const input = screen.getByRole("textbox", {
			name: "搜索 Connection 使用说明",
		});
		input.focus();
		fireEvent.change(input, { target: { value: "Connection PAT" } });
		const result = within(
			screen.getByRole("region", { name: "搜索结果" }),
		).getByRole("button", { name: /^09\s*Connection PAT/ });
		result.focus();
		fireEvent.click(result);
		expect(
			screen.getByRole("heading", { name: "Connection PAT", level: 2 }),
		).toBe(document.activeElement);
	});
	it("recovers from an empty search and honors chapter boundaries", () => {
		render(<Guide />);
		expect(
			screen.getByRole("button", { name: "上一节" }).hasAttribute("disabled"),
		).toBe(true);
		fireEvent.change(
			screen.getByRole("textbox", { name: "搜索 Connection 使用说明" }),
			{ target: { value: "nonexistent-guide-qzx" } },
		);
		expect(screen.getByRole("status").textContent).toContain("0 个章节");
		fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
		fireEvent.click(screen.getByRole("button", { name: "下一节" }));
		expect(
			screen.getByRole("heading", { name: "控制台与登录", level: 2 }),
		).toBeTruthy();
	});
});
