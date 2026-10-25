import {
	createPilotAgentMockServerV2,
	pilotFakeScenariosV2,
} from "@agent-infra/test-support/pilot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createClient } from "../../pilot/generated-v2/client/index.js";
import { client as defaultClient } from "../../pilot/generated-v2/client.gen.js";
import {
	AgentCreationFailureNotice,
	agentCreationFailureMessages,
	loadAgentCreationFailure,
} from "./agent-creation-failure.js";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	defaultClient.setConfig({ baseUrl: "", fetch: globalThis.fetch });
});

function clientWith(
	getAgentCreationFailure: Parameters<
		typeof createPilotAgentMockServerV2
	>[0]["getAgentCreationFailure"],
) {
	const server = createPilotAgentMockServerV2({
		listAgents: { status: 200, body: { items: [], nextCursor: null } },
		getAgent: pilotFakeScenariosV2.starting.response,
		...(getAgentCreationFailure ? { getAgentCreationFailure } : {}),
	});
	return {
		server,
		client: createClient({
			baseUrl: "https://platform.example.test",
			fetch: server.fetch,
		}),
	};
}

describe("Agent creation failure category (#3034)", () => {
	it("reads the category for the requested Agent through the generated client", async () => {
		const { client, server } = clientWith((_request, agentId) => ({
			status: 200,
			body: { schemaVersion: 1, agentId, category: "configuration_rejected" },
		}));
		await expect(
			loadAgentCreationFailure("agent-pilot-1", client),
		).resolves.toBe("configuration_rejected");
		expect(
			server.requests.map((request) => new URL(request.url).pathname),
		).toEqual(["/api/v2/agents/agent-pilot-1/creation-failure"]);
	});

	it("shows nothing when the category is not readable or belongs to another Agent", async () => {
		await expect(
			loadAgentCreationFailure("agent-pilot-1", clientWith(undefined).client),
		).resolves.toBeNull();
		await expect(
			loadAgentCreationFailure(
				"agent-pilot-1",
				clientWith({
					status: 200,
					body: {
						schemaVersion: 1,
						agentId: "agent-other",
						category: "health_check_failed",
					},
				}).client,
			),
		).resolves.toBeNull();
	});

	it.each(
		Object.entries(agentCreationFailureMessages) as [
			keyof typeof agentCreationFailureMessages,
			{ title: string; description: string },
		][],
	)(
		"renders the %s category as an asynchronous status",
		async (category, message) => {
			const { server } = clientWith((_request, agentId) => ({
				status: 200,
				body: { schemaVersion: 1, agentId, category },
			}));
			defaultClient.setConfig({
				baseUrl: "https://platform.example.test",
				fetch: server.fetch,
			});
			render(
				<QueryClientProvider client={new QueryClient()}>
					<AgentCreationFailureNotice agentId="agent-pilot-1" />
				</QueryClientProvider>,
			);
			const status = await screen.findByRole("status");
			expect(status.textContent).toContain(`失败原因：${message.title}`);
			expect(status.textContent).toContain(message.description);
			expect(status.textContent).not.toMatch(/kubernetes|policy|annotation/i);
		},
	);

	// #3268 N8-2-08：PRD §6.3 保留「重试创建」，configuration_rejected 的说明只在调整配置或部署之前
	// 判定重试不会成功（工程 Spec §10.5），不再无条件地说「重试创建不会成功」。
	it("conditions the configuration_rejected retry warning on adjusting the configuration or deployment", () => {
		const { description } = agentCreationFailureMessages.configuration_rejected;
		expect(description).toContain("调整配置或部署之前重试创建不会成功");
		expect(description).toContain("调整部署后再重试创建");
		expect(description).not.toMatch(/[，。]重试创建不会成功/);
	});

	it("renders nothing while the category is unavailable", async () => {
		const { server } = clientWith(undefined);
		defaultClient.setConfig({
			baseUrl: "https://platform.example.test",
			fetch: server.fetch,
		});
		const { container } = render(
			<QueryClientProvider client={new QueryClient()}>
				<AgentCreationFailureNotice agentId="agent-pilot-1" />
			</QueryClientProvider>,
		);
		await waitFor(() => expect(server.requests).toHaveLength(1));
		expect(container.textContent).toBe("");
		expect(screen.queryByRole("status")).toBeNull();
	});

	// #3387：暂时读取失败（503）时抛出，首次读取仍不展示原因；已显示的类别在后台重读失败时保留。
	it("keeps a shown category when a background reread is temporarily unavailable (#3387)", async () => {
		let available = true;
		const { client, server } = clientWith((_request, agentId) =>
			available
				? {
						status: 200,
						body: {
							schemaVersion: 1,
							agentId,
							category: "health_check_failed",
						},
					}
				: {
						status: 503,
						body: {
							schemaVersion: 1,
							code: "DEPENDENCY_UNAVAILABLE",
							message: "Controlled failure",
							retryable: true,
							traceId: "trace-creation-failure-unavailable",
						},
					},
		);
		available = false;
		await expect(
			loadAgentCreationFailure("agent-pilot-1", client),
		).rejects.toMatchObject({ retryable: true });
		available = true;
		defaultClient.setConfig({
			baseUrl: "https://platform.example.test",
			fetch: server.fetch,
		});
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={queryClient}>
				<AgentCreationFailureNotice agentId="agent-pilot-1" />
			</QueryClientProvider>,
		);
		const status = await screen.findByRole("status");
		expect(status.textContent).toContain("失败原因：健康检查未通过");
		available = false;
		await queryClient.refetchQueries();
		await waitFor(() =>
			expect(
				queryClient.getQueryState([
					"agents",
					"agent-pilot-1",
					"creation-failure",
				])?.status,
			).toBe("error"),
		);
		expect(screen.getByRole("status").textContent).toContain(
			"失败原因：健康检查未通过",
		);
	});
});
