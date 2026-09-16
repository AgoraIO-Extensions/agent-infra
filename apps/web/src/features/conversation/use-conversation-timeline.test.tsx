import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "../../pilot/generated-v2/client/index.js";
import {
	deferred,
	event,
	execution,
	history,
	reload,
	route,
	sse,
} from "./conversation-test-fixtures.js";
import { useConversationTimeline } from "./use-conversation-timeline.js";

type Selection = {
	conversationId: string;
	executionId?: string;
	identityKey: string;
};
const initialSelection: Selection = {
	conversationId: "conversation-1",
	executionId: "execution-1",
	identityKey: "test-login-1",
};
const queryClients: QueryClient[] = [];

function setup(
	handler: (request: Request) => Response | Promise<Response>,
	selection = initialSelection,
	queryClient = new QueryClient({ defaultOptions: { queries: { retry: 3 } } }),
) {
	queryClients.push(queryClient);
	const requests: Request[] = [];
	const seen: unknown[] = [];
	const client = createClient({
		baseUrl: "https://platform.example.test",
		fetch: async (input, init) => {
			const request = new Request(input, init);
			requests.push(request);
			return handler(request);
		},
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	const hook = renderHook(
		(props: Selection) => {
			const value = useConversationTimeline({ ...props, client });
			seen.push({ timeline: value.timeline, detail: value.execution.data });
			return value;
		},
		{ wrapper, initialProps: selection },
	);
	return { ...hook, queryClient, requests, seen };
}

function cachedDetails(queryClient: QueryClient) {
	return queryClient
		.getQueryCache()
		.findAll({ queryKey: ["conversation-execution-detail"] })
		.map((query) => query.state.data)
		.filter((data) => data !== undefined);
}

function revoked() {
	return {
		schemaVersion: 1,
		kind: "control",
		type: "authorization.revoked",
		error: {
			schemaVersion: 1,
			code: "AUTHORIZATION_REVOKED",
			message: "Access revoked",
			retryable: false,
			traceId: "trace-1",
		},
	};
}

afterEach(() => {
	cleanup();
	for (const client of queryClients.splice(0)) client.clear();
});

describe("Conversation execution detail Query ownership", () => {
	it("refreshes selected operation facts without refetching on each text delta and supports explicit refresh", async () => {
		const stream = sse();
		let detailRevision = 0;
		let streamCount = 0;
		const { result, requests } = setup((request) => {
			if (route(request) === "stream")
				return ++streamCount === 1 ? stream.response : sse().response;
			if (route(request) === "execution")
				return Response.json({
					...execution(),
					processSummary: detailRevision
						? [
								{
									kind: "agent_summary",
									category: "model_call",
									occurredAt: "2026-09-15T10:00:00Z",
									summary: `Revision ${detailRevision}`,
								},
							]
						: [],
				});
			return Response.json(history());
		});
		await waitFor(() => expect(result.current.execution.isSuccess).toBe(true));
		act(() => stream.send(event(2)));
		await waitFor(() => expect(result.current.timeline.events.length).toBe(2));
		expect(
			requests.filter((request) => route(request) === "execution"),
		).toHaveLength(1);
		detailRevision = 1;
		act(() =>
			stream.send({
				...event(3),
				schemaVersion: 2,
				type: "execution.operation",
				payload: {
					kind: "model",
					operationRef: "op-1",
					attemptRef: "attempt-1",
					phase: "completed",
					durationMs: 17,
					model: {
						modelId: "model-1",
						modelOptionId: "option-1",
						configVersion: "version-1",
					},
				},
			}),
		);
		await waitFor(() =>
			expect(result.current.execution.data?.processSummary[0]?.summary).toBe(
				"Revision 1",
			),
		);
		detailRevision = 2;
		await act(async () => {
			await result.current.refresh();
		});
		await waitFor(() =>
			expect(result.current.execution.data?.processSummary[0]?.summary).toBe(
				"Revision 2",
			),
		);
		expect(requests.every((request) => request.method === "GET")).toBe(true);
	});

	it("exposes Query loading and its original execution result without copying detail into the timeline", async () => {
		const stream = sse();
		const pending = deferred<Response>();
		const { result, queryClient, requests } = setup((request) => {
			if (route(request) === "stream") return stream.response;
			return route(request) === "execution"
				? pending.promise
				: Response.json(history());
		});
		await waitFor(() => expect(result.current.execution.isFetching).toBe(true));
		expect(result.current.execution.data).toBeUndefined();
		expect(result.current.timeline).not.toHaveProperty("execution");
		expect(cachedDetails(queryClient)).toEqual([]);
		await act(async () => pending.resolve(Response.json(execution())));
		await waitFor(() => expect(result.current.execution.isSuccess).toBe(true));
		expect(result.current.execution.data).toEqual(execution());
		expect(cachedDetails(queryClient)).toEqual([result.current.execution.data]);
		expect(route(requests[0])).toBe("history");
		expect(requests.slice(1).map(route).sort()).toEqual([
			"execution",
			"stream",
		]);
		expect(requests.every((request) => request.method === "GET")).toBe(true);
	});

	it.each(["network", "service"] as const)(
		"lets Query own %s error and an explicit refetch",
		async (kind) => {
			const stream = sse();
			let fail = true;
			const { result, requests } = setup((request) => {
				if (route(request) === "stream") return stream.response;
				if (route(request) === "execution" && fail) {
					if (kind === "network")
						throw new TypeError("Synthetic network failure");
					return new Response("Unavailable", { status: 503 });
				}
				return Response.json(
					route(request) === "execution" ? execution() : history(),
				);
			});
			await waitFor(() => expect(result.current.execution.isError).toBe(true));
			expect(result.current.execution.error).toMatchObject({
				failure: kind === "network" ? { kind } : { kind, status: 503 },
			});
			expect(result.current.execution.data).toBeUndefined();
			expect(result.current.timeline.status).toBe("ready");
			expect(
				requests.filter((request) => route(request) === "execution"),
			).toHaveLength(1);
			fail = false;
			await act(async () => {
				await result.current.execution.refetch();
			});
			await waitFor(() =>
				expect(result.current.execution.isSuccess).toBe(true),
			);
		},
	);

	for (const endpoint of ["history", "execution", "stream"] as const) {
		it.each([401, 403, 404])(
			`purges cached details and stops on ${endpoint} HTTP %s`,
			async (status) => {
				const stream = sse();
				let deny = false;
				const { result, queryClient, requests } = setup((request) => {
					if (deny && route(request) === endpoint)
						return new Response("Unavailable", { status });
					if (route(request) === "stream") return stream.response;
					return Response.json(
						route(request) === "execution" ? execution() : history(),
					);
				});
				queryClient.setQueryData(["unrelated"], "preserve");
				await waitFor(() =>
					expect(result.current.execution.isSuccess).toBe(true),
				);
				deny = true;
				await act(async () => {
					if (endpoint === "history") stream.send(reload());
					else if (endpoint === "execution")
						await result.current.execution.refetch();
					else await result.current.reconnect();
				});
				await waitFor(() =>
					expect(result.current.timeline.status).toBe("denied"),
				);
				expect(result.current.timeline).toMatchObject({
					history: null,
					events: [],
					failure: { kind: "authorization", status },
				});
				expect(result.current.execution.data).toBeUndefined();
				expect(cachedDetails(queryClient)).toEqual([]);
				expect(queryClient.getQueryData(["unrelated"])).toBe("preserve");
				const count = requests.length;
				await act(async () => {
					await result.current.reconnect();
				});
				expect(requests).toHaveLength(count);
			},
		);
	}

	it("purges cached data and cancels a pending refetch on stream revocation", async () => {
		const stream = sse();
		const pending = deferred<Response>();
		let reads = 0;
		const { result, queryClient, requests } = setup((request) => {
			if (route(request) === "stream") return stream.response;
			if (route(request) === "execution")
				return ++reads === 1 ? Response.json(execution()) : pending.promise;
			return Response.json(history());
		});
		await waitFor(() => expect(result.current.execution.isSuccess).toBe(true));
		let refetch: Promise<unknown> | undefined;
		act(() => {
			refetch = result.current.execution.refetch();
		});
		await waitFor(() => expect(reads).toBe(2));
		act(() => stream.send(revoked(), event(2)));
		await waitFor(() => expect(result.current.timeline.status).toBe("denied"));
		expect(requests.at(-1)?.signal.aborted).toBe(true);
		await act(async () => {
			pending.resolve(Response.json(execution()));
			await refetch;
		});
		expect(result.current.execution.data).toBeUndefined();
		expect(cachedDetails(queryClient)).toEqual([]);
		expect(result.current.timeline.events).toEqual([]);
	});

	for (const change of ["conversation", "execution", "identity"] as const) {
		it.each([200, 403])(
			`isolates a late detail HTTP %s after ${change} changes`,
			async (lateStatus) => {
				const pending = deferred<Response>();
				let changed = false;
				const streams = [sse(), sse()];
				let streamCount = 0;
				const next: Selection = {
					...initialSelection,
					...(change === "conversation"
						? { conversationId: "conversation-2" }
						: {}),
					...(change === "execution" ? { executionId: "execution-2" } : {}),
					...(change === "identity" ? { identityKey: "test-login-2" } : {}),
				};
				const { result, rerender, requests, queryClient, seen } = setup(
					(request) => {
						if (route(request) === "stream")
							return streams[streamCount++].response;
						if (route(request) === "execution")
							return changed
								? Response.json(
										execution(next.conversationId, next.executionId),
									)
								: pending.promise;
						return Response.json(
							history(
								changed ? next.conversationId : initialSelection.conversationId,
							),
						);
					},
				);
				await waitFor(() =>
					expect(
						requests.some((request) => route(request) === "execution"),
					).toBe(true),
				);
				const oldRequest = requests.find(
					(request) => route(request) === "execution",
				);
				changed = true;
				rerender(next);
				const switchedAt = seen.length;
				await waitFor(() =>
					expect(result.current.execution.isSuccess).toBe(true),
				);
				expect(oldRequest?.signal.aborted).toBe(true);
				await act(async () => {
					pending.resolve(
						lateStatus === 200
							? Response.json({
									...execution(),
									processSummary: [
										{
											kind: "status",
											status: "unknown",
											summary: "late-old-detail",
											occurredAt: "2026-09-15T10:00:00Z",
										},
									],
								})
							: new Response("Denied", { status: lateStatus }),
					);
				});
				expect(result.current.timeline.status).toBe("ready");
				expect(result.current.execution.data).toEqual(
					execution(next.conversationId, next.executionId),
				);
				expect(JSON.stringify(seen.slice(switchedAt))).not.toContain(
					"late-old-detail",
				);
				expect(cachedDetails(queryClient)).toEqual([
					execution(next.conversationId, next.executionId),
				]);
			},
		);
	}

	it("does not show a previous login's cached result while the new login is still loading", async () => {
		const pending = deferred<Response>();
		let changed = false;
		const first = sse();
		const second = sse();
		const oldDetail = {
			...execution(),
			processSummary: [
				{
					kind: "status",
					status: "unknown",
					summary: "old-login-detail",
					occurredAt: "2026-09-15T10:00:00Z",
				},
			],
		};
		const { result, rerender, queryClient, requests, seen } = setup(
			(request) => {
				if (route(request) === "stream")
					return changed ? second.response : first.response;
				if (route(request) === "execution")
					return changed ? pending.promise : Response.json(oldDetail);
				return Response.json(history());
			},
		);
		await waitFor(() => expect(result.current.execution.isSuccess).toBe(true));
		const oldScope = queryClient
			.getQueryCache()
			.findAll({ queryKey: ["conversation-execution-detail"] })[0]
			.queryKey.slice(0, -1);
		changed = true;
		const changedAt = seen.length;
		rerender({ ...initialSelection, identityKey: "test-login-2" });
		await waitFor(() =>
			expect(
				requests.filter((request) => route(request) === "execution"),
			).toHaveLength(2),
		);
		expect(result.current.execution.data).toBeUndefined();
		expect(queryClient.getQueryCache().findAll({ queryKey: oldScope })).toEqual(
			[],
		);
		expect(JSON.stringify(seen.slice(changedAt))).not.toContain(
			"old-login-detail",
		);
		await act(async () => pending.resolve(Response.json(execution())));
		await waitFor(() => expect(result.current.execution.isSuccess).toBe(true));
	});

	it.each(["abort", "unmount"] as const)(
		"removes this page's cache and cancels in-flight details on %s",
		async (action) => {
			const stream = sse();
			const pending = deferred<Response>();
			let reads = 0;
			const { result, unmount, queryClient, requests } = setup((request) => {
				if (route(request) === "stream") return stream.response;
				if (route(request) === "execution")
					return ++reads === 1 ? Response.json(execution()) : pending.promise;
				return Response.json(history());
			});
			await waitFor(() =>
				expect(result.current.execution.isSuccess).toBe(true),
			);
			let refetch: Promise<unknown> | undefined;
			act(() => {
				refetch = result.current.execution.refetch();
			});
			await waitFor(() => expect(reads).toBe(2));
			if (action === "abort") act(() => result.current.abort());
			else unmount();
			expect(requests.at(-1)?.signal.aborted).toBe(true);
			await act(async () => {
				pending.resolve(Response.json(execution()));
				await refetch;
			});
			expect(cachedDetails(queryClient)).toEqual([]);
			if (action === "abort") {
				expect(result.current.timeline.status).toBe("idle");
				expect(result.current.execution.data).toBeUndefined();
			}
		},
	);

	it("isolates two mounted readers sharing one QueryClient and only clears the revoked reader", async () => {
		const queryClient = new QueryClient();
		const firstStream = sse();
		const secondStream = sse();
		const first = setup(
			(request) =>
				route(request) === "stream"
					? firstStream.response
					: Response.json(
							route(request) === "execution" ? execution() : history(),
						),
			initialSelection,
			queryClient,
		);
		const second = setup(
			(request) =>
				route(request) === "stream"
					? secondStream.response
					: Response.json(
							route(request) === "execution" ? execution() : history(),
						),
			initialSelection,
			queryClient,
		);
		await waitFor(() =>
			expect(
				first.result.current.execution.isSuccess &&
					second.result.current.execution.isSuccess,
			).toBe(true),
		);
		expect(cachedDetails(queryClient)).toHaveLength(2);
		act(() => firstStream.send(revoked()));
		await waitFor(() =>
			expect(first.result.current.timeline.status).toBe("denied"),
		);
		expect(first.result.current.execution.data).toBeUndefined();
		expect(second.result.current.execution.data).toEqual(execution());
		expect(cachedDetails(queryClient)).toHaveLength(1);
	});

	it.each(["conversation", "execution", "event"] as const)(
		"rejects a detail with the wrong %s binding before it reaches Query cache",
		async (binding) => {
			const stream = sse();
			const foreign =
				binding === "conversation"
					? execution("foreign-conversation")
					: binding === "execution"
						? execution("conversation-1", "foreign-execution")
						: { ...execution(), events: [event(1, "foreign-conversation")] };
			const { result, queryClient, seen } = setup((request) =>
				route(request) === "stream"
					? stream.response
					: Response.json(route(request) === "execution" ? foreign : history()),
			);
			await waitFor(() =>
				expect(result.current.timeline.failure).toEqual({ kind: "invalid" }),
			);
			expect(result.current.timeline.history).toBeNull();
			expect(result.current.execution.data).toBeUndefined();
			expect(cachedDetails(queryClient)).toEqual([]);
			expect(JSON.stringify(seen)).not.toContain("foreign-");
		},
	);
});
