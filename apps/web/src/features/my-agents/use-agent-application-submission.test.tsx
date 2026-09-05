import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
	AgentApplicationCreateRequestV1Writable,
	AgentApplicationUpdateRequestV1Writable,
} from "../../pilot/generated/types.gen.js";
import {
	createMyAgentApplication,
	updateMyAgentApplication,
} from "./my-agent-applications.js";
import { pendingApplication } from "./test-fixtures.js";
import { useAgentApplicationSubmission } from "./use-agent-application-submission.js";

vi.mock("./my-agent-applications.js", () => ({
	createMyAgentApplication: vi.fn(),
	updateMyAgentApplication: vi.fn(),
}));

const createBody = {
	schemaVersion: 1,
	name: pendingApplication.name,
	description: pendingApplication.description,
	source: pendingApplication.source,
	coOwnerIds: [],
	availability: [],
	modelConfiguration: {
		options: [
			{
				optionId: "model-option-1",
				endpointId: "model-endpoint-1",
				modelId: "gpt-5",
				reasoningLevels: ["medium"],
			},
		],
		defaultOptionId: "model-option-1",
		defaultReasoningLevel: "medium",
	},
	actions: [],
	environment: [],
	secrets: [],
} satisfies AgentApplicationCreateRequestV1Writable;
const { secrets: _secrets, ...updateBody } = createBody;

const sensitiveCreateBody = {
	...createBody,
	secrets: [{ name: "MODEL_API_KEY", value: "test-secret-value" }],
	modelConfiguration: {
		...createBody.modelConfiguration,
		options: [
			{
				...createBody.modelConfiguration.options[0],
				credentialValue: "test-credential-value",
			},
		],
	},
} satisfies AgentApplicationCreateRequestV1Writable;
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("useAgentApplicationSubmission", () => {
	it("creates a fresh idempotency key for each explicit create or update command", async () => {
		const queryClient = new QueryClient();
		vi.mocked(createMyAgentApplication).mockResolvedValue(pendingApplication);
		vi.mocked(updateMyAgentApplication).mockResolvedValue(pendingApplication);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { rerender, result } = renderHook(
			({ applicationId }: { applicationId?: string }) =>
				useAgentApplicationSubmission(applicationId),
			{
				initialProps: { applicationId: pendingApplication.applicationId },
				wrapper,
			},
		);

		act(() => {
			expect(result.current.create(createBody)).toBeUndefined();
		});
		await waitFor(() =>
			expect(createMyAgentApplication).toHaveBeenCalledOnce(),
		);
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		act(() => {
			expect(
				result.current.update(
					pendingApplication.applicationId,
					updateBody satisfies AgentApplicationUpdateRequestV1Writable,
				),
			).toBeUndefined();
		});
		await waitFor(() => {
			expect(updateMyAgentApplication).toHaveBeenCalledOnce();
		});
		expect(createMyAgentApplication).toHaveBeenCalledWith(
			createBody,
			expect.any(String),
		);
		expect(updateMyAgentApplication).toHaveBeenCalledWith(
			pendingApplication.applicationId,
			updateBody,
			expect.any(String),
		);
		expect(vi.mocked(createMyAgentApplication).mock.calls[0]?.[1]).not.toBe(
			vi.mocked(updateMyAgentApplication).mock.calls[0]?.[2],
		);
		rerender({ applicationId: "application-other" });
		await waitFor(() => expect(result.current.isIdle).toBe(true));
		queryClient.clear();
	});

	it("accepts only one command while a submission is in flight", async () => {
		const queryClient = new QueryClient();
		let resolveFirstSubmission: (value: typeof pendingApplication) => void =
			() => undefined;
		vi.mocked(createMyAgentApplication)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveFirstSubmission = resolve;
					}),
			)
			.mockResolvedValueOnce(pendingApplication);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(() => useAgentApplicationSubmission(), {
			wrapper,
		});

		act(() => {
			result.current.create(createBody);
			result.current.create(createBody);
		});
		await waitFor(() =>
			expect(createMyAgentApplication).toHaveBeenCalledOnce(),
		);

		await act(async () => {
			resolveFirstSubmission(pendingApplication);
		});
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		act(() => result.current.create(createBody));
		await waitFor(() =>
			expect(createMyAgentApplication).toHaveBeenCalledTimes(2),
		);
		expect(vi.mocked(createMyAgentApplication).mock.calls[0]?.[1]).not.toBe(
			vi.mocked(createMyAgentApplication).mock.calls[1]?.[1],
		);
		queryClient.clear();
	});

	it("does not retain sensitive command data in mutation variables", async () => {
		const queryClient = new QueryClient();
		vi.mocked(createMyAgentApplication).mockResolvedValue(pendingApplication);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(() => useAgentApplicationSubmission(), {
			wrapper,
		});

		act(() => result.current.create(sensitiveCreateBody));
		await waitFor(() =>
			expect(createMyAgentApplication).toHaveBeenCalledWith(
				sensitiveCreateBody,
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
});
