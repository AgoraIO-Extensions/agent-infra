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
				declaredActionVersionIds: ["github.get_pull_request_review@v7"],
			},
			{
				actions: [
					{
						description: "Query data",
						effect: "READ" as const,
						id: "datalego.query@v1",
						name: "datalego.query",
						requiredScopes: [],
					},
				],
				providerId: "datalego",
				providerReleaseId: "datalego-release-v1",
				declaredActionVersionIds: [],
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
	fireEvent.click(screen.getByRole("button", { name: "保存能力配置" }));

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

function renderPage() {
	render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<PatConsumersPage />
		</QueryClientProvider>,
	);
}

it("shows saved capabilities and restores selections when switching Providers", async () => {
	renderPage();
	await screen.findByText("github · 1 项");
	fireEvent.click(screen.getByRole("button", { name: "配置能力" }));
	await screen.findByRole("heading", {
		name: "配置 Connection E2E Reviewer 能力",
	});
	await waitFor(() =>
		expect(
			(screen.getAllByRole("checkbox")[0] as HTMLInputElement).checked,
		).toBe(true),
	);
	expect((screen.getAllByRole("checkbox")[1] as HTMLInputElement).checked).toBe(
		false,
	);
	fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), {
		target: { value: "datalego-release-v1" },
	});
	await screen.findByText(
		"当前 Provider 未配置能力，用户暂时无法授权，请勾选后保存。",
	);
	expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
		false,
	);
	fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), {
		target: { value: "github-release-v7" },
	});
	await waitFor(() =>
		expect(
			(screen.getAllByRole("checkbox")[0] as HTMLInputElement).checked,
		).toBe(true),
	);
});

it("continues registration directly into capability configuration", async () => {
	api.registerPatConsumer.mockResolvedValueOnce({
		issued: { secret: "fake-once" },
	});
	renderPage();
	fireEvent.change(screen.getByLabelText("Consumer ID"), {
		target: { value: "new-agent" },
	});
	fireEvent.change(screen.getByLabelText("Agent 名称"), {
		target: { value: "New Agent" },
	});
	fireEvent.change(screen.getByLabelText("Callback URL"), {
		target: { value: "https://agent.example/callback" },
	});
	fireEvent.click(screen.getByRole("button", { name: "注册 Agent" }));
	await screen.findByText(
		"Agent 已注册，请继续在下方配置能力，完成后用户才能授权。",
	);
	await waitFor(() =>
		expect(api.getConsumerDeclarationOptions).toHaveBeenCalledWith("new-agent"),
	);
});
