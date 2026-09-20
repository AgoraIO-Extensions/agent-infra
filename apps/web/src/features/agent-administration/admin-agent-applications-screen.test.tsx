import { BrowserSessionProjectionV1Schema } from "@agent-infra/contracts/pilot";
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
import { AdminAgentApplicationsScreen } from "./admin-agent-applications-screen.js";

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

afterEach(cleanup);

describe("AdminAgentApplicationsScreen", () => {
	it("reviews real projected resource, Owner, model and scope details before approving", async () => {
		const onDecision = vi.fn();
		const application = {
			...pendingApplication,
			configuration: {
				...pendingApplication.configuration,
				availability: [
					{ kind: "organization" as const, organizationId: "org-release" },
				],
				modelOptions: [
					{
						optionId: "model-primary",
						modelId: "release-model",
						displayName: "Release model",
						reasoningLevels: ["high"],
					},
				],
				defaultModelOptionId: "model-primary",
				defaultReasoningLevel: "high",
			},
		};
		render(
			<AdminAgentApplicationsScreen
				onDecision={onDecision}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [application] }}
			/>,
		);
		expect(screen.getByRole("heading", { name: "审批" })).toBeTruthy();
		expect(screen.getByText("待审批")).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.queryByRole("button", { name: "批准并创建" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "审阅申请" }));
		const dialog = await screen.findByRole("dialog", { name: "审阅创建申请" });
		expect(within(dialog).getByText("Small（只读）")).toBeTruthy();
		expect(
			within(dialog).getByText("250m CPU / 512 MiB 内存 / 1 GiB 存储"),
		).toBeTruthy();
		expect(within(dialog).getByText("Applicant")).toBeTruthy();
		expect(within(dialog).getByText("组织：org-release")).toBeTruthy();
		expect(
			within(dialog).getByText("Release model（release-model）"),
		).toBeTruthy();
		expect(within(dialog).getByText("model-primary")).toBeTruthy();
		expect(within(dialog).queryByRole("textbox")).toBeNull();
		expect(onDecision).not.toHaveBeenCalled();
		fireEvent.click(within(dialog).getByRole("button", { name: "批准并创建" }));
		expect(onDecision).toHaveBeenCalledExactlyOnceWith(
			application.applicationId,
			{ decision: "approve" },
		);
	});

	it("requires and focuses a meaningful rejection reason, then submits its trimmed value", async () => {
		const onDecision = vi.fn();
		render(
			<AdminAgentApplicationsScreen
				onDecision={onDecision}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [pendingApplication] }}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "审阅申请" }));
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "驳回" }));
		const reason = within(dialog).getByLabelText("驳回原因");
		fireEvent.change(reason, { target: { value: "   " } });
		fireEvent.click(within(dialog).getByRole("button", { name: "确认驳回" }));
		expect(onDecision).not.toHaveBeenCalled();
		expect(within(dialog).getByRole("alert").textContent).toBe(
			"请输入驳回原因。",
		);
		expect(reason.getAttribute("aria-invalid")).toBe("true");
		expect(document.activeElement).toBe(reason);
		fireEvent.change(reason, { target: { value: "  请补充使用范围。  " } });
		fireEvent.click(within(dialog).getByRole("button", { name: "确认驳回" }));
		expect(onDecision).toHaveBeenCalledExactlyOnceWith(
			pendingApplication.applicationId,
			{ decision: "reject", reason: "请补充使用范围。" },
		);
	});

	it("blocks repeat decisions while pending and closes the review after the result", async () => {
		const onDecision = vi.fn();
		const props = {
			onDecision,
			session: { kind: "ready" as const, session: administratorSession },
			state: { kind: "ready" as const, applications: [pendingApplication] },
		};
		const { rerender } = render(<AdminAgentApplicationsScreen {...props} />);
		fireEvent.click(screen.getByRole("button", { name: "审阅申请" }));
		await screen.findByRole("dialog");
		fireEvent.click(screen.getByRole("button", { name: "批准并创建" }));
		rerender(
			<AdminAgentApplicationsScreen
				{...props}
				pendingDecision={{
					applicationId: pendingApplication.applicationId,
					decision: { decision: "approve" },
				}}
			/>,
		);
		const approve = screen.getByRole("button", { name: "批准中…" });
		expect(approve.getAttribute("disabled")).not.toBeNull();
		expect(
			screen.getByRole("button", { name: "取消" }).getAttribute("disabled"),
		).not.toBeNull();
		expect(screen.queryByRole("button", { name: "关闭窗口" })).toBeNull();
		fireEvent.click(approve);
		expect(onDecision).toHaveBeenCalledTimes(1);
		rerender(
			<AdminAgentApplicationsScreen
				{...props}
				decisionResult={{
					...pendingApplication,
					agentId: "agent-pilot-1",
					status: "creating",
				}}
			/>,
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(screen.getByRole("status").textContent).toContain("创建中");
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole("status")),
		);
	});

	it("removes an open review if the session loses administrator access", async () => {
		const onDecision = vi.fn();
		const { rerender } = render(
			<AdminAgentApplicationsScreen
				onDecision={onDecision}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [pendingApplication] }}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "审阅申请" }));
		await screen.findByRole("dialog");
		rerender(
			<AdminAgentApplicationsScreen
				onDecision={onDecision}
				session={{ kind: "ready", session: ordinaryUserSession }}
				state={{ kind: "ready", applications: [pendingApplication] }}
			/>,
		);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.queryByRole("button", { name: "批准并创建" })).toBeNull();
		expect(onDecision).not.toHaveBeenCalled();
	});

	it("does not render application data or controls for an ordinary-user projection", () => {
		render(
			<AdminAgentApplicationsScreen
				onDecision={vi.fn()}
				session={{ kind: "ready", session: ordinaryUserSession }}
				state={{ kind: "ready", applications: [pendingApplication] }}
			/>,
		);

		expect(screen.getByRole("alert").textContent).toBe("当前无法访问审批。");
		expect(screen.queryByText("Release assistant request")).toBeNull();
		expect(screen.queryByRole("button", { name: "批准并创建" })).toBeNull();
	});

	it("renders processing and terminal decision feedback for the matching application", () => {
		const approvedApplication = {
			...pendingApplication,
			agentId: "agent-pilot-1",
			status: "creating" as const,
			decision: {
				decidedAt: "2026-09-04T08:00:00Z",
				reason: null,
			},
		};
		const { rerender } = render(
			<AdminAgentApplicationsScreen
				onDecision={vi.fn()}
				pendingDecision={{
					applicationId: pendingApplication.applicationId,
					decision: { decision: "approve" },
				}}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [pendingApplication] }}
			/>,
		);

		expect(screen.getByRole("button", { name: "审批提交中…" })).toBeTruthy();

		rerender(
			<AdminAgentApplicationsScreen
				decisionResult={approvedApplication}
				onDecision={vi.fn()}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [] }}
			/>,
		);
		expect(screen.getByRole("status").textContent).toBe(
			"已提交 Release assistant request 的审批结果：创建中。",
		);

		rerender(
			<AdminAgentApplicationsScreen
				decisionResult={approvedApplication}
				onDecision={vi.fn()}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "unavailable", retryable: true }}
			/>,
		);
		expect(screen.getByRole("status").textContent).toBe(
			"已提交 Release assistant request 的审批结果：创建中。",
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"审批列表暂时无法读取，请稍后重试。",
		);
	});

	it("distinguishes retryable and permission-lost decision failures", () => {
		const { rerender } = render(
			<AdminAgentApplicationsScreen
				decisionError={Object.assign(new Error(), { retryable: false })}
				onDecision={vi.fn()}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [] }}
			/>,
		);

		expect(screen.getByRole("alert").textContent).toBe(
			"权限或申请状态已变化，请刷新页面。",
		);

		rerender(
			<AdminAgentApplicationsScreen
				decisionError={Object.assign(new Error(), { retryable: true })}
				onDecision={vi.fn()}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [] }}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"审批未能提交，请稍后重试。",
		);
	});

	it("renders a decision error only once while a review dialog is open", async () => {
		render(
			<AdminAgentApplicationsScreen
				decisionError={Object.assign(new Error(), { retryable: true })}
				onDecision={vi.fn()}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [pendingApplication] }}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "审阅申请" }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getAllByRole("alert")).toHaveLength(1);
		expect(screen.getAllByRole("alert")).toHaveLength(1);
	});
});
