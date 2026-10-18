import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderWithMyAgentsRouter } from "../my-agents/test-router.js";
import { EvaluationWorkbench } from "./evaluation-workbench.js";

describe("EvaluationWorkbench", () => {
	afterEach(cleanup);

	it("follows the design heading and notice without inventing results", async () => {
		await renderWithMyAgentsRouter(<EvaluationWorkbench />);

		expect(
			screen.getByRole("heading", { level: 1, name: "评测" }),
		).toBeTruthy();
		expect(
			screen.getByText(
				"按固定数据集比较模型或 Agent 配置，保留逐例结果和人工复核。",
			),
		).toBeTruthy();
		// R-03：主操作在页头；评测集写入接口未接入，按钮不可用并由说明解释原因。
		const create = screen.getByRole("button", { name: "创建评测集" });
		expect(create.hasAttribute("disabled")).toBe(true);
		const note = document.getElementById(
			create.getAttribute("aria-describedby") ?? "",
		);
		expect(note?.textContent).toContain("尚未接入");
		expect(screen.getByText("评测使用独立授权")).toBeTruthy();
		// 设计没有视图标签，也不显示示例数据。
		expect(screen.queryByText("管理员视图")).toBeNull();
		expect(screen.queryByText("个人视图")).toBeNull();
		expect(screen.queryByText("支持场景回归集")).toBeNull();
	});

	it("keeps the segments inside the card in design order with their own empty states", async () => {
		await renderWithMyAgentsRouter(<EvaluationWorkbench />);

		const tabs = screen.getAllByRole("tab");
		expect(tabs.map((tab) => tab.textContent)).toEqual([
			"评测集",
			"实验",
			"反馈",
		]);
		expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
		expect(screen.getByRole("tabpanel").textContent).toContain("还没有评测集");

		fireEvent.click(screen.getByRole("tab", { name: "实验" }));
		expect(screen.getByRole("tabpanel").textContent).toContain("还没有实验");

		fireEvent.click(screen.getByRole("tab", { name: "反馈" }));
		const panel = screen.getByRole("tabpanel");
		expect(panel.textContent).toContain("还没有主动反馈");
		expect(
			screen.getByRole("link", { name: "查看对话反馈" }).getAttribute("href"),
		).toBe("/agents?mode=conversation");
	});
});
