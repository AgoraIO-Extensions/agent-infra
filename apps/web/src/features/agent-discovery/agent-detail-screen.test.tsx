import { AgentProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV1 } from "@agent-infra/test-support/pilot";
import { describe, expect, it } from "vitest";

import { AgentDetailScreen } from "./agent-detail-screen.js";
import { renderWithAgentRouter } from "./test-router.js";

const startingAgent = AgentProjectionV1Schema.parse(
	pilotFakeScenariosV1.starting.response.body,
);

describe("AgentDetailScreen", () => {
	it("renders a projected Agent as a responsive read-only detail", async () => {
		const markup = await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent: startingAgent }} />,
		);

		expect(markup).toContain("Release assistant");
		expect(markup).toContain("Helps the release team");
		expect(markup).toContain("Available");
		expect(markup).toContain("Starting");
		expect(markup).toContain("Owner");
		expect(markup).toContain("Channels");
		expect(markup).toContain("Web: available");
		expect(markup).toContain("WeCom bot: not configured");
		expect(markup).toContain("Model options");
		expect(markup).toContain("Primary model");
		expect(markup).toContain("medium, high");
		expect(markup).toContain("Connection actions");
		expect(markup).toContain("github / issues.read (v3)");
		expect(markup).toContain('href="/agents"');
		expect(markup).toContain("sm:flex-row");
		expect(markup).not.toContain("MODEL_API_KEY");
		expect(markup).not.toContain("WORKSPACE_NAME");
		expect(markup).not.toContain("Approve application");
		expect(markup).not.toContain("Owner settings");
	});

	it("renders a server-projected self-managed access entry", async () => {
		const agent = AgentProjectionV1Schema.parse({
			...startingAgent,
			interactionUrl: "https://agent.example.test",
			source: {
				kind: "custom",
				imageReference: "registry.example/agents/pilot@sha256:abc",
				interactionMode: "self-managed",
				identityResponsibility: "self-managed",
			},
		});

		const markup = await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent }} />,
		);

		expect(markup).toContain('href="https://agent.example.test/"');
		expect(markup).toContain("Open Agent");
	});

	it.each([
		"javascript:alert(1)",
		"https://user:password@agent.example.test",
		"https://agent.example.test?access_token=secret",
		"https://agent.example.test/#token=secret",
	])("omits unsafe self-managed access entry %s", async (interactionUrl) => {
		const selfManagedAgent = AgentProjectionV1Schema.parse({
			...startingAgent,
			interactionUrl: "https://agent.example.test",
			source: {
				kind: "custom",
				imageReference: "registry.example/agents/pilot@sha256:abc",
				interactionMode: "self-managed",
				identityResponsibility: "self-managed",
			},
		});
		const agent = { ...selfManagedAgent, interactionUrl };

		const markup = await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent }} />,
		);

		expect(markup).not.toContain("Open Agent");
		expect(markup).not.toContain(interactionUrl);
	});

	it("omits a self-managed access entry from a platform-adapter projection", async () => {
		const agent = AgentProjectionV1Schema.parse({
			...startingAgent,
			interactionUrl: "https://agent.example.test",
			source: {
				kind: "custom",
				imageReference: "registry.example/agents/pilot@sha256:abc",
				interactionMode: "platform-adapter",
			},
		});

		const markup = await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent }} />,
		);

		expect(markup).not.toContain("Open Agent");
		expect(markup).not.toContain("agent.example.test");
	});

	it("renders one opaque unavailable state for a missing or forbidden Agent", async () => {
		const markup = await renderWithAgentRouter(
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

	it("renders an explicit loading state", async () => {
		const markup = await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "loading" }} />,
		);

		expect(markup).toContain("Loading Agent...");
		expect(markup).toContain('aria-live="polite"');
	});
});
