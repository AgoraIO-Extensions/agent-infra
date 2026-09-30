import {
	AgentApplicationProjectionV2Schema,
	AgentProjectionV2Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AgentApplicationProjectionV2,
	AgentProjectionV2,
} from "../../pilot/generated-v2/types.gen.js";
import { pendingApplication } from "../my-agents/test-fixtures.js";
import { WorkspaceOwnerAttention } from "./workspace-owner-attention.js";

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		className,
		params,
		to,
	}: {
		children: ReactNode;
		className?: string;
		params?: Record<string, string>;
		to: string;
	}) => {
		let href = to;
		for (const [key, value] of Object.entries(params ?? {}))
			href = href.replace(`$${key}`, encodeURIComponent(value));
		return (
			<a className={className} href={href}>
				{children}
			</a>
		);
	},
}));

afterEach(cleanup);

const failedAgent: AgentProjectionV2 = AgentProjectionV2Schema.parse({
	...pilotFakeScenariosV2.starting.response.body,
	agentId: "agent-failed",
	name: "仓库分析助手",
	managementStatus: "creation_failed",
	serviceAvailability: "unavailable",
});

const rejectedApplication: AgentApplicationProjectionV2 =
	AgentApplicationProjectionV2Schema.parse({
		...pendingApplication,
		applicationId: "application-rejected",
		name: "代码迁移助手",
		status: "rejected",
		decision: {
			decidedAt: "2026-09-30T08:00:00Z",
			reason: "请缩小可用组织范围，修改后可以重新提交。",
		},
	});

describe("WorkspaceOwnerAttention", () => {
	it("renders the two actionable cards with their official target routes", () => {
		render(
			<WorkspaceOwnerAttention
				ownedAgents={{ kind: "ready", agents: [failedAgent] }}
				applications={{
					kind: "ready",
					applications: [rejectedApplication, pendingApplication],
				}}
			/>,
		);

		expect(screen.getByRole("heading", { name: "需要你处理" })).toBeTruthy();
		expect(screen.getByRole("heading", { name: "代码迁移助手" })).toBeTruthy();
		expect(screen.getByRole("heading", { name: "仓库分析助手" })).toBeTruthy();
		expect(screen.getByText("已驳回")).toBeTruthy();
		expect(screen.getByText("创建失败")).toBeTruthy();
		expect(
			screen.getByText("请缩小可用组织范围，修改后可以重新提交。"),
		).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "查看原因并修改" }).getAttribute("href"),
		).toBe("/my-agents/application-rejected");
		expect(
			screen.getByRole("link", { name: "查看状态并重试" }).getAttribute("href"),
		).toBe("/agents/agent-failed/configuration");
		expect(
			screen.getByRole("link", { name: "创建 Agent" }).getAttribute("href"),
		).toBe("/my-agents/new");
		expect(screen.queryByText(pendingApplication.name)).toBeNull();
		expect(screen.queryByText(/超时|资源准备未完成|镜像校验/)).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("hides Owner attention when an employee has no owned Agents or rejected applications", () => {
		render(
			<WorkspaceOwnerAttention
				ownedAgents={{ kind: "ready", agents: [] }}
				applications={{ kind: "ready", applications: [pendingApplication] }}
			/>,
		);

		expect(screen.queryByRole("region", { name: "需要你处理" })).toBeNull();
		expect(screen.queryByRole("link", { name: "创建 Agent" })).toBeNull();
	});

	it("shows a healthy Owner's empty state after both sources are ready", () => {
		const healthyAgent = AgentProjectionV2Schema.parse({
			...failedAgent,
			managementStatus: "available",
			serviceAvailability: "ready",
		});
		render(
			<WorkspaceOwnerAttention
				ownedAgents={{ kind: "ready", agents: [healthyAgent] }}
				applications={{ kind: "ready", applications: [] }}
			/>,
		);

		expect(screen.getByRole("region", { name: "需要你处理" })).toBeTruthy();
		expect(screen.getByText("当前没有需要你处理的事项。")).toBeTruthy();
		expect(screen.queryByRole("list", { name: "Owner 待办" })).toBeNull();
	});

	it.each(["pending_approval", "creation_failed"] as const)(
		"does not infer an owned Agent from an application with a reserved Agent ID (%s)",
		(status) => {
			const application = AgentApplicationProjectionV2Schema.parse({
				...pendingApplication,
				agentId: "reserved-agent",
				status,
			});
			render(
				<WorkspaceOwnerAttention
					ownedAgents={{ kind: "ready", agents: [] }}
					applications={{ kind: "ready", applications: [application] }}
				/>,
			);

			expect(screen.queryByRole("region", { name: "需要你处理" })).toBeNull();
			expect(screen.queryByRole("link", { name: "查看状态并重试" })).toBeNull();
		},
	);

	it("keeps a rejected application with a reserved Agent ID linked to the application", () => {
		render(
			<WorkspaceOwnerAttention
				ownedAgents={{ kind: "ready", agents: [] }}
				applications={{
					kind: "ready",
					applications: [{ ...rejectedApplication, agentId: "reserved-agent" }],
				}}
			/>,
		);

		expect(
			screen.getByRole("link", { name: "查看原因并修改" }).getAttribute("href"),
		).toBe("/my-agents/application-rejected");
		expect(screen.queryByRole("link", { name: "查看状态并重试" })).toBeNull();
	});

	it.each([
		null,
		{ decidedAt: "2026-09-30T08:00:00Z", reason: null },
	] satisfies AgentApplicationProjectionV2["decision"][])(
		"explains that a rejection reason is unavailable without inventing one (%j)",
		(decision) => {
			render(
				<WorkspaceOwnerAttention
					ownedAgents={{ kind: "ready", agents: [] }}
					applications={{
						kind: "ready",
						applications: [{ ...rejectedApplication, decision }],
					}}
				/>,
			);

			expect(
				screen.getByText(
					"申请已被驳回，暂未提供具体原因。请查看申请并修改后重新提交。",
				),
			).toBeTruthy();
			expect(screen.queryByText(/缩小可用组织范围|资源准备未完成/)).toBeNull();
		},
	);

	it("shows independent loading feedback without reporting no pending work", () => {
		render(
			<WorkspaceOwnerAttention
				ownedAgents={{ kind: "loading" }}
				applications={{ kind: "loading" }}
			/>,
		);

		expect(screen.getAllByRole("status")).toHaveLength(2);
		expect(screen.getByText("正在读取待办 Agent…")).toBeTruthy();
		expect(screen.getByText("正在读取申请待办…")).toBeTruthy();
		expect(screen.queryByText("当前没有需要你处理的事项。")).toBeNull();
		expect(screen.queryByRole("list", { name: "Owner 待办" })).toBeNull();
	});

	it("renders the ready source while the other source is still loading", () => {
		const { rerender } = render(
			<WorkspaceOwnerAttention
				ownedAgents={{ kind: "loading" }}
				applications={{ kind: "ready", applications: [rejectedApplication] }}
			/>,
		);

		expect(
			screen.getByRole("heading", { name: rejectedApplication.name }),
		).toBeTruthy();
		expect(screen.getByText("正在读取待办 Agent…")).toBeTruthy();
		expect(screen.queryByText("当前没有需要你处理的事项。")).toBeNull();

		rerender(
			<WorkspaceOwnerAttention
				ownedAgents={{ kind: "ready", agents: [failedAgent] }}
				applications={{ kind: "loading" }}
			/>,
		);
		expect(
			screen.getByRole("heading", { name: failedAgent.name }),
		).toBeTruthy();
		expect(screen.getByText("正在读取申请待办…")).toBeTruthy();
		expect(
			screen.queryByRole("heading", { name: rejectedApplication.name }),
		).toBeNull();
		expect(screen.queryByText("当前没有需要你处理的事项。")).toBeNull();
	});

	it("retries each source independently and disables both buttons while retrying", () => {
		const retryOwnedAgents = vi.fn();
		const retryApplications = vi.fn();
		const { rerender } = render(
			<WorkspaceOwnerAttention
				ownedAgents={{ kind: "unavailable", retryable: true }}
				applications={{ kind: "unavailable", retryable: true }}
				onRetryOwnedAgents={retryOwnedAgents}
				onRetryApplications={retryApplications}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "重新加载待办 Agent" }));
		expect(retryOwnedAgents).toHaveBeenCalledTimes(1);
		expect(retryApplications).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "重新加载申请待办" }));
		expect(retryApplications).toHaveBeenCalledTimes(1);
		expect(screen.queryByText("当前没有需要你处理的事项。")).toBeNull();

		rerender(
			<WorkspaceOwnerAttention
				ownedAgents={{ kind: "unavailable", retryable: true }}
				applications={{ kind: "unavailable", retryable: true }}
				onRetryOwnedAgents={retryOwnedAgents}
				onRetryApplications={retryApplications}
				retryingOwnedAgents
				retryingApplications
			/>,
		);
		const ownedRetry = screen.getByRole("button", {
			name: "正在重新加载待办 Agent…",
		});
		const applicationRetry = screen.getByRole("button", {
			name: "正在重新加载申请待办…",
		});
		expect(ownedRetry.hasAttribute("disabled")).toBe(true);
		expect(applicationRetry.hasAttribute("disabled")).toBe(true);
		fireEvent.click(ownedRetry);
		fireEvent.click(applicationRetry);
		expect(retryOwnedAgents).toHaveBeenCalledTimes(1);
		expect(retryApplications).toHaveBeenCalledTimes(1);
	});

	it("removes old cards after access is rejected and hides retries for non-retryable failures", () => {
		const retryOwnedAgents = vi.fn();
		const retryApplications = vi.fn();
		const { rerender } = render(
			<WorkspaceOwnerAttention
				ownedAgents={{ kind: "ready", agents: [failedAgent] }}
				applications={{ kind: "ready", applications: [rejectedApplication] }}
			/>,
		);

		rerender(
			<WorkspaceOwnerAttention
				ownedAgents={{ kind: "unavailable", retryable: false }}
				applications={{ kind: "unavailable", retryable: false }}
				onRetryOwnedAgents={retryOwnedAgents}
				onRetryApplications={retryApplications}
			/>,
		);
		expect(screen.getAllByRole("alert")).toHaveLength(2);
		expect(
			screen.queryByRole("heading", { name: failedAgent.name }),
		).toBeNull();
		expect(
			screen.queryByRole("heading", { name: rejectedApplication.name }),
		).toBeNull();
		expect(screen.queryByRole("link", { name: "查看状态并重试" })).toBeNull();
		expect(screen.queryByRole("link", { name: "查看原因并修改" })).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
		expect(screen.queryByText("当前没有需要你处理的事项。")).toBeNull();
		expect(retryOwnedAgents).not.toHaveBeenCalled();
		expect(retryApplications).not.toHaveBeenCalled();
	});
});
