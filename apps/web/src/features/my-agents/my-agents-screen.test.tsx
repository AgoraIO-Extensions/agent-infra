import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MyAgentsScreen } from "./my-agents-screen.js";
import { creatingApplication, pendingApplication } from "./test-fixtures.js";
import { renderWithMyAgentsRouter } from "./test-router.js";

describe("MyAgentsScreen", () => {
	it("renders projected statuses responsively and links only an emitted Agent ID", async () => {
		await renderWithMyAgentsRouter(
			<MyAgentsScreen
				state={{
					kind: "ready",
					applications: [pendingApplication, creatingApplication],
				}}
			/>,
		);

		const pendingLink = screen.getByRole("link", {
			name: /^Release assistant request/,
		});
		expect(pendingLink.getAttribute("href")).toBe(
			"/my-agents/application%3Atenant%2F01%3Fdraft%23one%25",
		);
		expect(pendingLink.closest("li")?.className).toContain("sm:flex-row");
		expect(screen.getByText("Pending approval")).toBeTruthy();
		expect(screen.getByText("Creating")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "Open Agent" }).getAttribute("href"),
		).toBe("/agents/agent-pilot-2");
		expect(screen.getAllByRole("link", { name: "Open Agent" })).toHaveLength(1);
	});

	it("renders an explicit empty current applicant history", async () => {
		await renderWithMyAgentsRouter(
			<MyAgentsScreen state={{ kind: "ready", applications: [] }} />,
		);

		expect(screen.getByText("No Agent applications yet.")).toBeTruthy();
		expect(
			screen
				.getByRole("link", { name: "Create application" })
				.getAttribute("href"),
		).toBe("/my-agents/new");
	});

	it("renders an unavailable history without stale or enumerating data", async () => {
		await renderWithMyAgentsRouter(
			<MyAgentsScreen state={{ kind: "unavailable", retryable: false }} />,
		);

		expect(screen.getByRole("alert").textContent).toContain(
			"Please contact an administrator.",
		);
		expect(screen.queryByText("Release assistant request")).toBeNull();
		expect(screen.queryByText(/forbidden|missing/i)).toBeNull();
	});

	it("renders a retryable current applicant history failure", async () => {
		await renderWithMyAgentsRouter(
			<MyAgentsScreen state={{ kind: "unavailable", retryable: true }} />,
		);

		expect(screen.getByRole("alert").textContent).toBe(
			"Please try again shortly.",
		);
	});
});
