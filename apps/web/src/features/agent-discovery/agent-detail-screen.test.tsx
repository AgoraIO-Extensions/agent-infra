import { AgentProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV1 } from "@agent-infra/test-support/pilot";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentDetailScreen } from "./agent-detail-screen.js";

const startingAgent = AgentProjectionV1Schema.parse(
	pilotFakeScenariosV1.starting.response.body,
);

describe("AgentDetailScreen", () => {
	it("renders a projected Agent as a responsive read-only detail", () => {
		const markup = renderToStaticMarkup(
			<AgentDetailScreen state={{ kind: "ready", agent: startingAgent }} />,
		);

		expect(markup).toContain("Release assistant");
		expect(markup).toContain("Helps the release team");
		expect(markup).toContain("Available");
		expect(markup).toContain("Starting");
		expect(markup).toContain('href="/agents"');
		expect(markup).toContain("sm:flex-row");
		expect(markup).not.toContain("Approve application");
		expect(markup).not.toContain("Owner settings");
	});

	it("renders one opaque unavailable state for a missing or forbidden Agent", () => {
		const markup = renderToStaticMarkup(
			<AgentDetailScreen
				state={{
					kind: "unavailable",
					retryable: false,
				}}
			/>,
		);

		expect(markup).toContain("Agent is unavailable");
		expect(markup).toContain('role="alert"');
		expect(markup).not.toContain("Release assistant");
		expect(markup).not.toContain("forbidden");
		expect(markup).not.toContain("missing");
	});

	it("renders an explicit loading state", () => {
		const markup = renderToStaticMarkup(
			<AgentDetailScreen state={{ kind: "loading" }} />,
		);

		expect(markup).toContain("Loading Agent...");
		expect(markup).toContain('aria-live="polite"');
	});
});
