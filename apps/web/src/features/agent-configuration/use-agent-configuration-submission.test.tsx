import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentConfigurationUpdateRequestV2Writable } from "../../pilot/generated-v2/types.gen.js";
import {
	replaceAgentDefaultRelayKey,
	updateAgentConfiguration,
	upgradeAgentCustomImage,
} from "./agent-configuration.js";
import { useAgentConfigurationSubmission } from "./use-agent-configuration-submission.js";

vi.mock("./agent-configuration.js", () => ({
	checkAgentDefaultRelayKey: vi.fn(),
	replaceAgentDefaultRelayKey: vi.fn(),
	updateAgentConfiguration: vi.fn(),
	updateAgentSavedModelConfiguration: vi.fn(),
	upgradeAgentCustomImage: vi.fn(),
}));

const configuredAgent = AgentProjectionV2Schema.parse({
	schemaVersion: 2,
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
	schemaVersion: 2,
	coOwnerIds: ["user-owner-1"],
	availability: [],

	modelConfiguration: {
		options: [
			{
				optionId: "model-option-1",
				endpointId: "endpoint-primary",
				modelId: "gpt-5",
				reasoningLevels: ["medium"],
			},
		],
		defaultOptionId: "model-option-1",
		defaultReasoningLevel: "medium",
	},
	environment: [{ name: "LOG_LEVEL", value: "debug" }],
} satisfies AgentConfigurationUpdateRequestV2Writable;

function renderSubmission(queryClient = new QueryClient()) {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	return {
		queryClient,
		...renderHook(
			() => useAgentConfigurationSubmission(configuredAgent.agentId),
			{ wrapper },
		),
	};
}

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

	it("replaces one Secret with its own request and keeps the value out of mutation state (NI-71)", async () => {
		vi.mocked(updateAgentConfiguration).mockResolvedValue(configuredAgent);
		const { queryClient, result } = renderSubmission();
		await act(async () => {
			await result.current.replaceSecret("RELEASE_KEY", "probe-secret-value");
		});
		expect(updateAgentConfiguration).toHaveBeenCalledExactlyOnceWith(
			configuredAgent.agentId,
			{
				schemaVersion: 2,
				secrets: [{ name: "RELEASE_KEY", value: "probe-secret-value" }],
			},
			expect.any(String),
		);
		// 不经过整页 mutation：页面级的进行中、错误与结果都不受影响。
		expect(result.current.isPending).toBe(false);
		expect(result.current.isError).toBe(false);
		expect(
			JSON.stringify(
				queryClient
					.getMutationCache()
					.getAll()
					.map((mutation) => mutation.state.variables),
			),
		).not.toContain("probe-secret-value");
		queryClient.clear();
	});

	it("replaces the default Key with the versions seen at check time (G-09)", async () => {
		vi.mocked(replaceAgentDefaultRelayKey).mockResolvedValue({
			schemaVersion: 1,
			isSet: true,
			keyVersion: 4,
			configurationRevision: 8,
		});
		const { queryClient, result } = renderSubmission();
		await act(async () => {
			await result.current.replaceDefaultRelayKey({
				keyValue: "probe-relay-key",
				configurationRevision: 7,
				expectedVersion: 3,
			});
		});
		expect(replaceAgentDefaultRelayKey).toHaveBeenCalledExactlyOnceWith(
			configuredAgent.agentId,
			{
				configurationRevision: 7,
				expectedVersion: 3,
				keyValue: "probe-relay-key",
			},
		);
		expect(
			JSON.stringify(
				queryClient
					.getMutationCache()
					.getAll()
					.map((mutation) => mutation.state.variables),
			),
		).not.toContain("probe-relay-key");
		queryClient.clear();
	});
});
