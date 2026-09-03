import { AgentProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV1 } from "@agent-infra/test-support/pilot";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentDetailScreen } from "./agent-detail-screen.js";
import { renderWithAgentRouter } from "./test-router.js";

const startingAgent = AgentProjectionV1Schema.parse(
	pilotFakeScenariosV1.starting.response.body,
);

describe("AgentDetailScreen", () => {
	it("renders a projected Agent as a responsive read-only detail", async () => {
		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent: startingAgent }} />,
		);

		expect(
			screen.getByRole("heading", { name: "Release assistant" }),
		).toBeTruthy();
		expect(screen.getByText("Helps the release team")).toBeTruthy();
		expect(screen.getByText("Available")).toBeTruthy();
		expect(screen.getByText("Starting")).toBeTruthy();
		expect(screen.getByText("Owners")).toBeTruthy();
		expect(
			screen.getByText("Web: available, WeCom bot: not configured"),
		).toBeTruthy();
		expect(screen.getByText(/Primary model.*medium, high/)).toBeTruthy();
		expect(screen.getByText("github / issues.read (v3)")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "Back to Agents" }).getAttribute("href"),
		).toBe("/agents");
		expect(screen.queryByText("MODEL_API_KEY")).toBeNull();
		expect(screen.queryByText("WORKSPACE_NAME")).toBeNull();
		expect(screen.queryByText("Approve application")).toBeNull();
		expect(screen.queryByText("Owner settings")).toBeNull();
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

		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent }} />,
		);

		expect(
			screen.getByRole("link", { name: "Open Agent" }).getAttribute("href"),
		).toBe("https://agent.example.test/");
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

		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent }} />,
		);

		expect(screen.queryByRole("link", { name: "Open Agent" })).toBeNull();
		expect(screen.queryByText(interactionUrl)).toBeNull();
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

		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "ready", agent }} />,
		);

		expect(screen.queryByRole("link", { name: "Open Agent" })).toBeNull();
	});

	it("renders one opaque unavailable state for a missing or forbidden Agent", async () => {
		await renderWithAgentRouter(
			<AgentDetailScreen
				state={{
					kind: "unavailable",
					retryable: false,
				}}
			/>,
		);

		expect(screen.getByRole("alert").textContent).toContain(
			"This Agent is unavailable.",
		);
		expect(screen.queryByText("Release assistant")).toBeNull();
		expect(screen.queryByText(/forbidden|missing/i)).toBeNull();
	});

	it("renders an explicit loading state", async () => {
		await renderWithAgentRouter(
			<AgentDetailScreen state={{ kind: "loading" }} />,
		);

		expect(screen.getByText("Loading Agent...").getAttribute("aria-live")).toBe(
			"polite",
		);
	});
});
