import { AgentProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentConfigurationUpdateRequestV1Writable } from "../../pilot/generated/types.gen.js";
import {
	updateAgentConfiguration,
	upgradeAgentCustomImage,
} from "./agent-configuration.js";
import { useAgentConfigurationSubmission } from "./use-agent-configuration-submission.js";

vi.mock("./agent-configuration.js", () => ({
	updateAgentConfiguration: vi.fn(),
	upgradeAgentCustomImage: vi.fn(),
}));

const configuredAgent = AgentProjectionV1Schema.parse({
	schemaVersion: 1,
	agentId: "agent-configuration-1",
	name: "Configuration assistant",
	description: "Helps the release team",
	source: { kind: "standard", templateId: "codex" },
	managementStatus: "available",
	serviceAvailability: "ready",
	configuration: {
		owners: [
			{
				userId: "user-owner-1",
				displayName: "Owner",
				roles: ["employee"],
			},
		],
		availability: [],
		modelOptions: [],
		defaultModelOptionId: null,
		defaultReasoningLevel: null,
		actions: [],
		environment: [],
		channels: [],
		secrets: [],
	},
	capabilities: {
		modelSelection: true,
		attachments: false,
		resultFiles: false,
		connection: false,
		supplementaryInstruction: false,
	},
	interactionUrl: null,
});
const body = {
	schemaVersion: 1,
	coOwnerIds: ["user-owner-1"],
	availability: [],
	actions: [],
	modelConfiguration: {
		options: [
			{
				optionId: "model-option-1",
				endpointId: "endpoint-primary",
				modelId: "gpt-5",
				reasoningLevels: ["medium"],
				credentialValue: "test-credential-value",
			},
		],
		defaultOptionId: "model-option-1",
		defaultReasoningLevel: "medium",
	},
	secrets: [{ name: "MODEL_API_KEY", value: "test-secret-value" }],
} satisfies AgentConfigurationUpdateRequestV1Writable;

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("useAgentConfigurationSubmission", () => {
	it("does not retain configuration Secrets or credentials in mutation variables", async () => {
		const queryClient = new QueryClient();
		vi.mocked(updateAgentConfiguration).mockResolvedValue(configuredAgent);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(
			() => useAgentConfigurationSubmission(configuredAgent.agentId),
			{ wrapper },
		);

		act(() => result.current.saveConfiguration(body));
		await waitFor(() =>
			expect(updateAgentConfiguration).toHaveBeenCalledWith(
				configuredAgent.agentId,
				body,
				expect.any(String),
			),
		);
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		const mutationVariables = queryClient
			.getMutationCache()
			.getAll()
			.map((mutation) => mutation.state.variables);
		expect(JSON.stringify(mutationVariables)).not.toContain(
			"test-secret-value",
		);
		expect(JSON.stringify(mutationVariables)).not.toContain(
			"test-credential-value",
		);
		queryClient.clear();
	});

	it("accepts only one configuration or image command while one is in flight", async () => {
		const queryClient = new QueryClient();
		let resolveConfiguration: (value: typeof configuredAgent) => void = () =>
			undefined;
		vi.mocked(updateAgentConfiguration).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveConfiguration = resolve;
				}),
		);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(
			() => useAgentConfigurationSubmission(configuredAgent.agentId),
			{ wrapper },
		);

		act(() => {
			result.current.saveConfiguration(body);
			result.current.upgradeImage("registry.example/agents/release:2");
		});
		await waitFor(() =>
			expect(updateAgentConfiguration).toHaveBeenCalledOnce(),
		);
		expect(upgradeAgentCustomImage).not.toHaveBeenCalled();

		await act(async () => {
			resolveConfiguration(configuredAgent);
		});
		queryClient.clear();
	});
});
