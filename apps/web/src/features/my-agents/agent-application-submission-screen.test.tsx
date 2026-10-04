import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentApplicationSubmissionScreen as AgentApplicationSubmissionScreenView } from "./agent-application-submission-screen.js";
import {
	deploymentConfiguration,
	pendingApplication,
} from "./test-fixtures.js";
import { renderWithMyAgentsRouter } from "./test-router.js";

const rejectedApplication = {
	...pendingApplication,
	status: "rejected" as const,
	decision: {
		decidedAt: "2026-09-07T00:00:00Z",
		reason: "Capacity is unavailable",
	},
};

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

function creationHeader() {
	const header = screen.getByRole("heading", { level: 1 }).closest("header");
	if (!header) throw new Error("Missing creation header");
	return within(header);
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

		expect(screen.getByRole("heading", { name: "申请已提交" })).toBeTruthy();
		expect(screen.getByRole("status").textContent).toBe("申请已提交：待审批。");
		expect(
			screen.getByRole("link", { name: "查看申请详情" }).getAttribute("href"),
		).toBe("/my-agents/application%3Atenant%2F01%3Fdraft%23one%25");
		expect(screen.queryByRole("button", { name: "提交申请" })).toBeNull();
		expect(screen.queryByText("MODEL_API_KEY")).toBeNull();
		expect(
			creationHeader()
				.getByRole("link", { name: "退出创建" })
				.getAttribute("href"),
		).toBe("/my-agents");
		expect(screen.getAllByRole("link", { name: "退出创建" })).toHaveLength(1);
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
		expect(
			creationHeader()
				.getByRole("link", { name: "退出创建" })
				.getAttribute("href"),
		).toBe("/my-agents");
		first.unmount();

		const second = await renderWithMyAgentsRouter(
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
		expect(
			creationHeader()
				.getByRole("link", { name: "退出创建" })
				.getAttribute("href"),
		).toBe("/my-agents");
		second.unmount();

		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				error={Object.assign(new Error("invalid request"), {
					code: "INVALID_REQUEST",
					retryable: false,
				})}
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"申请内容未通过服务端校验，请检查字段后重试。",
		);
		expect(
			creationHeader()
				.getByRole("link", { name: "退出创建" })
				.getAttribute("href"),
		).toBe("/my-agents");
	});

	it("offers matching header and footer exits and leaves without submitting", async () => {
		const onSubmit = vi.fn();
		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				mode="create"
				onSubmit={onSubmit}
				submitting={false}
			/>,
		);
		const exits = screen.getAllByRole("link", { name: "退出创建" });
		expect(exits).toHaveLength(2);
		for (const exit of exits) {
			expect(exit.getAttribute("href")).toBe("/my-agents");
		}
		expect(screen.queryByRole("link", { name: "取消" })).toBeNull();
		fireEvent.click(creationHeader().getByRole("link", { name: "退出创建" }));
		await waitFor(() => {
			expect(
				screen.queryByRole("heading", { name: "创建一个新的 Agent。" }),
			).toBeNull();
		});
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it.each(["edit", "resubmit"] as const)(
		"keeps the original application cancellation destination for %s",
		async (action) => {
			await renderWithMyAgentsRouter(
				<AgentApplicationSubmissionScreen
					mode="update"
					action={action}
					application={
						action === "resubmit" ? rejectedApplication : pendingApplication
					}
					onSubmit={vi.fn()}
					submitting={false}
				/>,
			);
			expect(
				screen.getByRole("link", { name: "取消" }).getAttribute("href"),
			).toBe("/my-agents/application%3Atenant%2F01%3Fdraft%23one%25");
			expect(screen.queryByText("退出创建")).toBeNull();
		},
	);

	it("disables both creation exits while submission is pending", async () => {
		const onSubmit = vi.fn();
		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				mode="create"
				onSubmit={onSubmit}
				submitting
			/>,
		);
		expect(screen.queryByRole("link", { name: "退出创建" })).toBeNull();
		const exits = screen.getAllByText("退出创建");
		expect(exits).toHaveLength(2);
		for (const exit of exits) {
			expect(exit.getAttribute("aria-disabled")).toBe("true");
			expect(exit.getAttribute("href")).toBeNull();
			expect(exit.tabIndex).toBe(-1);
			fireEvent.click(exit);
		}
		expect(creationHeader().getByText("退出创建")).toBeTruthy();
		expect(onSubmit).not.toHaveBeenCalled();
		expect(
			screen
				.getByRole("button", { name: "正在提交…" })
				.hasAttribute("disabled"),
		).toBe(true);
	});

	it.each(["edit", "resubmit"] as const)(
		"keeps cancellation disabled while %s is pending",
		async (action) => {
			await renderWithMyAgentsRouter(
				<AgentApplicationSubmissionScreen
					mode="update"
					action={action}
					application={
						action === "resubmit" ? rejectedApplication : pendingApplication
					}
					onSubmit={vi.fn()}
					submitting
				/>,
			);
			expect(screen.queryByRole("link", { name: "取消" })).toBeNull();
			expect(screen.getByText("取消").getAttribute("aria-disabled")).toBe(
				"true",
			);
			expect(screen.queryByText("退出创建")).toBeNull();
		},
	);

	it("keeps the update result details without adding a creation exit", async () => {
		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				mode="update"
				action="edit"
				application={pendingApplication}
				onSubmit={vi.fn()}
				result={pendingApplication}
				submitting={false}
			/>,
		);
		expect(screen.getByRole("status").textContent).toBe("申请已提交：待审批。");
		expect(
			screen.getByRole("link", { name: "查看申请详情" }).getAttribute("href"),
		).toBe("/my-agents/application%3Atenant%2F01%3Fdraft%23one%25");
		expect(screen.queryByText("退出创建")).toBeNull();
	});

	it("offers a refresh when only the model catalog is empty", async () => {
		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreenView
				mode="create"
				onRefreshDeploymentConfiguration={vi.fn()}
				onSubmit={vi.fn()}
				refreshingDeploymentConfiguration={false}
				deploymentConfigurationRetryable={true}
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

	it("does not retry when deployment classification is missing", async () => {
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
					status: "unavailable",
					modelCatalog: {
						...deploymentConfiguration.modelCatalog,
						status: "unavailable",
					},
				}}
			/>,
		);

		expect(
			screen.getAllByText("部署选项暂不可用，请联系管理员。").length,
		).toBeGreaterThan(0);
		expect(
			screen.queryByRole("button", { name: "重新加载部署选项" }),
		).toBeNull();
	});
});
