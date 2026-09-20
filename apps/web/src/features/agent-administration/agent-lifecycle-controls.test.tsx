import {
	AgentProjectionV2Schema,
	BrowserSessionProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pendingApplication } from "../my-agents/test-fixtures.js";
import { AgentLifecycleControls } from "./agent-lifecycle-controls.js";

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
const ordinaryUserSession = BrowserSessionProjectionV1Schema.parse({
	schemaVersion: 1,
	user: {
		userId: "user-employee-1",
		displayName: "Employee",
		roles: ["employee"],
	},
});
const unavailableAgent = AgentProjectionV2Schema.parse({
	schemaVersion: 2,
	agentId: "agent-pilot-1",
	name: "Release assistant",
	description: "Helps the release team",
	source: { kind: "standard", templateId: "codex" },
	managementStatus: "available",
	serviceAvailability: "unavailable",
	configuration: {
		...pendingApplication.configuration,
		owners: [ownerSession.user],
	},
	capabilities: {
		modelSelection: false,
		attachments: false,
		resultFiles: false,
		connection: false,
		supplementaryInstruction: false,
	},
	interactionUrl: null,
});

afterEach(cleanup);

describe("AgentLifecycleControls", () => {
	it("keeps service availability distinct and requires confirmation of an Owner command", async () => {
		const onCommand = vi.fn();
		render(
			<AgentLifecycleControls
				agent={unavailableAgent}
				onCommand={onCommand}
				session={{ kind: "ready", session: ownerSession }}
			/>,
		);

		expect(screen.getByText("可用")).toBeTruthy();
		expect(screen.getByText("暂时不可用")).toBeTruthy();
		expect(screen.getByText("服务暂不可用，恢复前个人历史只读。")).toBeTruthy();
		expect(screen.getByRole("button", { name: "重启 Agent" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "停止 Agent" })).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "重启 Agent" }));
		const dialog = await screen.findByRole("dialog", {
			name: "重新启动 Agent？",
		});
		expect(onCommand).not.toHaveBeenCalled();
		expect(
			within(dialog).getByText("重启期间暂不能发送消息，已有历史保留。"),
		).toBeTruthy();
		fireEvent.click(within(dialog).getByRole("button", { name: "确认重启" }));
		expect(onCommand).toHaveBeenCalledExactlyOnceWith("restart");
	});

	it.each(["starting", "updating"] as const)(
		"offers Owner lifecycle commands while service is %s",
		(serviceAvailability) => {
			render(
				<AgentLifecycleControls
					agent={{ ...unavailableAgent, serviceAvailability }}
					onCommand={vi.fn()}
					session={{ kind: "ready", session: ownerSession }}
				/>,
			);

			expect(screen.getByRole("button", { name: "停止 Agent" })).toBeTruthy();
			expect(screen.getByRole("button", { name: "重启 Agent" })).toBeTruthy();
		},
	);

	it("uses the server-projected management state to limit Owner and administrator controls", () => {
		const owner = vi.fn();
		const { rerender } = render(
			<AgentLifecycleControls
				agent={{
					...unavailableAgent,
					managementStatus: "stopped",
					serviceAvailability: null,
				}}
				onCommand={owner}
				session={{ kind: "ready", session: ownerSession }}
			/>,
		);

		expect(screen.getByText("已停止")).toBeTruthy();
		expect(screen.getByRole("button", { name: "重启 Agent" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "停止 Agent" })).toBeNull();
		expect(screen.queryByText("服务状态")).toBeNull();

		rerender(
			<AgentLifecycleControls
				agent={{
					...unavailableAgent,
					managementStatus: "creation_failed",
					serviceAvailability: null,
				}}
				onCommand={owner}
				session={{ kind: "ready", session: administratorSession }}
			/>,
		);
		expect(screen.getByText("创建失败")).toBeTruthy();
		expect(screen.getByRole("button", { name: "重试创建" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "停用 Agent" })).toBeTruthy();

		rerender(
			<AgentLifecycleControls
				agent={{
					...unavailableAgent,
					managementStatus: "disabled",
					serviceAvailability: null,
				}}
				onCommand={owner}
				session={{ kind: "ready", session: ownerSession }}
			/>,
		);
		expect(screen.getByText("已停用")).toBeTruthy();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("does not infer lifecycle permission for an ordinary-user projection", () => {
		render(
			<AgentLifecycleControls
				agent={unavailableAgent}
				onCommand={vi.fn()}
				session={{ kind: "ready", session: ordinaryUserSession }}
			/>,
		);

		expect(screen.queryByRole("button")).toBeNull();
	});

	it("renders processing and terminal lifecycle feedback for the matching Agent", () => {
		const failedAgent = {
			...unavailableAgent,
			managementStatus: "creation_failed" as const,
			serviceAvailability: null,
		};
		const { rerender } = render(
			<AgentLifecycleControls
				agent={failedAgent}
				onCommand={vi.fn()}
				pendingCommand={{
					agentId: failedAgent.agentId,
					command: "retry_creation",
				}}
				session={{ kind: "ready", session: administratorSession }}
			/>,
		);

		expect(screen.getByRole("button", { name: "重试创建中…" })).toBeTruthy();

		rerender(
			<AgentLifecycleControls
				agent={failedAgent}
				commandResult={{
					...failedAgent,
					managementStatus: "creating",
				}}
				onCommand={vi.fn()}
				session={{ kind: "ready", session: administratorSession }}
			/>,
		);
		expect(screen.getByRole("status").textContent).toBe("操作已提交：创建中。");

		rerender(
			<AgentLifecycleControls
				agent={failedAgent}
				commandError={Object.assign(new Error(), { retryable: false })}
				onCommand={vi.fn()}
				session={{ kind: "ready", session: administratorSession }}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"权限或 Agent 状态已变化，请刷新页面。",
		);
	});
	it.each([
		{
			command: "stop",
			trigger: "停止 Agent",
			title: "停止 Agent？",
			confirm: "确认停止",
			session: ownerSession,
		},
		{
			command: "disable",
			trigger: "停用 Agent",
			title: "停用 Agent？",
			confirm: "确认停用",
			session: administratorSession,
		},
	] as const)(
		"cancels and confirms $command without an early command",
		async ({ command, trigger, title, confirm, session }) => {
			const onCommand = vi.fn();
			render(
				<AgentLifecycleControls
					agent={unavailableAgent}
					onCommand={onCommand}
					session={{ kind: "ready", session }}
				/>,
			);
			fireEvent.click(screen.getByRole("button", { name: trigger }));
			let dialog = await screen.findByRole("dialog", { name: title });
			expect(onCommand).not.toHaveBeenCalled();
			fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
			await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
			expect(onCommand).not.toHaveBeenCalled();
			fireEvent.click(screen.getByRole("button", { name: trigger }));
			dialog = await screen.findByRole("dialog", { name: title });
			fireEvent.click(within(dialog).getByRole("button", { name: confirm }));
			expect(onCommand).toHaveBeenCalledExactlyOnceWith(command);
		},
	);

	it("removes an open confirmation after the projected Owner permission is lost", async () => {
		const onCommand = vi.fn();
		const { rerender } = render(
			<AgentLifecycleControls
				agent={unavailableAgent}
				onCommand={onCommand}
				session={{ kind: "ready", session: ownerSession }}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "停止 Agent" }));
		await screen.findByRole("dialog");
		rerender(
			<AgentLifecycleControls
				agent={unavailableAgent}
				onCommand={onCommand}
				session={{ kind: "ready", session: ordinaryUserSession }}
			/>,
		);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
		expect(onCommand).not.toHaveBeenCalled();
	});

	it("disables confirmation if another command becomes pending", async () => {
		const onCommand = vi.fn();
		const props = {
			agent: unavailableAgent,
			onCommand,
			session: { kind: "ready" as const, session: ownerSession },
		};
		const { rerender } = render(<AgentLifecycleControls {...props} />);
		fireEvent.click(screen.getByRole("button", { name: "停止 Agent" }));
		await screen.findByRole("dialog");
		rerender(
			<AgentLifecycleControls
				{...props}
				pendingCommand={{
					agentId: unavailableAgent.agentId,
					command: "restart",
				}}
			/>,
		);
		const confirm = screen.getByRole("button", { name: "确认停止" });
		expect(confirm.getAttribute("disabled")).not.toBeNull();
		fireEvent.click(confirm);
		expect(onCommand).not.toHaveBeenCalled();
	});

	it("latches a lifecycle command before the parent exposes pending state", async () => {
		const onCommand = vi.fn();
		render(
			<AgentLifecycleControls
				agent={unavailableAgent}
				onCommand={onCommand}
				session={{ kind: "ready", session: ownerSession }}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "停止 Agent" }));
		const dialog = await screen.findByRole("dialog", { name: "停止 Agent？" });
		fireEvent.click(within(dialog).getByRole("button", { name: "确认停止" }));

		expect(onCommand).toHaveBeenCalledExactlyOnceWith("stop");
		expect(
			screen.getByRole("button", { name: "停止中…" }).hasAttribute("disabled"),
		).toBe(true);
		expect(
			screen
				.getByRole("button", { name: "重启 Agent" })
				.hasAttribute("disabled"),
		).toBe(true);
	});

	it("focuses completion only for the displayed Agent", async () => {
		const props = {
			agent: unavailableAgent,
			onCommand: vi.fn(),
			session: { kind: "ready" as const, session: ownerSession },
		};
		const { rerender } = render(
			<AgentLifecycleControls
				{...props}
				commandResult={{
					...unavailableAgent,
					agentId: "other-agent",
					managementStatus: "stopped",
				}}
			/>,
		);
		expect(screen.queryByRole("status")).toBeNull();
		rerender(
			<AgentLifecycleControls
				{...props}
				commandResult={{ ...unavailableAgent, managementStatus: "stopped" }}
			/>,
		);
		const status = screen.getByRole("status");
		await waitFor(() => expect(document.activeElement).toBe(status));
	});
});
