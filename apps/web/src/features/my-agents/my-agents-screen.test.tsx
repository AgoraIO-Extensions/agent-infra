import {
	AgentApplicationProjectionV2Schema,
	AgentProjectionV2Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import {
	act,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MyAgentsScreen } from "./my-agents-screen.js";
import { creatingApplication, pendingApplication } from "./test-fixtures.js";
import { renderWithMyAgentsRouter } from "./test-router.js";

describe("MyAgentsScreen", () => {
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
				<MyAgentsScreen
					state={{ kind: "ready", applications: [application] }}
				/>,
			);

			const link = screen.queryByRole("link", {
				name: `查看 Agent：${application.name}`,
			});
			if (hasAgentEntrance) {
				expect(link?.getAttribute("href")).toBe(
					"/agents/agent-reserved-before-approval",
				);
			} else {
				expect(link).toBeNull();
			}
			expect(
				screen.getByRole("link", { name: `查看申请：${application.name}` }),
			).toBeTruthy();
		},
	);

	it("renders projected statuses responsively and links only an emitted Agent ID", async () => {
		await renderWithMyAgentsRouter(
			<MyAgentsScreen
				state={{
					kind: "ready",
					applications: [pendingApplication, creatingApplication],
				}}
			/>,
		);

		// 申请名称是标题而非链接（设计稿；N-14 触控目标），申请详情入口是同行的「查看申请」。
		const pendingTitle = screen.getByRole("heading", {
			name: /^Release assistant request/,
		});
		expect(pendingTitle.closest("a")).toBeNull();
		const pendingRow = pendingTitle.closest("li");
		expect(pendingRow?.className).toContain("application-row");
		const pendingLink = within(pendingRow as HTMLElement).getByRole("link", {
			name: `查看申请：${pendingApplication.name}`,
		});
		expect(pendingLink.getAttribute("href")).toBe(
			"/my-agents/application%3Atenant%2F01%3Fdraft%23one%25",
		);
		expect(screen.getByText("待审批")).toBeTruthy();
		expect(screen.getByText("创建中")).toBeTruthy();
		expect(
			screen
				.getByRole("link", { name: `查看 Agent：${creatingApplication.name}` })
				.getAttribute("href"),
		).toBe("/agents/agent-pilot-2");
		expect(screen.getAllByRole("link", { name: /^查看 Agent：/ })).toHaveLength(
			1,
		);
	});

	it("distinguishes custom application entry modes in the application list", async () => {
		const application = AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			source: {
				kind: "custom",
				imageReference: "registry.example/agents/release:v1",
				interactionMode: "platform-adapter",
			},
		});
		await renderWithMyAgentsRouter(
			<MyAgentsScreen state={{ kind: "ready", applications: [application] }} />,
		);

		expect(screen.getByText("自定义 Agent · 平台交互入口")).toBeTruthy();
		expect(screen.queryByText("自定义 Agent", { exact: true })).toBeNull();
	});

	it("renders an explicit empty current applicant history", async () => {
		await renderWithMyAgentsRouter(
			<MyAgentsScreen state={{ kind: "ready", applications: [] }} />,
		);

		expect(screen.getByText("暂无 Agent 申请")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "新建申请" }).getAttribute("href"),
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
			name: "申请 1",
			selected: true,
		});
		const agents = screen.getByRole("tab", {
			name: "已创建",
			selected: false,
		});
		act(() => applications.focus());
		fireEvent.keyDown(applications, { key: "ArrowRight" });
		await waitFor(() =>
			expect(agents.getAttribute("aria-selected")).toBe("true"),
		);
		expect(document.activeElement).toBe(agents);
		const panel = screen.getByRole("tabpanel", { name: "已创建" });
		expect(panel.id).toBe(agents.getAttribute("aria-controls"));
		expect(panel.getAttribute("aria-labelledby")).toBe(agents.id);
		expect(screen.getByText("暂无你管理的 Agent")).toBeTruthy();
		expect(screen.queryByText(creatingApplication.name)).toBeNull();
		expect(screen.queryByRole("link", { name: /^配置与生命周期/ })).toBeNull();
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
		fireEvent.click(screen.getByRole("tab", { name: "已创建" }));
		expect(screen.getByRole("heading", { name: owned.name })).toBeTruthy();
		expect(
			screen
				.getByRole("link", { name: `配置与生命周期：${owned.name}` })
				.getAttribute("href"),
		).toBe(`/agents/${owned.agentId}/configuration`);
		expect(screen.queryByRole("link", { name: /^查看申请/ })).toBeNull();
	});

	it.each([
		[{ ownedAgentsLoading: true }, "正在读取你管理的 Agent…"],
		[
			{ ownedAgentsUnavailable: true, ownedAgentsRetryable: true },
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
			fireEvent.click(screen.getByRole("tab", { name: "已创建" }));
			expect(screen.getByText(message)).toBeTruthy();
			expect(screen.queryByText("暂无你管理的 Agent")).toBeNull();
		},
	);
});

it.each([
	["available", "starting", "启动中", "amber"],
	["available", "updating", "更新中", "amber"],
	["available", "unavailable", "暂时不可用", "red"],
	["available", "ready", "就绪", "green"],
	["stopped", null, "已停止", "gray"],
	["creation_failed", null, "创建失败", "red"],
] as const)(
	"shows a single status chip for %s with service %s",
	async (managementStatus, serviceAvailability, label, tone) => {
		const agent = AgentProjectionV2Schema.parse({
			...pilotFakeScenariosV2.starting.response.body,
			managementStatus,
			serviceAvailability,
		});
		await renderWithMyAgentsRouter(
			<MyAgentsScreen
				state={{ kind: "ready", applications: [] }}
				ownedAgents={[agent]}
			/>,
		);
		fireEvent.click(screen.getByRole("tab", { name: "已创建" }));
		const card = screen
			.getByRole("heading", { name: agent.name })
			.closest("li");
		const chips = (card as HTMLElement).querySelectorAll(
			'.owned-card-heading [data-slot="badge"]',
		);
		expect(chips).toHaveLength(1);
		expect(chips[0]?.textContent).toBe(label);
		expect((chips[0] as HTMLElement).dataset.tone).toBe(tone);
		expect(document.body.textContent).not.toContain("服务：");
	},
);

function applicationsNamed(count: number) {
	return Array.from({ length: count }, (_, index) =>
		AgentApplicationProjectionV2Schema.parse({
			...pendingApplication,
			applicationId: `application-bulk-${index + 1}`,
			name: `批量申请 ${index + 1}`,
		}),
	);
}

describe("MyAgentsScreen design alignment", () => {
	it("counts applications in the 申请 tab only after the read succeeds (M-01)", async () => {
		const view = await renderWithMyAgentsRouter(
			<MyAgentsScreen
				state={{ kind: "ready", applications: applicationsNamed(3) }}
			/>,
		);
		const tab = screen.getByRole("tab", { name: "申请 3", selected: true });
		const chip = tab.querySelector('[data-slot="badge"]') as HTMLElement;
		expect(chip.textContent).toBe("3");
		expect(chip.dataset.tone).toBe("gray");
		view.unmount();

		for (const state of [
			{ kind: "loading" as const },
			{ kind: "unavailable" as const, retryable: true },
		]) {
			const loading = await renderWithMyAgentsRouter(
				<MyAgentsScreen state={state} />,
			);
			const plain = screen.getByRole("tab", { name: "申请", selected: true });
			expect(plain.querySelector('[data-slot="badge"]')).toBeNull();
			loading.unmount();
		}
	});

	it("follows the controlled tab and reports tab changes (M-01)", async () => {
		const changes: string[] = [];
		await renderWithMyAgentsRouter(
			<MyAgentsScreen
				state={{ kind: "ready", applications: [pendingApplication] }}
				ownedAgents={[]}
				tab="owned"
				onTabChange={(tab) => changes.push(tab)}
			/>,
		);
		expect(
			screen.getByRole("tab", { name: "已创建", selected: true }),
		).toBeTruthy();
		expect(screen.getByText("暂无你管理的 Agent")).toBeTruthy();
		fireEvent.click(screen.getByRole("tab", { name: "申请 1" }));
		expect(changes).toEqual(["applications"]);
	});

	it("places the static approval-history notice inside the applications panel (M-02 / NI-41)", async () => {
		await renderWithMyAgentsRouter(
			<MyAgentsScreen
				state={{ kind: "ready", applications: [pendingApplication] }}
				ownedAgents={[]}
			/>,
		);
		const panel = screen.getByRole("tabpanel", { name: "申请 1" });
		const title = within(panel).getByText("审批记录会保留");
		expect(title.tagName).toBe("STRONG");
		const notice = title.closest('[data-slot="alert"]') as HTMLElement;
		expect(notice.textContent).toContain(
			"驳回后可以修改范围或模型，再次提交申请。",
		);
		expect(
			notice.querySelector(":scope > svg")?.getAttribute("aria-hidden"),
		).toBe("true");
		// 静态说明：自身与祖先都不是 alert / status。
		expect(notice.closest('[role="alert"], [role="status"]')).toBeNull();
		// 列表之后出现。
		const list = within(panel).getByRole("list", { name: "我的申请" });
		expect(
			list.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		fireEvent.click(screen.getByRole("tab", { name: "已创建" }));
		await waitFor(() =>
			expect(screen.queryByText("审批记录会保留")).toBeNull(),
		);
	});

	it.each([
		{ kind: "loading" as const },
		{ kind: "unavailable" as const, retryable: true },
	])("omits the notice while applications are %j", async (state) => {
		await renderWithMyAgentsRouter(<MyAgentsScreen state={state} />);
		expect(screen.queryByText("审批记录会保留")).toBeNull();
	});

	it("shows rows with a non-link title, one detail link and a merged updated time (R4-11 / M-03)", async () => {
		await renderWithMyAgentsRouter(
			<MyAgentsScreen
				state={{ kind: "ready", applications: [pendingApplication] }}
			/>,
		);
		const row = screen
			.getByRole("heading", { name: pendingApplication.name })
			.closest("li") as HTMLElement;
		expect(row.querySelector("h2")?.closest("a")).toBeNull();
		const detailLinks = [...row.querySelectorAll("a")].filter(
			(link) =>
				link.getAttribute("href") ===
				"/my-agents/application%3Atenant%2F01%3Fdraft%23one%25",
		);
		expect(detailLinks).toHaveLength(1);
		const time = row.querySelector("time") as HTMLElement;
		expect(time.getAttribute("datetime")).toBe(pendingApplication.submittedAt);
		expect(time.closest("p")?.textContent).toBe(
			`${pendingApplication.description} · 更新于 ${time.textContent}`,
		);
		expect(document.body.textContent).not.toContain(
			pendingApplication.submittedAt,
		);
	});

	it("names every repeated link after its application or Agent (R4-11 / AC-11)", async () => {
		const agent = AgentProjectionV2Schema.parse(
			pilotFakeScenariosV2.starting.response.body,
		);
		const second = AgentProjectionV2Schema.parse({
			...agent,
			agentId: "agent-pilot-second",
			name: "Second assistant",
		});
		await renderWithMyAgentsRouter(
			<MyAgentsScreen
				state={{
					kind: "ready",
					applications: [
						pendingApplication,
						creatingApplication,
						AgentApplicationProjectionV2Schema.parse({
							...creatingApplication,
							applicationId: "application-pilot-3",
							agentId: "agent-pilot-3",
							name: "Third request",
						}),
					],
				}}
				ownedAgents={[agent, second]}
			/>,
		);
		const names = () =>
			screen
				.getAllByRole("link")
				.map(
					(link) => link.getAttribute("aria-label") ?? link.textContent ?? "",
				);
		const applicationNames = names();
		expect(new Set(applicationNames).size).toBe(applicationNames.length);
		expect(applicationNames).toContain(`查看申请：${pendingApplication.name}`);
		fireEvent.click(screen.getByRole("tab", { name: "已创建" }));
		const ownedNames = names();
		expect(new Set(ownedNames).size).toBe(ownedNames.length);
		expect(ownedNames).toEqual(
			expect.arrayContaining([
				`配置与生命周期：${agent.name}`,
				`查看详情：${agent.name}`,
				`配置与生命周期：${second.name}`,
				`查看详情：${second.name}`,
			]),
		);
	});

	it("renders 20 applications first and appends the rest from the list end (R4-11)", async () => {
		await renderWithMyAgentsRouter(
			<MyAgentsScreen
				state={{ kind: "ready", applications: applicationsNamed(36) }}
			/>,
		);
		expect(document.querySelectorAll(".application-row")).toHaveLength(20);
		const more = screen.getByRole("button", {
			name: "显示更多申请（剩余 16）",
		});
		fireEvent.click(more);
		await waitFor(() =>
			expect(document.querySelectorAll(".application-row")).toHaveLength(36),
		);
		expect(screen.queryByRole("button", { name: /^显示更多申请/ })).toBeNull();
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("link", { name: "查看申请：批量申请 21" }),
			),
		);
	});

	it("does not offer more applications when 20 or fewer exist", async () => {
		await renderWithMyAgentsRouter(
			<MyAgentsScreen
				state={{ kind: "ready", applications: applicationsNamed(20) }}
			/>,
		);
		expect(document.querySelectorAll(".application-row")).toHaveLength(20);
		expect(screen.queryByRole("button", { name: /^显示更多申请/ })).toBeNull();
	});

	it("labels owned card actions with icons and the design copy (M-05 / F-09)", async () => {
		const agent = AgentProjectionV2Schema.parse(
			pilotFakeScenariosV2.starting.response.body,
		);
		await renderWithMyAgentsRouter(
			<MyAgentsScreen
				state={{ kind: "ready", applications: [] }}
				ownedAgents={[agent]}
			/>,
		);
		expect(screen.queryByRole("tab", { name: "已创建 Agent" })).toBeNull();
		fireEvent.click(screen.getByRole("tab", { name: "已创建" }));
		for (const name of ["配置与生命周期", "查看详情"]) {
			const link = screen.getByRole("link", { name: `${name}：${agent.name}` });
			expect(link.textContent).toBe(name);
			const icons = link.querySelectorAll("svg");
			expect(icons).toHaveLength(1);
			expect(icons[0]?.getAttribute("aria-hidden")).toBe("true");
			// 图标在文字前。
			expect(link.firstElementChild?.tagName.toLowerCase()).toBe("svg");
		}
		expect(screen.queryByText("配置与管理")).toBeNull();
	});

	it("never falls back to an Owner user ID when the display name is empty (M-05)", async () => {
		// 契约要求非空显示名；这里绕过解析模拟空白显示名的降级显示。
		const parsed = AgentProjectionV2Schema.parse(
			pilotFakeScenariosV2.starting.response.body,
		);
		const agent = {
			...parsed,
			configuration: {
				...parsed.configuration,
				owners: [
					{
						userId: "user-hidden-owner",
						displayName: " ",
						roles: ["employee"],
					},
				],
			},
		} as typeof parsed;
		await renderWithMyAgentsRouter(
			<MyAgentsScreen
				state={{ kind: "ready", applications: [] }}
				ownedAgents={[agent]}
			/>,
		);
		fireEvent.click(screen.getByRole("tab", { name: "已创建" }));
		expect(screen.getByText("Owner · 未识别的用户")).toBeTruthy();
		expect(document.body.textContent).not.toContain("user-hidden-owner");
	});
});
