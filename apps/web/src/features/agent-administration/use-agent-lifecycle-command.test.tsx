import { AgentProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pendingApplication } from "../my-agents/test-fixtures.js";
import { commandAgentLifecycle } from "./agent-administration.js";
import { useAgentLifecycleCommand } from "./use-agent-lifecycle-command.js";

vi.mock("./agent-administration.js", () => ({
	commandAgentLifecycle: vi.fn(),
}));

const lifecycleResult = AgentProjectionV1Schema.parse({
	schemaVersion: 1,
	agentId: "agent-pilot-1",
	name: "Release assistant",
	description: "Helps the release team",
	source: { kind: "standard", templateId: "codex" },
	managementStatus: "available",
	serviceAvailability: "starting",
	configuration: pendingApplication.configuration,
	capabilities: {
		modelSelection: false,
		attachments: false,
		resultFiles: false,
		connection: false,
		supplementaryInstruction: false,
	},
	interactionUrl: null,
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe("useAgentLifecycleCommand", () => {
	it("reuses one idempotency key through an automatic retry", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { retry: 1, retryDelay: 0 } },
		});
		vi.mocked(commandAgentLifecycle)
			.mockRejectedValueOnce(new Error("transient transport failure"))
			.mockResolvedValueOnce(lifecycleResult);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(
			() => useAgentLifecycleCommand(lifecycleResult.agentId),
			{ wrapper },
		);

		await act(async () => {
			await expect(result.current.mutateAsync("restart")).resolves.toEqual(
				lifecycleResult,
			);
		});
		expect(commandAgentLifecycle).toHaveBeenCalledTimes(2);
		expect(commandAgentLifecycle).toHaveBeenNthCalledWith(
			1,
			lifecycleResult.agentId,
			"restart",
			expect.any(String),
		);
		expect(commandAgentLifecycle).toHaveBeenNthCalledWith(
			2,
			lifecycleResult.agentId,
			"restart",
			vi.mocked(commandAgentLifecycle).mock.calls[0]?.[2],
		);
		queryClient.clear();
	});

	it("keeps an in-flight retry bound to its original Agent", async () => {
		vi.useFakeTimers();
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { retry: 1, retryDelay: 50 } },
		});
		vi.mocked(commandAgentLifecycle)
			.mockRejectedValueOnce(new Error("transient transport failure"))
			.mockResolvedValueOnce(lifecycleResult);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result, rerender } = renderHook(
			({ agentId }: { agentId: string }) => useAgentLifecycleCommand(agentId),
			{ initialProps: { agentId: lifecycleResult.agentId }, wrapper },
		);
		let lifecycle: Promise<typeof lifecycleResult> | undefined;

		await act(async () => {
			lifecycle = result.current.mutateAsync("restart");
			await Promise.resolve();
		});
		expect(commandAgentLifecycle).toHaveBeenCalledTimes(1);
		const originalKey = vi.mocked(commandAgentLifecycle).mock.calls[0]?.[2];

		rerender({ agentId: "agent-pilot-next" });
		expect(result.current.isPending).toBe(false);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(50);
		});
		await expect(lifecycle).resolves.toEqual(lifecycleResult);
		expect(commandAgentLifecycle).toHaveBeenNthCalledWith(
			2,
			lifecycleResult.agentId,
			"restart",
			originalKey,
		);
		expect(commandAgentLifecycle).not.toHaveBeenCalledWith(
			"agent-pilot-next",
			expect.anything(),
			expect.anything(),
		);
		await act(async () => {
			await Promise.resolve();
		});
		expect(result.current.data).toBeUndefined();
		queryClient.clear();
	});

	it("reuses an idempotency key when a caller retries after an error", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { retry: 1, retryDelay: 0 } },
		});
		vi.mocked(commandAgentLifecycle)
			.mockRejectedValueOnce(new Error("first transport failure"))
			.mockRejectedValueOnce(new Error("second transport failure"))
			.mockResolvedValueOnce(lifecycleResult);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(
			() => useAgentLifecycleCommand(lifecycleResult.agentId),
			{ wrapper },
		);

		await act(async () => {
			await expect(result.current.mutateAsync("restart")).rejects.toThrow(
				"second transport failure",
			);
		});
		const exhaustedKey = vi.mocked(commandAgentLifecycle).mock.calls[0]?.[2];
		expect(vi.mocked(commandAgentLifecycle).mock.calls[1]?.[2]).toBe(
			exhaustedKey,
		);

		await act(async () => {
			await expect(result.current.mutateAsync("restart")).resolves.toEqual(
				lifecycleResult,
			);
		});
		expect(commandAgentLifecycle).toHaveBeenCalledTimes(3);
		expect(vi.mocked(commandAgentLifecycle).mock.calls[2]?.[2]).toBe(
			exhaustedKey,
		);
		queryClient.clear();
	});

	it("rejects a second lifecycle command while one is in flight", async () => {
		const queryClient = new QueryClient();
		let resolveFirstCommand: (value: typeof lifecycleResult) => void = () =>
			undefined;
		vi.mocked(commandAgentLifecycle)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveFirstCommand = resolve;
					}),
			)
			.mockResolvedValueOnce(lifecycleResult);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(
			() => useAgentLifecycleCommand(lifecycleResult.agentId),
			{ wrapper },
		);
		let firstCommand: Promise<typeof lifecycleResult> | undefined;

		await act(async () => {
			firstCommand = result.current.mutateAsync("stop");
			await Promise.resolve();
			await expect(result.current.mutateAsync("restart")).rejects.toThrow(
				"A lifecycle command is already in progress",
			);
		});
		expect(commandAgentLifecycle).toHaveBeenCalledOnce();

		await act(async () => {
			resolveFirstCommand(lifecycleResult);
		});
		await expect(firstCommand).resolves.toEqual(lifecycleResult);
		queryClient.clear();
	});
});
