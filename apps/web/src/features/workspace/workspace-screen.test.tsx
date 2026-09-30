import {
	AgentApplicationProjectionV2Schema,
	AgentProjectionV2Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AgentApplicationProjectionV2,
	AgentProjectionV2,
} from "../../pilot/generated-v2/types.gen.js";
import { pendingApplication } from "../my-agents/test-fixtures.js";
import { WorkspaceScreen } from "./workspace-screen.js";

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		params,
		to,
	}: {
		children: ReactNode;
		params?: Record<string, string>;
		to: string;
	}) => {
		let href = to;
		for (const [key, value] of Object.entries(params ?? {}))
			href = href.replace(`$${key}`, value);
		return <a href={href}>{children}</a>;
	},
}));

afterEach(cleanup);

const agent: AgentProjectionV2 = AgentProjectionV2Schema.parse({
	...pilotFakeScenariosV2.starting.response.body,
	agentId: "agent-codex",
	name: "编程助手",
	description: "可用的代码协作 Agent",
	serviceAvailability: "ready",
});

const application: AgentApplicationProjectionV2 =
	AgentApplicationProjectionV2Schema.parse({
		...pendingApplication,
		applicationId: "application-1",
		name: "客户支持助理",
		description: "待审批的申请",
		status: "pending_approval",
	});

describe("WorkspaceScreen", () => {
	it("renders real discovery and application entry points for an administrator", () => {
		render(
			<WorkspaceScreen
				agents={{ kind: "ready", agents: [agent] }}
				applications={{ kind: "ready", applications: [application] }}
				isAdmin
				onRetryAgents={vi.fn()}
				onRetryApplications={vi.fn()}
				retryingAgents={false}
				retryingApplications={false}
			/>,
		);

		expect(
			screen.getByRole("heading", {
				name: "从可用 Agent 开始今天的工作。",
			}),
		).toBeTruthy();
		expect(screen.getByRole("heading", { name: "编程助手" })).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "开始对话" }).getAttribute("href"),
		).toBe("/agents/agent-codex/conversations");
		expect(
			screen.getByRole("link", { name: "客户支持助理" }).getAttribute("href"),
		).toBe("/my-agents/application-1");
		expect(
			screen.getByRole("link", { name: /Agent 管理/ }).getAttribute("href"),
		).toBe("/admin/agents");
	});

	it("keeps unavailable data actionable and hides administrator work for employees", () => {
		const retryAgents = vi.fn();
		const retryApplications = vi.fn();
		render(
			<WorkspaceScreen
				agents={{ kind: "unavailable", retryable: true }}
				applications={{ kind: "unavailable", retryable: true }}
				isAdmin={false}
				onRetryAgents={retryAgents}
				onRetryApplications={retryApplications}
				retryingAgents={false}
				retryingApplications={false}
			/>,
		);

		expect(screen.getByRole("button", { name: "重新加载 Agent" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "重新加载申请" })).toBeTruthy();
		expect(
			screen.queryByRole("heading", { name: "需要管理员处理" }),
		).toBeNull();
		expect(screen.queryByRole("link", { name: "Agent 管理" })).toBeNull();
	});

	it("does not offer a platform conversation for a ready self-managed Agent", () => {
		const selfManaged = AgentProjectionV2Schema.parse({
			...agent,
			source: {
				kind: "custom",
				imageReference: "registry.example/agents/pilot@sha256:abc",
				interactionMode: "self-managed",
				identityResponsibility: "self-managed",
			},
		});
		render(
			<WorkspaceScreen
				agents={{ kind: "ready", agents: [selfManaged] }}
				applications={{ kind: "ready", applications: [] }}
				isAdmin={false}
			/>,
		);
		expect(screen.queryByRole("link", { name: "开始对话" })).toBeNull();
		expect(screen.getByRole("link", { name: "查看详情" })).toBeTruthy();
	});
});
