import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithMyAgentsRouter } from "../my-agents/test-router.js";
import { EvaluationWorkbench } from "./evaluation-workbench.js";

describe("EvaluationWorkbench", () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("follows the design heading and notice without inventing results", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ schemaVersion: 1, items: [] })),
		);
		await renderWithMyAgentsRouter(<EvaluationWorkbench />);

		expect(
			screen.getByRole("heading", { level: 1, name: "评测" }),
		).toBeTruthy();
		expect(
			screen.getByText(
				"按固定数据集比较模型或 Agent 配置，保留逐例结果和人工复核。",
			),
		).toBeTruthy();
		expect(
			screen
				.getByRole("button", { name: "运行与查看实验" })
				.hasAttribute("disabled"),
		).toBe(false);
		expect(screen.getByText("评测使用独立授权")).toBeTruthy();
		// 设计没有视图标签，也不显示示例数据。
		expect(screen.queryByText("管理员视图")).toBeNull();
		expect(screen.queryByText("个人视图")).toBeNull();
		expect(screen.queryByText("支持场景回归集")).toBeNull();
	});

	it("keeps the segments inside the card in design order with their own empty states", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ schemaVersion: 1, items: [] })),
		);
		await renderWithMyAgentsRouter(<EvaluationWorkbench />);

		const tabs = screen.getAllByRole("tab");
		expect(tabs.map((tab) => tab.textContent)).toEqual([
			"评测集",
			"实验",
			"反馈",
		]);
		expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
		expect(screen.getByRole("tabpanel").textContent).toContain(
			"评测集与用途授权",
		);

		fireEvent.click(screen.getByRole("tab", { name: "实验" }));
		expect(screen.getByRole("tabpanel").textContent).toContain(
			"运行基线与候选",
		);

		fireEvent.click(screen.getByRole("tab", { name: "反馈" }));
		const panel = screen.getByRole("tabpanel");
		expect(panel.textContent).toContain("线上主动反馈");
		expect(screen.getByLabelText("查看范围")).toBeTruthy();
	});
});
