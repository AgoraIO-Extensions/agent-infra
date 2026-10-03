import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pendingApplication } from "../my-agents/test-fixtures.js";
import { decideAgentApplication } from "./agent-administration.js";
import { useAgentApplicationDecision } from "./use-agent-application-decision.js";

vi.mock("./agent-administration.js", () => ({
	decideAgentApplication: vi.fn(),
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("useAgentApplicationDecision", () => {
	it("rejects a conflicting decision while one is in flight", async () => {
		const queryClient = new QueryClient();
		let resolveFirstDecision: (value: typeof pendingApplication) => void = () =>
			undefined;
		vi.mocked(decideAgentApplication)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveFirstDecision = resolve;
					}),
			)
			.mockResolvedValueOnce(pendingApplication);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(() => useAgentApplicationDecision(), {
			wrapper,
		});
		let firstDecision: Promise<typeof pendingApplication> | undefined;

		await act(async () => {
			firstDecision = result.current.mutateAsync(
				pendingApplication.applicationId,
				{ decision: "approve" },
			);
			await Promise.resolve();
			await expect(
				result.current.mutateAsync(pendingApplication.applicationId, {
					decision: "reject",
					reason: "Needs more information",
				}),
			).rejects.toThrow("An application decision is already in progress");
		});
		expect(decideAgentApplication).toHaveBeenCalledOnce();

		await act(async () => {
			resolveFirstDecision(pendingApplication);
		});
		await expect(firstDecision).resolves.toEqual(pendingApplication);
		queryClient.clear();
	});
});
