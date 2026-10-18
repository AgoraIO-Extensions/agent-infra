import {
	AgentProjectionV2Schema,
	BrowserSessionProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { commandAgentLifecycle } from "../agent-administration/agent-administration.js";
import {
	ConfigurationAdministratorActions,
	ConfigurationFooterLifecycleActions,
	ConfigurationFooterLifecycleFailure,
	ConfigurationStopDangerZone,
	configurationHeadingId,
	useConfigurationLifecycle,
} from "./configuration-lifecycle.js";

vi.mock(
	"../agent-administration/agent-administration.js",
	async (original) => ({
		...(await original<
			typeof import("../agent-administration/agent-administration.js")
		>()),
		commandAgentLifecycle: vi.fn(),
	}),
);

const baseAgent = AgentProjectionV2Schema.parse({
	...pilotFakeScenariosV2.starting.response.body,
	serviceAvailability: "ready",
});
const sessions = {
	owner: { userId: "user-owner-1", roles: ["employee"] },
	ownerAdmin: { userId: "user-owner-1", roles: ["employee", "system_admin"] },
	admin: { userId: "user-admin-1", roles: ["employee", "system_admin"] },
	employee: { userId: "user-employee-1", roles: ["employee"] },
} as const;
type Role = keyof typeof sessions;

function session(role: Role) {
	return {
		kind: "ready" as const,
		session: BrowserSessionProjectionV1Schema.parse({
			schemaVersion: 1,
			user: { ...sessions[role], displayName: role },
		}),
	};
}

function agentIn(
	managementStatus: AgentProjectionV2["managementStatus"],
	serviceAvailability: AgentProjectionV2["serviceAvailability"] = null,
): AgentProjectionV2 {
	return { ...baseAgent, managementStatus, serviceAvailability };
}

function Harness({
	agent,
	viewer,
}: {
	agent: AgentProjectionV2;
	viewer: Role;
}) {
	const lifecycle = useConfigurationLifecycle(agent, session(viewer));
	return (
		<>
			<h1 id={configurationHeadingId} tabIndex={-1}>
				配置
			</h1>
			<div data-testid="footer">
				<ConfigurationFooterLifecycleActions lifecycle={lifecycle} />
				<ConfigurationFooterLifecycleFailure lifecycle={lifecycle} />
			</div>
			<ConfigurationStopDangerZone lifecycle={lifecycle} />
			<ConfigurationAdministratorActions lifecycle={lifecycle} />
		</>
	);
}

function renderHarness(agent: AgentProjectionV2, role: Role) {
	const queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			<ToastProvider>{children}</ToastProvider>
		</QueryClientProvider>
	);
	return render(<Harness agent={agent} viewer={role} />, { wrapper });
}

function areaButtons(area: HTMLElement | null) {
	return area
		? within(area)
				.queryAllByRole("button")
				.map((button) => button.textContent)
		: [];
}

function layout() {
	return {
		footer: areaButtons(screen.getByTestId("footer")),
		danger: areaButtons(screen.queryByRole("region", { name: "停止 Agent" })),
		admin: areaButtons(screen.queryByRole("region", { name: "管理员操作" })),
	};
}

function toastText() {
	return document.querySelector('[data-slot="toast"]')?.textContent ?? "";
}

async function confirm(trigger: string, dialogName: RegExp, action: string) {
	fireEvent.click(screen.getByRole("button", { name: trigger }));
	const dialog = await screen.findByRole("dialog", { name: dialogName });
	fireEvent.click(within(dialog).getByRole("button", { name: action }));
}

afterEach(() => {
	cleanup();
	vi.mocked(commandAgentLifecycle).mockReset();
});

describe("Owner configuration lifecycle placement", () => {
	// 4 角色 × 5 种管理状态：命令集合与 main 相同，只是分到页脚、危险区与管理员区（N-01）。
	const matrix: Record<
		Role,
		Record<
			"creating" | "available" | "stopped" | "creation_failed" | "disabled",
			ReturnType<typeof layout>
		>
	> = {
		owner: {
			creating: { footer: [], danger: [], admin: [] },
			available: { footer: ["重启 Agent"], danger: ["停止 Agent"], admin: [] },
			stopped: { footer: ["重启 Agent"], danger: [], admin: [] },
			creation_failed: { footer: ["重试创建"], danger: [], admin: [] },
			disabled: { footer: [], danger: [], admin: [] },
		},
		ownerAdmin: {
			creating: { footer: [], danger: [], admin: ["停用 Agent"] },
			available: {
				footer: ["重启 Agent"],
				danger: ["停止 Agent"],
				admin: ["停用 Agent"],
			},
			stopped: { footer: ["重启 Agent"], danger: [], admin: ["停用 Agent"] },
			creation_failed: {
				footer: ["重试创建"],
				danger: [],
				admin: ["停用 Agent"],
			},
			disabled: { footer: [], danger: [], admin: [] },
		},
		admin: {
			creating: { footer: [], danger: [], admin: ["停用 Agent"] },
			available: { footer: [], danger: [], admin: ["停用 Agent"] },
			stopped: { footer: [], danger: [], admin: ["停用 Agent"] },
			creation_failed: {
				footer: [],
				danger: [],
				admin: ["重试创建", "停用 Agent"],
			},
			disabled: { footer: [], danger: [], admin: [] },
		},
		employee: {
			creating: { footer: [], danger: [], admin: [] },
			available: { footer: [], danger: [], admin: [] },
			stopped: { footer: [], danger: [], admin: [] },
			creation_failed: { footer: [], danger: [], admin: [] },
			disabled: { footer: [], danger: [], admin: [] },
		},
	};
	for (const [role, states] of Object.entries(matrix) as [
		Role,
		(typeof matrix)[Role],
	][])
		for (const [status, expected] of Object.entries(states) as [
			keyof typeof states,
			ReturnType<typeof layout>,
		][])
			it(`places ${role} commands for ${status}`, () => {
				renderHarness(
					agentIn(status, status === "available" ? "ready" : null),
					role,
				);
				expect(layout()).toEqual(expected);
				// 管理员区没有可用操作时不渲染标题与说明（NI-96）。
				if (expected.admin.length === 0)
					expect(screen.queryByText("管理员操作")).toBeNull();
			});

	it.each(["ready", "starting", "updating", "unavailable"] as const)(
		"keeps a single solid danger action for an Owner administrator while service is %s",
		(serviceAvailability) => {
			renderHarness(agentIn("available", serviceAvailability), "ownerAdmin");
			const danger = screen.getByRole("region", { name: "停止 Agent" });
			const admin = screen.getByRole("region", { name: "管理员操作" });
			expect(danger.classList.contains("lifecycle-danger-zone")).toBe(true);
			expect(admin.classList.contains("lifecycle-danger-zone")).toBe(false);
			expect(danger.contains(admin)).toBe(false);
			// 停止与停用使用不同的图标与说明；Owner 区不提「停用」，页面不重复状态行（R4-14）。
			const stopIcon = within(danger).getByRole("button").querySelector("svg");
			const disableIcon = within(admin)
				.getByRole("button")
				.querySelector("svg");
			expect(stopIcon?.getAttribute("aria-hidden")).toBe("true");
			expect(stopIcon?.getAttribute("class")).not.toBe(
				disableIcon?.getAttribute("class"),
			);
			expect(danger.textContent).not.toContain("停用");
			expect(admin.textContent).toContain("以下操作仅对系统管理员显示。");
			expect(document.body.textContent).not.toContain(
				"停用将撤销运行资格。Owner 不能恢复，个人历史仍保留。",
			);
			for (const text of ["Agent 状态", "服务状态", "服务已就绪。", "生命周期"])
				expect(document.body.textContent).not.toContain(text);
		},
	);
});

describe("Owner configuration lifecycle commands", () => {
	it("shares one pending command across the footer, danger zone and administrator area", async () => {
		const stop = Promise.withResolvers<AgentProjectionV2>();
		vi.mocked(commandAgentLifecycle).mockReturnValueOnce(stop.promise);
		renderHarness(agentIn("available", "ready"), "ownerAdmin");

		await confirm("停止 Agent", /^停止这个 Agent？$/, "停止 Agent");
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "停止中…" })).toBeTruthy(),
		);
		for (const name of ["停止中…", "重启 Agent", "停用 Agent"])
			expect(
				screen.getByRole("button", { name }).hasAttribute("disabled"),
			).toBe(true);
		expect(vi.mocked(commandAgentLifecycle).mock.calls).toEqual([
			["agent-pilot-1", "stop", expect.any(String)],
		]);
		stop.resolve(agentIn("stopped"));
		await waitFor(() => expect(toastText()).toBe("已提交停止请求"));
		expect(
			screen
				.getByRole("button", { name: "停用 Agent" })
				.hasAttribute("disabled"),
		).toBe(false);
		expect(document.body.textContent).not.toContain("操作已提交");
	});

	it("reports stop completion only after the detail read-back shows it stopped", async () => {
		vi.mocked(commandAgentLifecycle).mockResolvedValueOnce({
			schemaVersion: 1,
			accepted: true,
			agentId: "agent-pilot-1",
			replayed: false,
		});
		const rendered = renderHarness(agentIn("available", "ready"), "owner");
		await confirm("停止 Agent", /^停止这个 Agent？$/, "停止 Agent");
		await waitFor(() => expect(toastText()).toBe("已提交停止请求"));
		// 焦点留在危险区标题上，区域卸载后交给页面 h1（不是 body）。
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("heading", { name: "停止 Agent" }),
			),
		);
		rendered.rerender(<Harness agent={agentIn("stopped")} viewer="owner" />);
		await waitFor(() =>
			expect(toastText()).toBe("Agent 已停止，历史会话转为只读"),
		);
		expect(screen.queryByRole("region", { name: "停止 Agent" })).toBeNull();
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("heading", { name: "配置" }),
			),
		);
	});

	it("announces restart completion only after starting is followed by ready", async () => {
		vi.mocked(commandAgentLifecycle).mockResolvedValue({
			schemaVersion: 1,
			accepted: true,
			agentId: "agent-pilot-1",
			replayed: false,
		});
		const rendered = renderHarness(agentIn("available", "ready"), "owner");
		await confirm("重启 Agent", /^重启.+？$/, "确认重启");
		await waitFor(() => expect(toastText()).toBe("Agent 正在重启…"));
		// 回读始终是 ready、没有经过 starting / updating：不给完成提示。
		rendered.rerender(
			<Harness agent={{ ...agentIn("available", "ready") }} viewer="owner" />,
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(toastText()).toBe("Agent 正在重启…");
		rendered.rerender(
			<Harness agent={agentIn("available", "starting")} viewer="owner" />,
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(toastText()).toBe("Agent 正在重启…");
		rendered.rerender(
			<Harness agent={agentIn("available", "ready")} viewer="owner" />,
		);
		await waitFor(() => expect(toastText()).toBe("重启完成，Agent 已就绪"));
	});

	it("disables and reports administrator disable, then removes the area", async () => {
		vi.mocked(commandAgentLifecycle).mockResolvedValueOnce(agentIn("disabled"));
		const rendered = renderHarness(agentIn("stopped"), "ownerAdmin");
		await confirm("停用 Agent", /^停用 Agent？$/, "确认停用");
		await waitFor(() => expect(toastText()).toBe("已提交停用请求"));
		expect(vi.mocked(commandAgentLifecycle).mock.calls).toEqual([
			["agent-pilot-1", "disable", expect.any(String)],
		]);
		rendered.rerender(
			<Harness agent={agentIn("disabled")} viewer="ownerAdmin" />,
		);
		await waitFor(() => expect(toastText()).toBe("Agent 已停用"));
		expect(screen.queryByRole("region", { name: "管理员操作" })).toBeNull();
	});

	it("shows a failed command only in the area that started it", async () => {
		vi.mocked(commandAgentLifecycle).mockRejectedValueOnce(
			Object.assign(new Error("unavailable"), { retryable: true }),
		);
		renderHarness(agentIn("creation_failed"), "admin");
		await confirm("重试创建", /^重试创建 Agent？$/, "确认重试创建");
		const admin = screen.getByRole("region", { name: "管理员操作" });
		await waitFor(() =>
			expect(within(admin).getByRole("alert").textContent).toBe(
				"操作未能提交，请稍后重试。",
			),
		);
		expect(
			within(screen.getByTestId("footer")).queryByRole("alert"),
		).toBeNull();
		expect(toastText()).toBe("");
		// 失败后释放进行中状态，可以再次发起。
		expect(
			screen
				.getByRole("button", { name: "停用 Agent" })
				.hasAttribute("disabled"),
		).toBe(false);
	});

	it("never offers disable to an Owner without the administrator role", () => {
		for (const status of [
			"creating",
			"available",
			"stopped",
			"creation_failed",
		] as const) {
			renderHarness(
				agentIn(status, status === "available" ? "ready" : null),
				"owner",
			);
			expect(screen.queryByRole("button", { name: /停用/ })).toBeNull();
			cleanup();
		}
	});
});
