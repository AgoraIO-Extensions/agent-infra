import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MyAgentsScreen } from "./my-agents-screen.js";
import { creatingApplication, pendingApplication } from "./test-fixtures.js";
import { renderWithMyAgentsRouter } from "./test-router.js";

describe("MyAgentsScreen", () => {
	it("renders projected statuses responsively and links only an emitted Agent ID", async () => {
		await renderWithMyAgentsRouter(
			<MyAgentsScreen
				state={{
					kind: "ready",
					applications: [pendingApplication, creatingApplication],
				}}
			/>,
		);

		const pendingLink = screen.getByRole("link", {
			name: /^Release assistant request/,
		});
		expect(pendingLink.getAttribute("href")).toBe(
			"/my-agents/application%3Atenant%2F01%3Fdraft%23one%25",
		);
		expect(pendingLink.closest("li")?.className).toContain("record-row");
		expect(screen.getByText("待审批")).toBeTruthy();
		expect(screen.getByText("创建中")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "查看 Agent" }).getAttribute("href"),
		).toBe("/agents/agent-pilot-2");
		expect(screen.getAllByRole("link", { name: "查看 Agent" })).toHaveLength(1);
	});

	it("renders an explicit empty current applicant history", async () => {
		await renderWithMyAgentsRouter(
			<MyAgentsScreen state={{ kind: "ready", applications: [] }} />,
		);

		expect(screen.getByText("暂无 Agent 申请")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "申请 Agent" }).getAttribute("href"),
		).toBe("/my-agents/new");
	});

	it("renders an unavailable history without stale or enumerating data", async () => {
		await renderWithMyAgentsRouter(
			<MyAgentsScreen state={{ kind: "unavailable", retryable: false }} />,
		);

		expect(screen.getByRole("alert").textContent).toContain(
			"当前无法查看申请，请联系管理员。",
		);
		expect(screen.queryByText("Release assistant request")).toBeNull();
		expect(screen.queryByText(/forbidden|missing/i)).toBeNull();
	});

	it("renders a retryable current applicant history failure", async () => {
		await renderWithMyAgentsRouter(
			<MyAgentsScreen state={{ kind: "unavailable", retryable: true }} />,
		);

		expect(screen.getByRole("alert").textContent).toBe(
			"暂时无法读取申请，请稍后重试。",
		);
	});

	it("uses keyboard tabs and keeps created Agent ownership independent from applications", async () => {
		await renderWithMyAgentsRouter(
			<MyAgentsScreen
				state={{ kind: "ready", applications: [creatingApplication] }}
				ownedAgents={[]}
			/>,
		);
		const applications = screen.getByRole("tab", {
			name: "申请",
			selected: true,
		});
		const agents = screen.getByRole("tab", {
			name: "已创建 Agent",
			selected: false,
		});
		act(() => applications.focus());
		fireEvent.keyDown(applications, { key: "ArrowRight" });
		await waitFor(() =>
			expect(agents.getAttribute("aria-selected")).toBe("true"),
		);
		expect(document.activeElement).toBe(agents);
		const panel = screen.getByRole("tabpanel", { name: "已创建 Agent" });
		expect(panel.id).toBe(agents.getAttribute("aria-controls"));
		expect(panel.getAttribute("aria-labelledby")).toBe(agents.id);
		expect(screen.getByText("暂无你管理的 Agent")).toBeTruthy();
		expect(screen.queryByText(creatingApplication.name)).toBeNull();
		expect(screen.queryByRole("link", { name: "配置与管理" })).toBeNull();
		fireEvent.keyDown(agents, { key: "Home" });
		await waitFor(() =>
			expect(applications.getAttribute("aria-selected")).toBe("true"),
		);
		expect(screen.getByText(creatingApplication.name)).toBeTruthy();
		fireEvent.keyDown(applications, { key: "End" });
		await waitFor(() =>
			expect(agents.getAttribute("aria-selected")).toBe("true"),
		);
		fireEvent.keyDown(agents, { key: "ArrowLeft" });
		await waitFor(() =>
			expect(applications.getAttribute("aria-selected")).toBe("true"),
		);
	});

	it("shows independently projected owned Agents even with no application history", async () => {
		const owned = AgentProjectionV2Schema.parse(
			pilotFakeScenariosV2.starting.response.body,
		);
		await renderWithMyAgentsRouter(
			<MyAgentsScreen
				state={{ kind: "ready", applications: [] }}
				ownedAgents={[owned]}
			/>,
		);
		fireEvent.click(screen.getByRole("tab", { name: "已创建 Agent" }));
		expect(screen.getByRole("heading", { name: owned.name })).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "配置与管理" }).getAttribute("href"),
		).toBe(`/agents/${owned.agentId}/configuration`);
		expect(screen.queryByRole("link", { name: "申请详情" })).toBeNull();
	});

	it.each([
		[{ ownedAgentsLoading: true }, "正在读取你管理的 Agent…"],
		[
			{ ownedAgentsUnavailable: true },
			"暂时无法读取你管理的 Agent，请稍后重试。",
		],
		[{}, "尚未读取你管理的 Agent。"],
	])(
		"distinguishes unread, loading and unavailable owned projections: %j",
		async (props, message) => {
			await renderWithMyAgentsRouter(
				<MyAgentsScreen
					state={{ kind: "ready", applications: [] }}
					{...props}
				/>,
			);
			fireEvent.click(screen.getByRole("tab", { name: "已创建 Agent" }));
			expect(screen.getByText(message)).toBeTruthy();
			expect(screen.queryByText("暂无你管理的 Agent")).toBeNull();
		},
	);
});

it.each([
	["starting", "启动中"],
	["updating", "更新中"],
	["unavailable", "暂时不可用"],
	["ready", "就绪"],
] as const)(
	"preserves management and service facts for %s",
	async (serviceAvailability, label) => {
		const agent = AgentProjectionV2Schema.parse({
			...pilotFakeScenariosV2.starting.response.body,
			serviceAvailability,
		});
		await renderWithMyAgentsRouter(
			<MyAgentsScreen
				state={{ kind: "ready", applications: [] }}
				ownedAgents={[agent]}
			/>,
		);
		fireEvent.click(screen.getByRole("tab", { name: "已创建 Agent" }));
		expect(screen.getByText("可用")).toBeTruthy();
		expect(screen.getByText(`服务：${label}`)).toBeTruthy();
	},
);
