import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentApplicationSubmissionScreen as AgentApplicationSubmissionScreenView } from "./agent-application-submission-screen.js";
import {
	deploymentConfiguration,
	pendingApplication,
} from "./test-fixtures.js";
import { renderWithMyAgentsRouter } from "./test-router.js";

type ScreenProps<T> = T extends unknown
	? Omit<
			T,
			| "deploymentConfiguration"
			| "onRefreshDeploymentConfiguration"
			| "refreshingDeploymentConfiguration"
		>
	: never;

function AgentApplicationSubmissionScreen(
	props: ScreenProps<
		Parameters<typeof AgentApplicationSubmissionScreenView>[0]
	>,
) {
	return (
		<AgentApplicationSubmissionScreenView
			{...props}
			deploymentConfiguration={deploymentConfiguration}
			onRefreshDeploymentConfiguration={vi.fn()}
			refreshingDeploymentConfiguration={false}
		/>
	);
}

describe("AgentApplicationSubmissionScreen", () => {
	it("renders a server-projected create result without exposing request values", async () => {
		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				mode="create"
				onSubmit={vi.fn()}
				result={pendingApplication}
				submitting={false}
			/>,
		);

		expect(screen.getByRole("heading", { name: "申请 Agent" })).toBeTruthy();
		expect(screen.getByRole("status").textContent).toBe("申请已提交：待审批。");
		expect(
			screen.getByRole("link", { name: "查看申请详情" }).getAttribute("href"),
		).toBe("/my-agents/application%3Atenant%2F01%3Fdraft%23one%25");
		expect(screen.queryByRole("button", { name: "提交申请" })).toBeNull();
		expect(screen.queryByText("MODEL_API_KEY")).toBeNull();
	});

	it("distinguishes retryable submission errors from changed application state", async () => {
		const first = await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				error={Object.assign(new Error("private transport detail"), {
					retryable: true,
				})}
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"申请提交失败，非敏感内容已保留。请重新填写 Secret 或模型凭证后再提交。",
		);
		expect(screen.queryByText("private transport detail")).toBeNull();
		first.unmount();

		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				error={Object.assign(new Error("private authorization detail"), {
					retryable: false,
				})}
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"申请已变更或当前不可用，请刷新页面后核对。",
		);
	});

	it("offers the correct cancellation destination for initial and updated applications", async () => {
		const initial = await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		expect(
			screen.getByRole("link", { name: "取消" }).getAttribute("href"),
		).toBe("/my-agents");
		initial.unmount();
		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				mode="update"
				action="edit"
				application={pendingApplication}
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		expect(
			screen.getByRole("link", { name: "取消" }).getAttribute("href"),
		).toBe("/my-agents/application%3Atenant%2F01%3Fdraft%23one%25");
	});

	it("disables cancellation while submission is pending", async () => {
		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				mode="create"
				onSubmit={vi.fn()}
				submitting
			/>,
		);
		expect(screen.queryByRole("link", { name: "取消" })).toBeNull();
		expect(screen.getByText("取消").getAttribute("aria-disabled")).toBe("true");
		expect(
			screen
				.getByRole("button", { name: "正在提交…" })
				.hasAttribute("disabled"),
		).toBe(true);
	});

	it("offers a refresh when only the model catalog is empty", async () => {
		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreenView
				mode="create"
				onRefreshDeploymentConfiguration={vi.fn()}
				onSubmit={vi.fn()}
				refreshingDeploymentConfiguration={false}
				result={undefined}
				submitting={false}
				deploymentConfiguration={{
					...deploymentConfiguration,
					modelCatalog: {
						...deploymentConfiguration.modelCatalog,
						status: "empty",
					},
				}}
			/>,
		);

		expect(
			screen.getByRole("button", { name: "重新加载部署选项" }),
		).toBeTruthy();
	});
});
