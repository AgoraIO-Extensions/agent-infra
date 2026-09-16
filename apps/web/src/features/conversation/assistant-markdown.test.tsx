import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantMarkdown } from "./assistant-markdown.js";

afterEach(cleanup);

describe("assistant Markdown", () => {
	it("renders prose, code and GFM tables with keyboard-accessible scroll regions", () => {
		const { container } = render(
			<AssistantMarkdown>
				{
					"## 结果\n\n**完成**，运行 `pnpm test`。\n\n```ts\nconst count = 1;\n```\n\n| 名称 | 状态 |\n| --- | --- |\n| Web | 通过 |\n\n- [x] 检查"
				}
			</AssistantMarkdown>,
		);
		expect(screen.getByRole("heading", { name: "结果" })).toBeTruthy();
		expect(container.querySelector("strong")?.textContent).toBe("完成");
		expect(screen.getByLabelText("代码块").tabIndex).toBe(0);
		expect(container.querySelector("pre code")?.textContent).toBe(
			"const count = 1;\n",
		);
		expect(screen.getByRole("region", { name: "表格" }).tabIndex).toBe(0);
		expect(screen.getByRole("cell", { name: "通过" })).toBeTruthy();
		expect(screen.getByRole<HTMLInputElement>("checkbox").disabled).toBe(true);
	});

	it("keeps HTML inert, removes unsafe or local navigation, and never loads remote images", () => {
		const { container } = render(
			<AssistantMarkdown>
				{
					'<script>alert(1)</script>\n\n<img src="https://tracker.example/pixel" onerror="alert(1)">\n\n[危险](javascript:alert%281%29) [本地](/api/logout) [协议相对](//tracker.example)\n\n![示意图](https://tracker.example/image.png)\n\n[来源](https://example.com/docs)'
				}
			</AssistantMarkdown>,
		);
		expect(container.querySelector("script, img")).toBeNull();
		expect(container.textContent).toContain("<script>alert(1)</script>");
		expect(container.textContent).toContain("[图片：示意图]");
		expect(screen.getAllByRole("link")).toHaveLength(1);
		const link = screen.getByRole<HTMLAnchorElement>("link", { name: "来源" });
		expect(link.href).toBe("https://example.com/docs");
		expect(link.rel).toBe("noopener noreferrer");
	});

	it("renders partial streaming fences and replaces them without duplicating content", () => {
		const { container, rerender } = render(
			<AssistantMarkdown>{"```ts\nconst value"}</AssistantMarkdown>,
		);
		expect(container.querySelector("pre code")?.textContent).toContain(
			"const value",
		);
		rerender(
			<AssistantMarkdown>
				{"```ts\nconst value = 1;\n```\n\n完成"}
			</AssistantMarkdown>,
		);
		expect(container.querySelectorAll("pre")).toHaveLength(1);
		expect(container.querySelector("pre code")?.textContent).toBe(
			"const value = 1;\n",
		);
		expect(screen.getByText("完成")).toBeTruthy();
	});
});
