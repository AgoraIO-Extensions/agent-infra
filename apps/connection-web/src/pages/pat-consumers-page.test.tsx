// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { PatConsumersPage } from "./pat-consumers-page";

const api = vi.hoisted(() => ({
	disablePatConsumer: vi.fn(async () => undefined),
	getConsumerDeclarationOptions: vi.fn(async () => ({
		consumer: {
			id: "consumer-connection-e2e-reviewer",
			name: "Connection E2E Reviewer",
		},
		providers: [
			{
				actions: [
					{
						description: "Read pull request reviews",
						effect: "READ" as const,
						id: "github.get_pull_request_review@v7",
						name: "github.get_pull_request_review",
						requiredScopes: ["repo"],
					},
					{
						description: "Create a pull request review",
						effect: "WRITE" as const,
						id: "github.create_pull_request_review@v7",
						name: "github.create_pull_request_review",
						requiredScopes: ["repo"],
					},
				],
				providerId: "github",
				providerReleaseId: "github-release-v7",
			},
		],
	})),
	listPatConsumers: vi.fn(async () => ({
		consumers: [
			{
				callbackUrl: "https://agent.example/callback",
				consumerId: "consumer-connection-e2e-reviewer",
				consumerName: "Connection E2E Reviewer",
				status: "ACTIVE" as const,
			},
		],
	})),
	publishConsumerDeclaration: vi.fn(async () => ({
		declarationId: "declaration-reviewer",
	})),
	registerPatConsumer: vi.fn(),
}));

vi.mock("../api", () => ({ connectionApi: api }));
vi.mock("../shell", () => ({
	ConsoleShell: ({ children }: { children: ReactNode }) => <>{children}</>,
	PageError: () => null,
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

it("publishes a filtered ActionVersion selection for a registered Consumer", async () => {
	render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<PatConsumersPage />
		</QueryClientProvider>,
	);

	fireEvent.click(await screen.findByRole("button", { name: "配置能力" }));
	await screen.findByRole("heading", {
		name: "配置 Connection E2E Reviewer 能力",
	});
	fireEvent.change(screen.getByRole("combobox", { name: "能力类型" }), {
		target: { value: "READ" },
	});
	fireEvent.click(screen.getByRole("button", { name: "选择当前结果" }));
	expect(screen.getByText("1 项")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "发布 Declaration" }));

	await waitFor(() =>
		expect(api.publishConsumerDeclaration).toHaveBeenCalledWith(
			"consumer-connection-e2e-reviewer",
			{
				actionVersionIds: ["github.get_pull_request_review@v7"],
				providerReleaseId: "github-release-v7",
			},
		),
	);
});
