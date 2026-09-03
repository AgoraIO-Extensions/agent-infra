import { AgentProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV1 } from "@agent-infra/test-support/pilot";
import { describe, expect, it } from "vitest";

import { AgentDiscoveryScreen } from "./agent-discovery-screen.js";
import { renderWithAgentRouter } from "./test-router.js";

const startingAgent = AgentProjectionV1Schema.parse(
	pilotFakeScenariosV1.starting.response.body,
);

describe("AgentDiscoveryScreen", () => {
	it("renders a visible Agent as a responsive detail link", async () => {
		const markup = await renderWithAgentRouter(
			<AgentDiscoveryScreen
				state={{ kind: "ready", agents: [startingAgent] }}
			/>,
		);

		expect(markup).toContain("Release assistant");
		expect(markup).toContain("Starting");
		expect(markup).toContain('href="/agents/agent-pilot-1"');
		expect(markup).toContain("sm:flex-row");
		expect(markup).toContain("min-w-0");
	});

	it("uses Router navigation for an opaque Agent identifier", async () => {
		const agent = AgentProjectionV1Schema.parse({
			...startingAgent,
			agentId: "agent:tenant/01?draft#one%",
		});

		const markup = await renderWithAgentRouter(
			<AgentDiscoveryScreen state={{ kind: "ready", agents: [agent] }} />,
		);

		expect(markup).toContain(
			'href="/agents/agent%3Atenant%2F01%3Fdraft%23one%25"',
		);
	});

	it("renders an explicit empty state for an empty visible-Agent response", async () => {
		const markup = await renderWithAgentRouter(
			<AgentDiscoveryScreen state={{ kind: "ready", agents: [] }} />,
		);

		expect(markup).toContain("No Agents are available to you.");
	});

	it("renders an unavailable list without stale Agent data", async () => {
		const markup = await renderWithAgentRouter(
			<AgentDiscoveryScreen
				state={{
					kind: "unavailable",
					retryable: false,
				}}
			/>,
		);

		expect(markup).toContain("Agents are unavailable");
		expect(markup).toContain('role="alert"');
		expect(markup).not.toContain("Release assistant");
		expect(markup).not.toContain("forbidden");
		expect(markup).not.toContain("missing");
	});

	it("renders an explicit loading state", async () => {
		const markup = await renderWithAgentRouter(
			<AgentDiscoveryScreen state={{ kind: "loading" }} />,
		);

		expect(markup).toContain("Loading Agents...");
		expect(markup).toContain('aria-live="polite"');
	});
});
