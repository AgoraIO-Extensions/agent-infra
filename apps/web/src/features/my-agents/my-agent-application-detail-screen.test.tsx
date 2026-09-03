import { AgentApplicationProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MyAgentApplicationDetailScreen } from "./my-agent-application-detail-screen.js";
import { pendingApplication } from "./test-fixtures.js";
import { renderWithMyAgentsRouter } from "./test-router.js";

describe("MyAgentApplicationDetailScreen", () => {
	it("renders a pending projection and lets the applicant withdraw it", async () => {
		const onWithdraw = vi.fn();
		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={onWithdraw}
				state={{ kind: "ready", application: pendingApplication }}
				withdrawing={false}
			/>,
		);

		expect(
			screen.getByRole("heading", { name: "Release assistant request" }),
		).toBeTruthy();
		expect(screen.getByText("Pending approval")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "Back to My Agents" }).getAttribute("href"),
		).toBe("/my-agents");
		fireEvent.click(screen.getByRole("button", { name: "Withdraw application" }));
		expect(onWithdraw).toHaveBeenCalledOnce();
		expect(screen.queryByRole("link", { name: "Open Agent" })).toBeNull();
		expect(screen.queryByText("MODEL_API_KEY")).toBeNull();
		expect(screen.queryByText("Owner settings")).toBeNull();
		expect(screen.queryByText("Approve application")).toBeNull();
	});

	it("renders a rejected application history without lifecycle controls", async () => {
		const rejectedApplication = AgentApplicationProjectionV1Schema.parse({
			...pendingApplication,
			applicationId: "application-pilot-rejected",
			status: "rejected",
			decision: {
				decidedAt: "2026-09-03T09:00:00Z",
				reason: "Resource capacity is currently unavailable.",
			},
		});
		await renderWithMyAgentsRouter(
			<MyAgentApplicationDetailScreen
				onWithdraw={vi.fn()}
				state={{ kind: "ready", application: rejectedApplication }}
				withdrawing={false}
			/>,
		);

		expect(screen.getByText("Rejected")).toBeTruthy();
		expect(screen.getByText("Decision reason")).toBeTruthy();
		expect(
			screen.getByText("Resource capacity is currently unavailable."),
		).toBeTruthy();
		expect(screen.getByText("Submitted")).toBeTruthy();
		expect(screen.getByText("2026-09-03T08:00:00Z").tagName).toBe("TIME");
		expect(
			screen.queryByRole("button", { name: "Withdraw application" }),
		).toBeNull();
		expect(screen.queryByText(/retry|owner settings/i)).toBeNull();
	});
});
