import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentApplicationSubmissionScreen } from "./agent-application-submission-screen.js";
import { pendingApplication } from "./test-fixtures.js";
import { renderWithMyAgentsRouter } from "./test-router.js";

describe("AgentApplicationSubmissionScreen", () => {
	it("renders a server-projected create result without exposing request values", async () => {
		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				mode="create"
				onSubmit={vi.fn()}
				result={pendingApplication}
				submitting={false}
			/>,
		);

		expect(
			screen.getByRole("heading", { name: "Create application" }),
		).toBeTruthy();
		expect(screen.getByRole("status").textContent).toBe(
			"Application submitted: Pending approval.",
		);
		expect(
			screen
				.getByRole("link", { name: "Open application" })
				.getAttribute("href"),
		).toBe("/my-agents/application%3Atenant%2F01%3Fdraft%23one%25");
		expect(screen.queryByText("MODEL_API_KEY")).toBeNull();
	});

	it("distinguishes retryable submission errors from changed application state", async () => {
		const first = await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				error={Object.assign(new Error("private transport detail"), {
					retryable: true,
				})}
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"Unable to submit the application. Re-enter any Secret or model credential before trying again.",
		);
		expect(screen.queryByText("private transport detail")).toBeNull();
		first.unmount();

		await renderWithMyAgentsRouter(
			<AgentApplicationSubmissionScreen
				error={Object.assign(new Error("private authorization detail"), {
					retryable: false,
				})}
				mode="create"
				onSubmit={vi.fn()}
				submitting={false}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"This application changed or is unavailable. Refresh the page.",
		);
	});
});
