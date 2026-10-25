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

function renderDetail() {
	const queryClient = new QueryClient();
	queries.push(queryClient);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	return renderHook(
		() => {
			const query = useAgentDetail(starting.agentId);
			return { data: query.data, isError: query.isError };
		},
		{ wrapper },
	);
}

describe("Agent detail lifecycle refresh", () => {
	// 需求变化（#3418 N14-04）：轮询遇到可重试的 503 后不再停止，改由下面的用例断言继续轮询直到就绪；
	// 200（读到就绪即停止）与 403（不可重试即停止）的断言不变。
	it.each([200, 403])(
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
			else expect(result.current.data).toMatchObject({ kind: "unavailable" });
			await act(async () => {
				await vi.advanceTimersByTimeAsync(10000);
			});
			expect(reads).toBe(2);
		},
	);

	it("keeps polling a starting Agent after a retryable 503 until it is ready (#3418 N14-04)", async () => {
		let reads = 0;
		client.setConfig({
			baseUrl: "https://platform.example.test",
			fetch: async () => {
				reads += 1;
				if (reads === 1) return Response.json(starting);
				if (reads === 2)
					return Response.json({ retryable: true }, { status: 503 });
				return Response.json({ ...starting, serviceAvailability: "ready" });
			},
		});
		vi.useFakeTimers();
		const { result } = renderDetail();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(20);
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2100);
		});
		// 一次可重试失败：继续显示上一次读到的「启动中」，不停止轮询。
		expect(reads).toBe(2);
		expect(result.current.isError).toBe(true);
		expect(result.current.data).toMatchObject({
			kind: "ready",
			agent: { serviceAvailability: "starting" },
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2100);
		});
		expect(reads).toBe(3);
		expect(result.current.data).toMatchObject({
			kind: "ready",
			agent: { serviceAvailability: "ready" },
		});
		// 读到就绪后停止。
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10000);
		});
		expect(reads).toBe(3);
	});
});
