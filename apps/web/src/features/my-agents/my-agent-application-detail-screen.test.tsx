import { AgentApplicationProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MyAgentApplicationDetailScreen } from "./my-agent-application-detail-screen.js";
import { pendingApplication } from "./test-fixtures.js";
import { renderWithMyAgentsRouter } from "./test-router.js";

describe("MyAgentApplicationDetailScreen", () => {
	it.each([
		["pending_approval", false],
		["rejected", false],
		["withdrawn", false],
		["creating", true],
		["available", true],
		["stopped", true],
		["creation_failed", true],
		["disabled", true],
	] as const)(
		"shows an Agent entrance only after creation has begun (%s)",
		async (status, hasAgentEntrance) => {
			const application = AgentApplicationProjectionV2Schema.parse({
				...pendingApplication,
				agentId: "agent-reserved-before-approval",
				status,
			});
			await renderWithMyAgentsRouter(
				<MyAgentApplicationDetailScreen
					onWithdraw={vi.fn()}
					state={{ kind: "ready", application }}
					withdrawing={false}
				/>,
			);

			const link = screen.queryByRole("link", { name: "查看 Agent" });
			if (hasAgentEntrance) {
				expect(link?.getAttribute("href")).toBe(
					"/agents/agent-reserved-before-approval",
				);
			} else {
				expect(link).toBeNull();
			}
			expect(screen.getByRole("link", { name: "返回我的 Agent" })).toBeTruthy();
		},
	);

	it("renders a pending projection and lets the applicant withdraw it", async () => {
		const onWithdraw = vi.fn();
		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={onWithdraw}
				state={{ kind: "ready", application: pendingApplication }}
				withdrawing={false}
			/>,
		);

		expect(
			screen.getByRole("heading", { name: "Release assistant request" }),
		).toBeTruthy();
		expect(screen.getByText("待审批")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "返回我的 Agent" }).getAttribute("href"),
		).toBe("/my-agents");
		expect(
			screen.getByRole("link", { name: "修改申请" }).getAttribute("href"),
		).toBe("/my-agents/application%3Atenant%2F01%3Fdraft%23one%25/edit");
		expect(screen.queryByRole("link", { name: "查看 Agent" })).toBeNull();
		expect(screen.queryByText("MODEL_API_KEY")).toBeNull();
		expect(screen.queryByText("Owner settings")).toBeNull();
		expect(screen.queryByText("Approve application")).toBeNull();
		const withdraw = screen.getByRole("button", { name: "撤回申请" });
		fireEvent.click(withdraw);
		expect(screen.getByRole("dialog", { name: "撤回这项申请？" })).toBeTruthy();
		expect(onWithdraw).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "继续保留申请" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(withdraw));
		expect(onWithdraw).not.toHaveBeenCalled();
		fireEvent.click(withdraw);
		fireEvent.click(screen.getByRole("button", { name: "确认撤回" }));
		expect(onWithdraw).toHaveBeenCalledOnce();
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("renders a rejected application history without lifecycle controls", async () => {
		const rejectedApplication = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			applicationId: "application-pilot-rejected",
			status: "rejected",
			decision: {
				decidedAt: "2026-09-03T09:00:00Z",
				reason: "Resource capacity is currently unavailable.",
			},
		});
		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={vi.fn()}
				state={{ kind: "ready", application: rejectedApplication }}
				withdrawing={false}
			/>,
		);

		expect(screen.getByText("已驳回")).toBeTruthy();
		expect(screen.getByText("审批原因：")).toBeTruthy();
		expect(
			screen.getByText("Resource capacity is currently unavailable."),
		).toBeTruthy();
		expect(screen.getByText(/提交于/)).toBeTruthy();
		expect(screen.getByText("2026-09-03T08:00:00Z").tagName).toBe("TIME");
		expect(screen.getByText("2026-09-03T09:00:00Z").tagName).toBe("TIME");
		expect(screen.queryByRole("button", { name: "撤回申请" })).toBeNull();
		expect(
			screen.getByRole("link", { name: "修改并重新提交" }).getAttribute("href"),
		).toBe("/my-agents/application-pilot-rejected/edit");
		expect(screen.queryByText(/owner settings/i)).toBeNull();
	});

	it("renders an approved decision history without inventing a rejection reason", async () => {
		const approvedApplication = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			applicationId: "application-pilot-approved",
			agentId: "agent-pilot-approved",
			status: "creating",
			decision: {
				decidedAt: "2026-09-03T10:00:00Z",
				reason: null,
			},
		});
		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={vi.fn()}
				state={{ kind: "ready", application: approvedApplication }}
				withdrawing={false}
			/>,
		);

		expect(screen.getByText("创建中")).toBeTruthy();
		expect(screen.getByText("审批时间")).toBeTruthy();
		expect(screen.getByText("2026-09-03T10:00:00Z").tagName).toBe("TIME");
		expect(screen.queryByText("审批原因：")).toBeNull();
	});

	it("keeps unavailable details opaque and does not direct a withdrawal error to retry", async () => {
		const unavailable = await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={vi.fn()}
				state={{ kind: "unavailable", retryable: false }}
				withdrawing={false}
			/>,
		);

		expect(screen.getByRole("alert").textContent).toBe("当前无法查看此申请。");
		expect(screen.queryByText("Release assistant request")).toBeNull();
		expect(screen.queryByRole("button", { name: "撤回申请" })).toBeNull();
		unavailable.unmount();

		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={vi.fn()}
				state={{ kind: "ready", application: pendingApplication }}
				withdrawalError
				withdrawing={false}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"暂未确认撤回结果，请先查看申请的最新状态。",
		);
		expect(screen.queryByText(/try again/i)).toBeNull();
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "撤回申请" }),
		);
	});

	it("renders a retryable detail failure without a stale application", async () => {
		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={vi.fn()}
				state={{ kind: "unavailable", retryable: true }}
				withdrawing={false}
			/>,
		);

		expect(screen.getByRole("alert").textContent).toBe(
			"暂时无法读取申请，请稍后重试。",
		);
		expect(screen.queryByText("Release assistant request")).toBeNull();
	});

	it("prevents another withdrawal while its request is pending", async () => {
		const onWithdraw = vi.fn();
		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={onWithdraw}
				state={{ kind: "ready", application: pendingApplication }}
				withdrawing
			/>,
		);
		const button = screen.getByRole("button", { name: "正在撤回…" });
		expect(button.hasAttribute("disabled")).toBe(true);
		fireEvent.click(button);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(onWithdraw).not.toHaveBeenCalled();
	});

	it("shows a withdrawn application as read-only history and focuses the projected result", async () => {
		const withdrawn = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			status: "withdrawn",
		});
		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={vi.fn()}
				state={{ kind: "ready", application: withdrawn }}
				withdrawing={false}
				withdrawalResult={withdrawn}
			/>,
		);
		expect(
			screen.getByText("此记录为只读历史。再次申请请从“我的 Agent”新建。"),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "撤回申请" })).toBeNull();
		expect(screen.queryByRole("link", { name: "修改申请" })).toBeNull();
		const result = screen.getByRole("status");
		expect(result.textContent).toBe("撤回请求已提交：已撤回。");
		expect(document.activeElement).toBe(result);
	});

	it("shows the actual purpose, Owners, availability and default model without Secret fields", async () => {
		const application = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			configuration: {
				...pendingApplication.configuration,
				availability: [
					{ kind: "user", userId: "user-release-2" },
					{ kind: "organization", organizationId: "org-platform" },
				],
				modelOptions: [
					{
						optionId: "model-primary",
						displayName: "Release model",
						modelId: "release-model-v1",
						reasoningLevels: ["medium", "high"],
					},
				],
				defaultModelOptionId: "model-primary",
				defaultReasoningLevel: "high",
				secrets: [{ name: "MODEL_API_KEY", isSet: true, version: 2 }],
			},
		});
		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={vi.fn()}
				state={{ kind: "ready", application }}
				withdrawing={false}
			/>,
		);
		expect(screen.getByText(application.description)).toBeTruthy();
		expect(screen.getByText("Applicant")).toBeTruthy();
		expect(screen.getByText("用户 user-release-2")).toBeTruthy();
		expect(screen.getByText("组织 org-platform")).toBeTruthy();
		expect(
			screen.getByText("Release model · release-model-v1 · medium、high"),
		).toBeTruthy();
		expect(screen.getByText("默认模型").nextElementSibling?.textContent).toBe(
			"Release model",
		);
		expect(
			screen.getByText("默认推理档位").nextElementSibling?.textContent,
		).toBe("high");
		expect(screen.getByText("Small")).toBeTruthy();
		expect(screen.queryByText("MODEL_API_KEY")).toBeNull();
		expect(screen.queryByRole("textbox")).toBeNull();
	});
});
