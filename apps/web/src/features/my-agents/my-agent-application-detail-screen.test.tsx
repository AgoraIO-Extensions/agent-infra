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
});
