import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withdrawMyAgentApplication } from "./my-agent-applications.js";
import { pendingApplication } from "./test-fixtures.js";
import { useWithdrawMyAgentApplication } from "./use-withdraw-my-agent-application.js";

vi.mock("./my-agent-applications.js", () => ({
	withdrawMyAgentApplication: vi.fn(),
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe("useWithdrawMyAgentApplication", () => {
	it("reuses one idempotency key through an automatic retry", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { retry: 1, retryDelay: 0 } },
		});
		vi.mocked(withdrawMyAgentApplication)
			.mockRejectedValueOnce(new Error("transient transport failure"))
			.mockResolvedValueOnce(pendingApplication);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(
			() => useWithdrawMyAgentApplication(pendingApplication.applicationId),
			{ wrapper },
		);

		await act(async () => {
			await expect(result.current.mutateAsync()).resolves.toEqual(
				pendingApplication,
			);
		});
		expect(withdrawMyAgentApplication).toHaveBeenCalledTimes(2);
		expect(withdrawMyAgentApplication).toHaveBeenNthCalledWith(
			1,
			pendingApplication.applicationId,
			expect.any(String),
		);
		expect(withdrawMyAgentApplication).toHaveBeenNthCalledWith(
			2,
			pendingApplication.applicationId,
			vi.mocked(withdrawMyAgentApplication).mock.calls[0]?.[1],
		);
		queryClient.clear();
	});

	it("keeps an in-flight retry bound to the application that started it", async () => {
		vi.useFakeTimers();
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { retry: 1, retryDelay: 50 } },
		});
		vi.mocked(withdrawMyAgentApplication)
			.mockRejectedValueOnce(new Error("transient transport failure"))
			.mockResolvedValueOnce(pendingApplication);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result, rerender } = renderHook(
			({ applicationId }: { applicationId: string }) =>
				useWithdrawMyAgentApplication(applicationId),
			{
				initialProps: { applicationId: pendingApplication.applicationId },
				wrapper,
			},
		);
		let withdrawal: Promise<typeof pendingApplication> | undefined;

		await act(async () => {
			withdrawal = result.current.mutateAsync();
			await Promise.resolve();
		});
		expect(withdrawMyAgentApplication).toHaveBeenCalledTimes(1);
		const originalKey = vi.mocked(withdrawMyAgentApplication).mock
			.calls[0]?.[1];

		rerender({ applicationId: "application-pilot-next" });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(50);
		});
		await expect(withdrawal).resolves.toEqual(pendingApplication);
		expect(withdrawMyAgentApplication).toHaveBeenNthCalledWith(
			2,
			pendingApplication.applicationId,
			originalKey,
		);
		expect(withdrawMyAgentApplication).not.toHaveBeenCalledWith(
			"application-pilot-next",
			expect.any(String),
		);
		queryClient.clear();
	});

	it("reuses an idempotency key when a caller retries after an error", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { retry: 1, retryDelay: 0 } },
		});
		vi.mocked(withdrawMyAgentApplication)
			.mockRejectedValueOnce(new Error("first transport failure"))
			.mockRejectedValueOnce(new Error("second transport failure"))
			.mockResolvedValueOnce(pendingApplication);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(
			() => useWithdrawMyAgentApplication(pendingApplication.applicationId),
			{ wrapper },
		);

		await act(async () => {
			await expect(result.current.mutateAsync()).rejects.toThrow(
				"second transport failure",
			);
		});
		expect(withdrawMyAgentApplication).toHaveBeenCalledTimes(2);
		const exhaustedKey = vi.mocked(withdrawMyAgentApplication).mock
			.calls[0]?.[1];
		expect(vi.mocked(withdrawMyAgentApplication).mock.calls[1]?.[1]).toBe(
			exhaustedKey,
		);

		await act(async () => {
			await expect(result.current.mutateAsync()).resolves.toEqual(
				pendingApplication,
			);
		});
		expect(withdrawMyAgentApplication).toHaveBeenCalledTimes(3);
		expect(vi.mocked(withdrawMyAgentApplication).mock.calls[2]?.[1]).toBe(
			exhaustedKey,
		);
		queryClient.clear();
	});

	it("clears a terminal withdrawal error when the route application changes", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { retry: false } },
		});
		vi.mocked(withdrawMyAgentApplication).mockRejectedValueOnce(
			new Error("withdrawal failed"),
		);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result, rerender } = renderHook(
			({ applicationId }: { applicationId: string }) =>
				useWithdrawMyAgentApplication(applicationId),
			{
				initialProps: { applicationId: pendingApplication.applicationId },
				wrapper,
			},
		);

		await act(async () => {
			await expect(result.current.mutateAsync()).rejects.toThrow(
				"withdrawal failed",
			);
		});
		await waitFor(() => expect(result.current.isError).toBe(true));

		rerender({ applicationId: "application-pilot-next" });
		await waitFor(() => expect(result.current.isError).toBe(false));
		expect(result.current.error).toBeNull();
		queryClient.clear();
	});
});
