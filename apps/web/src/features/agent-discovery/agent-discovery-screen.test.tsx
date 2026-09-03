import { AgentProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV1 } from "@agent-infra/test-support/pilot";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentDiscoveryScreen } from "./agent-discovery-screen.js";

const startingAgent = AgentProjectionV1Schema.parse(
	pilotFakeScenariosV1.starting.response.body,
);

describe("AgentDiscoveryScreen", () => {
	it("renders a visible Agent as a responsive detail link", () => {
		const markup = renderToStaticMarkup(
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

	it("renders an explicit empty state for an empty visible-Agent response", () => {
		const markup = renderToStaticMarkup(
			<AgentDiscoveryScreen state={{ kind: "ready", agents: [] }} />,
		);

		expect(markup).toContain("No Agents are available to you.");
	});

	it("renders an unavailable list without stale Agent data", () => {
		const markup = renderToStaticMarkup(
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

	it("renders an explicit loading state", () => {
		const markup = renderToStaticMarkup(
			<AgentDiscoveryScreen state={{ kind: "loading" }} />,
		);

		expect(markup).toContain("Loading Agents...");
		expect(markup).toContain('aria-live="polite"');
	});
});
