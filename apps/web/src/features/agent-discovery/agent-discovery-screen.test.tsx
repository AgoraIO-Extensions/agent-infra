import { AgentProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV1 } from "@agent-infra/test-support/pilot";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentDiscoveryScreen } from "./agent-discovery-screen.js";
import { renderWithAgentRouter } from "./test-router.js";

const startingAgent = AgentProjectionV1Schema.parse(
	pilotFakeScenariosV1.starting.response.body,
);

describe("AgentDiscoveryScreen", () => {
	it("renders a visible Agent as a responsive detail link", async () => {
		await renderWithAgentRouter(
			<AgentDiscoveryScreen
				state={{ kind: "ready", agents: [startingAgent] }}
			/>,
		);

		const link = screen.getByRole("link", { name: /Release assistant/ });
		expect(link.getAttribute("href")).toBe("/agents/agent-pilot-1");
		expect(screen.getByText("Starting")).toBeTruthy();
		expect(link.className).toContain("min-w-0");
	});

	it("uses Router navigation for an opaque Agent identifier", async () => {
		const agent = AgentProjectionV1Schema.parse({
			...startingAgent,
			agentId: "agent:tenant/01?draft#one%",
		});

		await renderWithAgentRouter(
			<AgentDiscoveryScreen state={{ kind: "ready", agents: [agent] }} />,
		);

		expect(
			screen
				.getByRole("link", { name: /Release assistant/ })
				.getAttribute("href"),
		).toBe("/agents/agent%3Atenant%2F01%3Fdraft%23one%25");
	});

	it("renders an explicit empty state for an empty visible-Agent response", async () => {
		await renderWithAgentRouter(
			<AgentDiscoveryScreen state={{ kind: "ready", agents: [] }} />,
		);

		expect(screen.getByText("No Agents are available to you.")).toBeTruthy();
	});

	it("renders an unavailable list without stale Agent data", async () => {
		await renderWithAgentRouter(
			<AgentDiscoveryScreen
				state={{
					kind: "unavailable",
					retryable: false,
				}}
			/>,
		);

		expect(screen.getByRole("alert").textContent).toContain(
			"Please contact an administrator.",
		);
		expect(screen.queryByText("Release assistant")).toBeNull();
		expect(screen.queryByText(/forbidden|missing/i)).toBeNull();
	});

	it("renders an explicit loading state", async () => {
		await renderWithAgentRouter(
			<AgentDiscoveryScreen state={{ kind: "loading" }} />,
		);

		expect(
			screen.getByText("Loading Agents...").getAttribute("aria-live"),
		).toBe("polite");
	});
});
