import { BrowserSessionProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
	it("renders the server-projected pending application with responsive approve and reject controls", () => {
		const onDecision = vi.fn();
		render(
			<AdminAgentApplicationsScreen
				onDecision={onDecision}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [pendingApplication] }}
			/>,
		);

		expect(
			screen.getByRole("heading", { name: "Agent approvals" }),
		).toBeTruthy();
		expect(screen.getByText("Pending approval")).toBeTruthy();
		expect(screen.getByText("Small")).toBeTruthy();
		expect(screen.getByText(/250m CPU/)).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Approve application" }),
		).toBeTruthy();
		expect(screen.getByLabelText("Rejection reason")).toBeTruthy();
		expect(
			screen
				.getByRole("button", { name: "Reject application" })
				.getAttribute("disabled"),
		).not.toBeNull();
		expect(
			screen.getByText("Release assistant request").closest("li")?.className,
		).toContain("sm:flex-row");

		fireEvent.click(
			screen.getByRole("button", { name: "Approve application" }),
		);
		expect(onDecision).toHaveBeenLastCalledWith(
			pendingApplication.applicationId,
			{ decision: "approve" },
		);

		fireEvent.change(screen.getByLabelText("Rejection reason"), {
			target: { value: "Capacity is not available." },
		});
		fireEvent.click(screen.getByRole("button", { name: "Reject application" }));
		expect(onDecision).toHaveBeenLastCalledWith(
			pendingApplication.applicationId,
			{ decision: "reject", reason: "Capacity is not available." },
		);
	});

	it("does not render application data or controls for an ordinary-user projection", () => {
		render(
			<AdminAgentApplicationsScreen
				onDecision={vi.fn()}
				session={{ kind: "ready", session: ordinaryUserSession }}
				state={{ kind: "ready", applications: [pendingApplication] }}
			/>,
		);

		expect(screen.getByRole("alert").textContent).toBe(
			"Approvals are unavailable.",
		);
		expect(screen.queryByText("Release assistant request")).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Approve application" }),
		).toBeNull();
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

		expect(screen.getByRole("button", { name: "Approving..." })).toBeTruthy();

		rerender(
			<AdminAgentApplicationsScreen
				decisionResult={approvedApplication}
				onDecision={vi.fn()}
				session={{ kind: "ready", session: administratorSession }}
				state={{ kind: "ready", applications: [] }}
			/>,
		);
		expect(screen.getByRole("status").textContent).toBe(
			"Decision submitted for Release assistant request: Creating.",
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
			"Your permission or this application changed. Refresh the page.",
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
			"Unable to submit the application decision. Please try again shortly.",
		);
	});
});
