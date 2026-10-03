import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "../../pilot/generated-v2/client.gen.js";
import { useAgentDetail } from "./use-agent-detail.js";

const original = client.getConfig();
const starting = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);
const queries: QueryClient[] = [];
afterEach(() => {
	cleanup();
	for (const query of queries.splice(0)) query.clear();
	client.setConfig(original);
	vi.useRealTimers();
});

describe("Agent detail lifecycle refresh", () => {
	it.each([200, 403, 503])(
		"refreshes a starting Agent and stops after response %s",
		async (status) => {
			let reads = 0;
			client.setConfig({
				baseUrl: "https://platform.example.test",
				fetch: async () => {
					reads += 1;
					if (reads === 1) return Response.json(starting);
					return status === 200
						? Response.json({ ...starting, serviceAvailability: "ready" })
						: Response.json({ retryable: status === 503 }, { status });
				},
			});
			const queryClient = new QueryClient();
			queries.push(queryClient);
			const wrapper = ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={queryClient}>
					{children}
				</QueryClientProvider>
			);
			vi.useFakeTimers();
			const { result } = renderHook(
				() => {
					const query = useAgentDetail(starting.agentId);
					return { data: query.data, isError: query.isError };
				},
				{ wrapper },
			);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(20);
			});
			expect(result.current.data).toMatchObject({
				kind: "ready",
				agent: { serviceAvailability: "starting" },
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2100);
			});
			expect(reads).toBe(2);
			if (status === 200)
				expect(result.current.data).toMatchObject({
					kind: "ready",
					agent: { serviceAvailability: "ready" },
				});
			else if (status === 403)
				expect(result.current.data).toMatchObject({ kind: "unavailable" });
			else expect(result.current.isError).toBe(true);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(10000);
			});
			expect(reads).toBe(2);
		},
	);
});
