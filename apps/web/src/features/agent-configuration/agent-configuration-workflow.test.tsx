import {
	AgentProjectionV2Schema,
	BrowserSessionProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import {
	cleanup,
	fireEvent,
	render as renderWithoutToast,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentLifecycleCommand } from "../agent-administration/use-agent-lifecycle-command.js";
import { useBrowserSession } from "../use-browser-session.js";
import {
	grantApplicationManager,
	grantUserApiUse,
} from "./agent-authorization.js";
import { AgentConfigurationWorkflow } from "./agent-configuration-workflow.js";
import { ConfigurationTestProviders } from "./test-router-context.js";
import { useAgentConfigurationSubmission } from "./use-agent-configuration-submission.js";
import { useAgentDefaultRelayKeyState } from "./use-agent-default-relay-key-state.js";
import { useAgentSavedRelayKeyCandidates } from "./use-agent-saved-relay-key-candidates.js";

vi.mock("../use-browser-session.js", () => ({
	useBrowserSession: vi.fn(),
}));
vi.mock("../agent-administration/use-agent-lifecycle-command.js", () => ({
	useAgentLifecycleCommand: vi.fn(),
}));
vi.mock("./use-agent-configuration-submission.js", () => ({
	useAgentConfigurationSubmission: vi.fn(),
}));
vi.mock("./use-agent-default-relay-key-state.js", () => ({
	useAgentDefaultRelayKeyState: vi.fn(),
}));
vi.mock("./use-agent-saved-relay-key-candidates.js", () => ({
	useAgentSavedRelayKeyCandidates: vi.fn(),
}));
vi.mock("./agent-authorization.js", () => ({
	AgentAuthorizationRequestError: class extends Error {},
	grantApplicationManager: vi.fn(),
	grantApplicationUse: vi.fn(),
	revokeApplicationManager: vi.fn(),
	revokeApplicationUse: vi.fn(),
	revokeUserApiUse: vi.fn(),
	grantUserApiUse: vi.fn(),
}));

const ownerSession = BrowserSessionProjectionV1Schema.parse({
	schemaVersion: 1,
	user: {
		userId: "user-owner-1",
		displayName: "Owner",
		roles: ["employee"],
	},
});
const administratorSession = BrowserSessionProjectionV1Schema.parse({
	schemaVersion: 1,
	user: {
		userId: "user-admin-1",
		displayName: "Administrator",
		roles: ["employee", "system_admin"],
	},
});
const ownerAdministratorSession = BrowserSessionProjectionV1Schema.parse({
	schemaVersion: 1,
	user: {
		userId: "user-owner-1",
		displayName: "Owner administrator",
		roles: ["employee", "system_admin"],
	},
});
const employeeSession = BrowserSessionProjectionV1Schema.parse({
	schemaVersion: 1,
	user: {
		userId: "user-employee-1",
		displayName: "Employee",
		roles: ["employee"],
	},
});
const firstAgent = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);

// 页面上的生命周期反馈与企微解绑提示使用根布局的 Toast 宿主；页头是路由 Link，同时提供路由上下文。
function render(ui: ReactElement) {
	return renderWithoutToast(ui, { wrapper: ConfigurationTestProviders });
}

function useSession(session: typeof ownerSession) {
	vi.mocked(useBrowserSession).mockReturnValue({
		state: { kind: "ready", session },
	} as never);
}
const secondAgent = AgentProjectionV2Schema.parse({
	...firstAgent,
	agentId: "agent-configuration-2",
	configuration: {
		...firstAgent.configuration,
		availability: [{ kind: "organization", organizationId: "organization-2" }],
		secrets: [],
	},
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

beforeEach(() => {
	vi.mocked(useBrowserSession).mockReturnValue({
		state: { kind: "ready", session: ownerSession },
	} as never);
	vi.mocked(useAgentDefaultRelayKeyState).mockReturnValue({
		data: undefined,
	} as never);
	vi.mocked(useAgentSavedRelayKeyCandidates).mockReturnValue({
		data: undefined,
		isError: false,
		isPending: false,
		error: null,
		refetch: vi.fn(),
	} as never);
	vi.mocked(useAgentLifecycleCommand).mockReturnValue({
		isPending: false,
		mutateAsync: vi.fn(() => new Promise(() => undefined)),
	} as never);
	vi.mocked(useAgentConfigurationSubmission).mockReturnValue({
		isError: false,
		error: null,
		data: undefined,
		isPending: false,
		saveConfiguration: vi.fn(),
		upgradeImage: vi.fn(),
		replaceSecret: vi.fn(),
		checkDefaultRelayKey: vi.fn(),
		replaceDefaultRelayKey: vi.fn(),
		replaceDefaultRelayKeyWithModels: vi.fn(),
	} as never);
});

describe("AgentConfigurationWorkflow", () => {
	it("gives a pure administrator the same page heading with administrator actions only", () => {
		useSession(administratorSession);

		render(<AgentConfigurationWorkflow agent={firstAgent} />);

		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"配置 Agent 的 Owner、范围和运行方式。",
		);
		expect(screen.queryByText("配置不可用")).toBeNull();
		expect(screen.queryByText("当前无法访问此配置。")).toBeNull();
		expect(screen.getByText("权限边界")).toBeTruthy();
		// API 与应用授权只由当前 Owner 治理，服务端拒绝纯管理员；页面不显示该入口（#3033 AC-2）。
		expect(screen.queryByRole("region", { name: "Agent 授权控制" })).toBeNull();
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(screen.queryByRole("button", { name: /^(授权|撤销)/ })).toBeNull();
		// 管理员在使用范围内时，Agent 详情对其可见，返回链接不变。
		expect(
			screen
				.getByRole("link", { name: "返回 Agent 详情" })
				.getAttribute("href"),
		).toBe(`/agents/${firstAgent.agentId}`);
		const admin = screen.getByRole("region", { name: "管理员操作" });
		expect(
			within(admin).getByRole("button", { name: "停用 Agent" }),
		).toBeTruthy();
		// 纯管理员不显示 Owner 才能编辑的配置，也没有 Owner 的停止 / 重启。
		expect(
			screen.queryByRole("combobox", { name: "共同 Owner 用户" }),
		).toBeNull();
		expect(screen.queryByRole("button", { name: "保存配置" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: /停止 Agent|重启 Agent/ }),
		).toBeNull();
		expect(screen.queryByRole("region", { name: "停止 Agent" })).toBeNull();
		// 卡片嵌套不超过两层：没有 form-aside，管理员区不在表单卡内。
		expect(document.querySelector(".form-aside")).toBeNull();
		expect(admin.closest(".configuration-form-card")).toBeNull();
	});

	it("sends a pure administrator read through the administrator projection back to Agent management (#3033)", () => {
		useSession(administratorSession);

		render(
			<AgentConfigurationWorkflow
				agent={{ ...firstAgent, serviceAvailability: "ready" }}
				administratorProjection
			/>,
		);

		// Agent 详情对不在使用范围内的管理员不可见：返回链接改为 Agent 管理。
		expect(screen.queryByRole("link", { name: "返回 Agent 详情" })).toBeNull();
		expect(
			screen
				.getByRole("link", { name: "返回 Agent 管理" })
				.getAttribute("href"),
		).toBe("/admin/agents");
		// Owner 字段来自服务端投影，页头照常显示。
		expect(screen.getByText("Owner · Owner")).toBeTruthy();
		expect(screen.queryByRole("region", { name: "Agent 授权控制" })).toBeNull();
		const admin = screen.getByRole("region", { name: "管理员操作" });
		expect(
			within(admin)
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["停用 Agent"]);
		expect(
			screen.queryByRole("button", { name: /停止 Agent|重启 Agent|保存配置/ }),
		).toBeNull();
	});

	it("keeps the Agent authorization controls for the current Owner", () => {
		useSession(ownerSession);

		render(<AgentConfigurationWorkflow agent={firstAgent} />);

		expect(screen.getByRole("region", { name: "Agent 授权控制" })).toBeTruthy();
	});

	it("grants user API use with the revision from the Owner's Agent detail and re-reads it (#3070)", async () => {
		useSession(ownerSession);
		vi.mocked(grantUserApiUse).mockResolvedValue({
			schemaVersion: 1,
			agentId: firstAgent.agentId,
			userId: "user-2",
			authorizationRevision: "use-2",
			granted: true,
			replayed: false,
		});
		const onAgentChanged = vi.fn();

		render(
			<AgentConfigurationWorkflow
				agent={{ ...firstAgent, managementRevision: 5 }}
				onAgentChanged={onAgentChanged}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /^用户$/ }));
		fireEvent.change(screen.getByLabelText("用户 ID"), {
			target: { value: "user-2" },
		});
		fireEvent.click(screen.getByRole("button", { name: "授权用户 API 使用" }));

		await waitFor(() =>
			expect(grantUserApiUse).toHaveBeenCalledWith(
				firstAgent.agentId,
				"user-2",
				5,
			),
		);
		await waitFor(() => expect(onAgentChanged).toHaveBeenCalledTimes(1));
	});

	it("keeps the employee unavailable view without any controls", () => {
		useSession(employeeSession);

		render(<AgentConfigurationWorkflow agent={firstAgent} />);

		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"配置不可用",
		);
		expect(screen.getByText("当前无法访问此配置。")).toBeTruthy();
		expect(screen.queryAllByRole("button")).toEqual([]);
		expect(screen.queryAllByRole("textbox")).toEqual([]);
		expect(screen.queryByText("权限边界")).toBeNull();
	});

	it("separates the Owner stop danger zone from the administrator disable action", () => {
		useSession(ownerAdministratorSession);

		render(
			<AgentConfigurationWorkflow
				agent={{ ...firstAgent, serviceAvailability: "ready" }}
			/>,
		);

		const footer = screen
			.getByRole("button", { name: "保存配置" })
			.closest(".form-footer") as HTMLElement;
		expect(
			within(footer)
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["保存配置", "重启 Agent"]);
		const danger = screen.getByRole("region", { name: "停止 Agent" });
		const admin = screen.getByRole("region", { name: "管理员操作" });
		expect(within(danger).getByRole("button").textContent).toBe("停止 Agent");
		expect(within(admin).getByRole("button").textContent).toBe("停用 Agent");
		expect(danger.compareDocumentPosition(admin)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		expect(document.body.textContent).not.toContain("生命周期");
	});

	it("drives all lifecycle areas from one shared lifecycle mutation", () => {
		useSession(ownerAdministratorSession);
		vi.mocked(useAgentLifecycleCommand).mockReturnValue({
			isPending: true,
			mutateAsync: vi.fn(),
		} as never);

		render(
			<AgentConfigurationWorkflow
				agent={{ ...firstAgent, serviceAvailability: "ready" }}
			/>,
		);

		// 每次渲染只创建一个生命周期 mutation，三个区域共享它的进行中状态（NI-88）。
		// workflow 每次渲染读取一次会话；生命周期 mutation 的创建次数与之相同，而不是每个区域各一个。
		const calls = vi.mocked(useAgentLifecycleCommand).mock.calls;
		expect(calls.length).toBe(vi.mocked(useBrowserSession).mock.calls.length);
		expect(new Set(calls.map(([agentId]) => agentId))).toEqual(
			new Set([firstAgent.agentId]),
		);
		for (const name of ["重启 Agent", "停止 Agent", "停用 Agent"])
			expect(
				screen.getByRole("button", { name }).hasAttribute("disabled"),
			).toBe(true);
	});

	it("drops an unsaved environment change when navigation changes the Agent", () => {
		const { rerender } = render(
			<AgentConfigurationWorkflow agent={firstAgent} />,
		);
		fireEvent.change(screen.getByLabelText("值"), {
			target: { value: "typed-change" },
		});

		rerender(<AgentConfigurationWorkflow agent={secondAgent} />);

		// 换成另一个 Agent 后草稿回到它自己的配置：没有改动，保存不可用（#2560）。
		expect(screen.getByLabelText<HTMLInputElement>("值").value).toBe("release");
		expect(
			screen.getByRole("button", { name: "保存配置" }).hasAttribute("disabled"),
		).toBe(true);
		// 做一次真实改动后保存，请求里的范围必须是第二个 Agent 的，而不是上一个的。
		fireEvent.change(screen.getByLabelText("值"), {
			target: { value: "other-value" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
		expect(
			vi.mocked(useAgentConfigurationSubmission).mock.results.at(-1)?.value
				.saveConfiguration,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				availability: [
					{ kind: "organization", organizationId: "organization-2" },
				],
				environment: [{ name: "WORKSPACE_NAME", value: "other-value" }],
			}),
		);
	});

	it("reads the default Key state only for Owners of a standard-template Agent (#2421)", () => {
		render(<AgentConfigurationWorkflow agent={firstAgent} />);
		expect(vi.mocked(useAgentDefaultRelayKeyState)).toHaveBeenLastCalledWith(
			firstAgent.agentId,
			true,
		);
		cleanup();
		vi.mocked(useBrowserSession).mockReturnValue({
			state: { kind: "ready", session: administratorSession },
		} as never);
		render(<AgentConfigurationWorkflow agent={firstAgent} />);
		expect(vi.mocked(useAgentDefaultRelayKeyState)).toHaveBeenLastCalledWith(
			firstAgent.agentId,
			false,
		);
	});

	it("shows the V2 free-text model fields unless the default Key manages the models (#2421)", () => {
		render(<AgentConfigurationWorkflow agent={firstAgent} />);
		expect(screen.getByRole("checkbox", { name: "替换模型配置" })).toBeTruthy();
		cleanup();
		vi.mocked(useAgentDefaultRelayKeyState).mockReturnValue({
			data: {
				schemaVersion: 1,
				isSet: true,
				keyVersion: 2,
				configurationRevision: 7,
			},
		} as never);
		render(<AgentConfigurationWorkflow agent={firstAgent} />);
		expect(screen.queryByRole("checkbox", { name: "替换模型配置" })).toBeNull();
	});

	it("reads saved candidates only after the Owner default Key is confirmed", () => {
		vi.mocked(useAgentDefaultRelayKeyState).mockReturnValue({
			data: {
				schemaVersion: 1,
				isSet: true,
				keyVersion: 2,
				configurationRevision: 7,
			},
		} as never);
		render(<AgentConfigurationWorkflow agent={firstAgent} />);
		expect(vi.mocked(useAgentSavedRelayKeyCandidates)).toHaveBeenLastCalledWith(
			firstAgent.agentId,
			true,
		);

		cleanup();
		vi.mocked(useBrowserSession).mockReturnValue({
			state: { kind: "ready", session: administratorSession },
		} as never);
		render(<AgentConfigurationWorkflow agent={firstAgent} />);
		expect(vi.mocked(useAgentSavedRelayKeyCandidates)).toHaveBeenLastCalledWith(
			firstAgent.agentId,
			false,
		);
	});

	it("resets pending authorization controls when an Owner changes Agent", () => {
		useSession(ownerSession);
		vi.mocked(grantApplicationManager).mockReturnValue(
			new Promise(() => undefined),
		);
		const controls = () =>
			within(screen.getByRole("region", { name: "Agent 授权控制" }));

		const { rerender } = render(
			<AgentConfigurationWorkflow agent={firstAgent} />,
		);
		fireEvent.change(controls().getByLabelText("应用 ID"), {
			target: { value: "application-1" },
		});
		fireEvent.click(controls().getByRole("button", { name: "授权管理" }));
		expect(controls().getByRole("button", { name: "授权管理" })).toHaveProperty(
			"disabled",
			true,
		);

		rerender(<AgentConfigurationWorkflow agent={secondAgent} />);

		expect(controls().getByLabelText("应用 ID")).toHaveProperty("value", "");
		expect(controls().getByRole("button", { name: "授权管理" })).toHaveProperty(
			"disabled",
			true,
		);
	});
});
