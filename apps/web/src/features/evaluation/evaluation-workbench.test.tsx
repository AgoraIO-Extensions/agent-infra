import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EvaluationWorkbench } from "./evaluation-workbench.js";

describe("EvaluationWorkbench", () => {
	afterEach(cleanup);

	it("shows the explicit pending contract state without inventing results", () => {
		render(
			<EvaluationWorkbench userDisplayName="Ada" isAdministrator={false} />,
		);

		expect(
			screen.getByRole("heading", { name: "用证据比较 Agent 效果。" }),
		).toBeTruthy();
		expect(screen.getByText("评测 API 尚未接入")).toBeTruthy();
		expect(
			screen.getByText(
				"Ada 的评测材料、实验和线上反馈将在同一处汇总；正文、凭证和思考不会进入评测摘要。",
			),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "创建实验" }).hasAttribute("disabled"),
		).toBe(true);
	});

	it("switches sections and keeps creation disabled until the contract exists", async () => {
		render(<EvaluationWorkbench userDisplayName="" isAdministrator />);
		fireEvent.click(screen.getAllByRole("button", { name: "线上反馈" })[0]);

		expect(
			screen.getByRole("heading", { name: "把用户反馈与离线评分分开看。" }),
		).toBeTruthy();
		expect(
			screen
				.getByRole("button", { name: "创建线上反馈" })
				.hasAttribute("disabled"),
		).toBe(true);
		expect(screen.getByText("管理员视图")).toBeTruthy();
	});
});
