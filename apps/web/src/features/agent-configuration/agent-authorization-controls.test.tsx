import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	AgentAuthorizationRequestError,
	grantApplicationManager,
	grantApplicationUse,
	grantUserApiManage,
	grantUserApiUse,
	revokeApplicationUse,
	revokeUserApiManage,
	revokeUserApiUse,
} from "./agent-authorization.js";
import { AgentAuthorizationControls } from "./agent-authorization-controls.js";

vi.mock("./agent-authorization.js", () => ({
	grantApplicationManager: vi.fn(),
	grantApplicationUse: vi.fn(),
	grantUserApiManage: vi.fn(),
	grantUserApiUse: vi.fn(),
	revokeApplicationManager: vi.fn(),
	revokeApplicationUse: vi.fn(),
	revokeUserApiManage: vi.fn(),
	revokeUserApiUse: vi.fn(),
	AgentAuthorizationRequestError: class extends Error {
		status?: number;
		retryable = false;
	},
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("AgentAuthorizationControls", () => {
	it("names the target ID field after its section so it differs from the WeCom app ID (N-12)", () => {
		render(<AgentAuthorizationControls agentId="agent-1" enabled />);
		expect(
			screen.getByRole("textbox", { name: "应用 ID：Agent 授权控制" }).id,
		).toBe("agent-authorization-target-id");
		fireEvent.click(screen.getByRole("button", { name: "用户" }));
		expect(
			screen.getByRole("textbox", { name: "用户 ID：Agent 授权控制" }),
		).toBeTruthy();
	});

	it("grants and revokes a user's API management with the Owner's management revision (#3070)", async () => {
		vi.mocked(grantUserApiManage).mockResolvedValue({
			agentId: "agent-1",
			userId: "user-2",
			authorizationRevision: "manage-2",
			granted: true,
			replayed: false,
			schemaVersion: 1,
		});
		vi.mocked(revokeUserApiManage).mockResolvedValue({
			agentId: "agent-1",
			userId: "user-2",
			authorizationRevision: "manage-3",
			granted: false,
			replayed: false,
			schemaVersion: 1,
		});
		const onChanged = vi.fn();
		render(
			<AgentAuthorizationControls
				agentId="agent-1"
				enabled
				managementRevision={7}
				onChanged={onChanged}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "用户" }));
		// 不再要求 Owner 手工填写修订号（#3070）。
		expect(screen.queryByLabelText("授权版本")).toBeNull();
		fireEvent.change(screen.getByLabelText("用户 ID"), {
			target: { value: "user-2" },
		});
		const grant = screen.getByRole("button", { name: "授权用户 API 管理" });
		fireEvent.click(grant);
		await waitFor(() =>
			expect(grantUserApiManage).toHaveBeenCalledWith("agent-1", "user-2", 7),
		);
		expect(await screen.findByText("manage-2")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "撤销用户 API 管理" }));
		await waitFor(() =>
			expect(revokeUserApiManage).toHaveBeenCalledWith("agent-1", "user-2", 7),
		);
		expect(await screen.findByText("已撤销")).toBeTruthy();
		// 每次用户 API 授权后都重新读取详情，下一次提交用最新修订号。
		await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
		expect(grantUserApiUse).not.toHaveBeenCalled();
		expect(revokeUserApiUse).not.toHaveBeenCalled();
	});

	it("grants application management and renders returned metadata", async () => {
		vi.mocked(grantApplicationManager).mockResolvedValue({
			agentId: "agent-1",
			applicationId: "application-1",
			authorizationRevision: "auth-2",
			granted: true,
			replayed: false,
			schemaVersion: 1,
		});

		render(<AgentAuthorizationControls agentId="agent-1" enabled />);
		fireEvent.change(screen.getByLabelText("应用 ID"), {
			target: { value: "application-1" },
		});
		fireEvent.click(screen.getByRole("button", { name: "授权管理" }));

		await waitFor(() =>
			expect(grantApplicationManager).toHaveBeenCalledWith(
				"agent-1",
				"application-1",
			),
		);
		expect(await screen.findByText("已授权")).toBeTruthy();
		expect(screen.getByText("auth-2")).toBeTruthy();
		expect(screen.getByText("授权结果已由服务端确认。")).toBeTruthy();
	});

	it("revokes application use and explains an idempotent replay", async () => {
		vi.mocked(revokeApplicationUse).mockResolvedValue({
			agentId: "agent-1",
			applicationId: "application-1",
			authorizationRevision: null,
			granted: false,
			replayed: true,
			schemaVersion: 1,
		});

		render(<AgentAuthorizationControls agentId="agent-1" enabled />);
		fireEvent.change(screen.getByLabelText("应用 ID"), {
			target: { value: "application-1" },
		});
		fireEvent.click(screen.getByRole("button", { name: "撤销使用" }));

		expect(await screen.findByText("已撤销")).toBeTruthy();
		expect(
			screen.getByText("操作已幂等重放，服务端返回了原授权结果。"),
		).toBeTruthy();
		expect(screen.getByText("无")).toBeTruthy();
	});

	it("revokes user API use with the Owner's management revision", async () => {
		vi.mocked(revokeUserApiUse).mockResolvedValue({
			agentId: "agent-1",
			userId: "user-1",
			authorizationRevision: null,
			granted: false,
			replayed: false,
			schemaVersion: 1,
		});

		render(
			<AgentAuthorizationControls
				agentId="agent-1"
				enabled
				managementRevision={7}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /^用户$/ }));
		fireEvent.change(screen.getByLabelText("用户 ID"), {
			target: { value: "user-1" },
		});
		fireEvent.click(screen.getByRole("button", { name: "撤销用户 API 使用" }));

		await waitFor(() =>
			expect(revokeUserApiUse).toHaveBeenCalledWith("agent-1", "user-1", 7),
		);
	});

	it("grants user API use with the Owner's management revision", async () => {
		vi.mocked(grantUserApiUse).mockResolvedValue({
			agentId: "agent-1",
			userId: "user-1",
			authorizationRevision: "auth-8",
			granted: true,
			replayed: false,
			schemaVersion: 1,
		});

		render(
			<AgentAuthorizationControls
				agentId="agent-1"
				enabled
				managementRevision={7}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /^用户$/ }));
		fireEvent.change(screen.getByLabelText("用户 ID"), {
			target: { value: "user-1" },
		});
		fireEvent.click(screen.getByRole("button", { name: "授权用户 API 使用" }));

		await waitFor(() =>
			expect(grantUserApiUse).toHaveBeenCalledWith("agent-1", "user-1", 7),
		);
		expect(await screen.findByText("已授权")).toBeTruthy();
	});

	it("does not submit user API grants without a management revision (#3070)", () => {
		render(<AgentAuthorizationControls agentId="agent-1" enabled />);
		fireEvent.click(screen.getByRole("button", { name: /^用户$/ }));
		fireEvent.change(screen.getByLabelText("用户 ID"), {
			target: { value: "user-1" },
		});
		for (const name of [
			"授权用户 API 使用",
			"撤销用户 API 使用",
			"授权用户 API 管理",
			"撤销用户 API 管理",
		])
			expect(
				(screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
			).toBe(true);
		expect(screen.getByRole("status").textContent).toContain(
			"未能读取 Agent 管理修订号",
		);
	});

	it("explains a stale management revision and re-reads the Agent (#3070)", async () => {
		vi.mocked(grantUserApiUse).mockRejectedValue(
			Object.assign(new AgentAuthorizationRequestError(404, false), {
				status: 404,
			}),
		);
		const onChanged = vi.fn();
		render(
			<AgentAuthorizationControls
				agentId="agent-1"
				enabled
				managementRevision={7}
				onChanged={onChanged}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /^用户$/ }));
		fireEvent.change(screen.getByLabelText("用户 ID"), {
			target: { value: "user-1" },
		});
		fireEvent.click(screen.getByRole("button", { name: "授权用户 API 使用" }));
		expect(
			await screen.findByText(
				"Agent 管理状态已变化或目标不可用，页面已重新读取，请确认后重试。",
			),
		).toBeTruthy();
		expect(onChanged).toHaveBeenCalledTimes(1);
	});

	it("keeps rejected responses opaque and never renders upstream details", async () => {
		vi.mocked(grantApplicationUse).mockRejectedValue(
			Object.assign(new Error("private upstream detail"), { status: 403 }),
		);

		render(<AgentAuthorizationControls agentId="agent-1" enabled />);
		fireEvent.change(screen.getByLabelText("应用 ID"), {
			target: { value: "application-1" },
		});
		fireEvent.click(screen.getByRole("button", { name: "授权使用" }));

		expect(
			await screen.findByText(
				"操作未确认，请刷新页面后重试。未显示上游错误详情。",
			),
		).toBeTruthy();
		expect(screen.queryByText("private upstream detail")).toBeNull();
	});
});
