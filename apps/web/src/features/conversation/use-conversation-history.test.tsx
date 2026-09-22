import { ConversationPageV1Schema } from "@agent-infra/contracts/pilot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "../../pilot/generated/client/index.js";
import { deferred, history } from "./conversation-test-fixtures.js";
import { useConversationHistory } from "./use-conversation-history.js";

const initial = { identityKey: "test-login-a", agentId: "agent-1" };

function page(
	ids = ["conversation-a"],
	nextCursor: string | null = null,
	agentId = "agent-1",
) {
	return ConversationPageV1Schema.parse({
		items: ids.map((conversationId) => ({
			...history(conversationId).conversation,
			agentId,
		})),
		nextCursor,
	});
}

const queryClients: QueryClient[] = [];
function setup(
	handler: (request: Request) => Response | Promise<Response>,
	selection = initial,
	queryClient = new QueryClient({ defaultOptions: { queries: { retry: 3 } } }),
	strict = false,
) {
	queryClients.push(queryClient);
	const requests: Request[] = [];
	const snapshots: { identityKey: string; agentId: string; ids: string[] }[] =
		[];
	const client = createClient({
		baseUrl: "https://platform.example.test",
		headers: { Cookie: "platform-session=test-a" },
		fetch: async (input, init) => {
			const request = new Request(input, init);
			requests.push(request);
			return handler(request);
		},
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			{strict ? <StrictMode>{children}</StrictMode> : children}
		</QueryClientProvider>
	);
	const hook = renderHook(
		(props: typeof initial) => {
			const result = useConversationHistory({ ...props, client });
			snapshots.push({
				...props,
				ids: result.items.map((item) => item.conversationId),
			});
			return result;
		},
		{ wrapper, initialProps: selection },
	);
	return { ...hook, requests, snapshots, queryClient, client };
}

function cached(queryClient: QueryClient) {
	return queryClient
		.getQueryCache()
		.findAll({ queryKey: ["conversation-history"] })
		.map((query) => query.state.data)
		.filter((data) => data !== undefined);
}

afterEach(() => {
	cleanup();
	for (const client of queryClients.splice(0)) client.clear();
});

describe("Personal conversation history session and pagination ownership", () => {
	it("distinguishes initial loading, a confirmed empty list, and no selected session", async () => {
		const pending = deferred<Response>();
		const { result, rerender, requests } = setup(() => pending.promise);
		expect(result.current.status).toBe("loading");
		await act(async () => pending.resolve(Response.json(page([]))));
		await waitFor(() => expect(result.current.status).toBe("ready"));
		expect(result.current.items).toEqual([]);
		expect(result.current.failure).toBeNull();
		expect(await result.current.loadMore()).toBe(false);
		rerender({ ...initial, identityKey: "" });
		expect(result.current.status).toBe("idle");
		expect(requests).toHaveLength(1);
	});

	it("loads only explicitly requested pages and deduplicates overlapping conversations", async () => {
		const { result, requests } = setup((request) =>
			Response.json(
				new URL(request.url).searchParams.has("cursor")
					? page(["conversation-a", "conversation-b", "conversation-b"])
					: page(["conversation-a"], "cursor-a"),
			),
		);
		await waitFor(() => expect(result.current.status).toBe("ready"));
		expect(requests).toHaveLength(1);
		expect(result.current.hasNextPage).toBe(true);
		await act(async () => {
			expect(await result.current.loadMore()).toBe(true);
		});
		await waitFor(() => expect(result.current.items).toHaveLength(2));
		expect(result.current.items.map((item) => item.conversationId)).toEqual([
			"conversation-a",
			"conversation-b",
		]);
		expect(result.current.hasNextPage).toBe(false);
		expect(await result.current.loadMore()).toBe(false);
		expect(requests).toHaveLength(2);
		expect(new URL(requests[1].url).searchParams.get("cursor")).toBe(
			"cursor-a",
		);
		expect(
			requests.every(
				(request) => request.method === "GET" && request.body === null,
			),
		).toBe(true);
	});

	it("coalesces same-tick next-page reads and never cancels the first read", async () => {
		const next = deferred<Response>();
		const { result, requests } = setup((request) =>
			new URL(request.url).searchParams.has("cursor")
				? next.promise
				: Response.json(page(["conversation-a"], "cursor-a")),
		);
		await waitFor(() => expect(result.current.hasNextPage).toBe(true));
		let first: Promise<boolean>;
		await act(async () => {
			first = result.current.loadMore();
			expect(await result.current.loadMore()).toBe(false);
		});
		expect(requests).toHaveLength(2);
		expect(requests[1].signal.aborted).toBe(false);
		await act(async () => {
			next.resolve(Response.json(page(["conversation-b"])));
			await first;
		});
		await waitFor(() => expect(result.current.items).toHaveLength(2));
	});

	it.each(["network", "service"] as const)(
		"keeps %s failure visible and retries only the failed page",
		async (kind) => {
			let fail = true;
			const { result, requests } = setup((request) => {
				if (!new URL(request.url).searchParams.has("cursor"))
					return Response.json(page(["conversation-a"], "cursor-a"));
				if (fail) {
					if (kind === "network") throw new TypeError("Synthetic failure");
					return new Response("Unavailable", { status: 503 });
				}
				return Response.json(page(["conversation-b"]));
			});
			await waitFor(() => expect(result.current.hasNextPage).toBe(true));
			await act(async () => {
				await result.current.loadMore();
			});
			await waitFor(() => expect(result.current.status).toBe("error"));
			expect(result.current.failure?.kind).toBe(kind);
			expect(result.current.items.map((item) => item.conversationId)).toEqual([
				"conversation-a",
			]);
			expect(result.current.canRetry).toBe(true);
			expect(requests).toHaveLength(2);
			fail = false;
			await act(async () => {
				expect(await result.current.retry()).toBe(true);
			});
			await waitFor(() => expect(result.current.status).toBe("ready"));
			expect(
				requests.map((request) =>
					new URL(request.url).searchParams.get("cursor"),
				),
			).toEqual([null, "cursor-a", "cursor-a"]);
			expect(result.current.items).toHaveLength(2);
		},
	);

	it("retries an initial failure explicitly without reporting empty history as success", async () => {
		let fail = true;
		const { result, requests } = setup(() =>
			fail
				? new Response("Unavailable", { status: 503 })
				: Response.json(page([])),
		);
		await waitFor(() => expect(result.current.status).toBe("error"));
		expect(result.current.items).toEqual([]);
		expect(result.current.canRetry).toBe(true);
		expect(requests).toHaveLength(1);
		fail = false;
		await act(async () => {
			await result.current.retry();
		});
		await waitFor(() => expect(result.current.status).toBe("ready"));
	});

	it("allows Query invalidation to reread the same page chain without a false cursor cycle", async () => {
		const { result, requests, queryClient } = setup((request) =>
			Response.json(
				new URL(request.url).searchParams.has("cursor")
					? page(["conversation-b"])
					: page(["conversation-a"], "cursor-a"),
			),
		);
		await waitFor(() => expect(result.current.hasNextPage).toBe(true));
		await act(async () => {
			await result.current.loadMore();
		});
		await waitFor(() => expect(result.current.items).toHaveLength(2));
		await act(async () => {
			await queryClient.invalidateQueries({
				queryKey: ["conversation-history"],
			});
		});
		await waitFor(() => expect(result.current.isFetching).toBe(false));
		expect(result.current.status).toBe("ready");
		expect(result.current.items).toHaveLength(2);
		expect(
			requests.map((request) =>
				new URL(request.url).searchParams.get("cursor"),
			),
		).toEqual([null, "cursor-a", null, "cursor-a"]);
	});

	it("follows a changed invalidation chain that reuses an old cursor later", async () => {
		let changed = false;
		const { result, requests, queryClient } = setup((request) => {
			const cursor = new URL(request.url).searchParams.get("cursor");
			if (!changed)
				return Response.json(
					cursor === null
						? page(["old-first"], "cursor-a")
						: page(["old-second"]),
				);
			if (cursor === null)
				return Response.json(page(["new-first"], "cursor-x"));
			if (cursor === "cursor-x")
				return Response.json(page(["new-second"], "cursor-a"));
			return Response.json(page(["new-third"]));
		});
		await waitFor(() => expect(result.current.hasNextPage).toBe(true));
		await act(async () => {
			await result.current.loadMore();
		});
		await waitFor(() => expect(result.current.items).toHaveLength(2));
		changed = true;
		await act(async () => {
			await queryClient.invalidateQueries({
				queryKey: ["conversation-history"],
			});
		});
		await waitFor(() => expect(result.current.isFetching).toBe(false));
		expect(result.current.status).toBe("ready");
		expect(result.current.failure).toBeNull();
		expect(result.current.hasNextPage).toBe(true);
		expect(result.current.items.map((item) => item.conversationId)).toEqual([
			"new-first",
			"new-second",
		]);
		await act(async () => {
			await result.current.loadMore();
		});
		await waitFor(() => expect(result.current.items).toHaveLength(3));
		expect(result.current.hasNextPage).toBe(false);
		expect(
			requests.map((request) =>
				new URL(request.url).searchParams.get("cursor"),
			),
		).toEqual([null, "cursor-a", null, "cursor-x", "cursor-a"]);
	});

	it("rejects a cycle within the new refetch chain before requesting a repeated page", async () => {
		let changed = false;
		const { result, requests, queryClient } = setup((request) => {
			const cursor = new URL(request.url).searchParams.get("cursor");
			if (!changed) {
				if (cursor === null)
					return Response.json(page(["old-first"], "cursor-a"));
				if (cursor === "cursor-a")
					return Response.json(page(["old-second"], "cursor-b"));
				return Response.json(page(["old-third"]));
			}
			if (cursor === null)
				return Response.json(page(["new-first"], "cursor-x"));
			if (cursor === "cursor-x")
				return Response.json(page(["new-second"], "cursor-y"));
			return Response.json(page(["new-third"], "cursor-x"));
		});
		await waitFor(() => expect(result.current.hasNextPage).toBe(true));
		await act(async () => {
			await result.current.loadMore();
		});
		await waitFor(() => expect(result.current.items).toHaveLength(2));
		await act(async () => {
			await result.current.loadMore();
		});
		await waitFor(() => expect(result.current.items).toHaveLength(3));
		changed = true;
		await act(async () => {
			await queryClient.invalidateQueries({
				queryKey: ["conversation-history"],
			});
		});
		await waitFor(() => expect(result.current.status).toBe("error"));
		expect(result.current.failure).toEqual({ kind: "invalid" });
		expect(result.current.items).toEqual([]);
		expect(cached(queryClient)).toEqual([]);
		expect(await result.current.loadMore()).toBe(false);
		expect(await result.current.retry()).toBe(false);
		expect(
			requests.map((request) =>
				new URL(request.url).searchParams.get("cursor"),
			),
		).toEqual([null, "cursor-a", "cursor-b", null, "cursor-x", "cursor-y"]);
	});

	it.each([401, 403, 404])(
		"purges all loaded pages on HTTP %s and blocks further reads",
		async (status) => {
			const { result, requests, queryClient } = setup((request) =>
				new URL(request.url).searchParams.has("cursor")
					? new Response("Private rejection", { status })
					: Response.json(page(["conversation-a"], "cursor-a")),
			);
			queryClient.setQueryData(["unrelated"], "preserve");
			await waitFor(() => expect(result.current.hasNextPage).toBe(true));
			await act(async () => {
				await result.current.loadMore();
			});
			await waitFor(() => expect(result.current.status).toBe("denied"));
			expect(result.current.items).toEqual([]);
			expect(cached(queryClient)).toEqual([]);
			expect(result.current.canRetry).toBe(false);
			expect(await result.current.loadMore()).toBe(false);
			expect(await result.current.retry()).toBe(false);
			expect(requests).toHaveLength(2);
			expect(queryClient.getQueryData(["unrelated"])).toBe("preserve");
		},
	);

	it.each(["agent", "cycle"] as const)(
		"clears prior pages and terminates an invalid %s response",
		async (invalid) => {
			const { result, requests, queryClient } = setup((request) => {
				const cursor = new URL(request.url).searchParams.get("cursor");
				if (!cursor) return Response.json(page(["conversation-a"], "cursor-a"));
				if (cursor === "cursor-a")
					return Response.json(page(["conversation-b"], "cursor-b"));
				return Response.json(
					page(
						["foreign"],
						invalid === "cycle" ? "cursor-a" : null,
						invalid === "agent" ? "agent-2" : "agent-1",
					),
				);
			});
			await waitFor(() => expect(result.current.hasNextPage).toBe(true));
			await act(async () => {
				await result.current.loadMore();
			});
			await waitFor(() => expect(result.current.items).toHaveLength(2));
			await act(async () => {
				await result.current.loadMore();
			});
			await waitFor(() => expect(result.current.status).toBe("error"));
			expect(result.current.failure).toEqual({ kind: "invalid" });
			expect(result.current.items).toEqual([]);
			expect(cached(queryClient)).toEqual([]);
			expect(await result.current.retry()).toBe(false);
			expect(await result.current.loadMore()).toBe(false);
			expect(requests).toHaveLength(3);
		},
	);

	it("isolates two authenticated subjects on the same Agent from the first switched render", async () => {
		const pending = deferred<Response>();
		const { result, requests, snapshots, client, rerender, queryClient } =
			setup((request) => {
				if (request.headers.get("Cookie") === "platform-session=test-b")
					return Response.json(page(["subject-b-only"]));
				return new URL(request.url).searchParams.has("cursor")
					? pending.promise
					: Response.json(page(["subject-a-only"], "subject-a-cursor"));
			});
		await waitFor(() => expect(result.current.hasNextPage).toBe(true));
		let reading: Promise<boolean>;
		act(() => {
			reading = result.current.loadMore();
		});
		await waitFor(() => expect(requests).toHaveLength(2));
		client.setConfig({ headers: { Cookie: "platform-session=test-b" } });
		rerender({ ...initial, identityKey: "test-login-b" });
		expect(result.current.items).toEqual([]);
		expect(requests[1].signal.aborted).toBe(true);
		await waitFor(() =>
			expect(result.current.items[0]?.conversationId).toBe("subject-b-only"),
		);
		await act(async () => {
			pending.resolve(Response.json(page(["subject-a-late"])));
			await reading;
		});
		expect(
			snapshots
				.filter((item) => item.identityKey === "test-login-b")
				.every((item) => item.ids.every((id) => id === "subject-b-only")),
		).toBe(true);
		expect(JSON.stringify(cached(queryClient))).not.toContain("subject-a");
		expect(new URL(requests[2].url).searchParams.has("cursor")).toBe(false);
		expect(
			requests.every(
				(request) => !/[?&](userId|role|identityKey)=/.test(request.url),
			),
		).toBe(true);
	});

	it("drops late denial from an old subject without revoking the new subject", async () => {
		const pending = deferred<Response>();
		const { result, requests, client, rerender } = setup((request) =>
			request.headers.get("Cookie") === "platform-session=test-b"
				? Response.json(page(["subject-b-only"]))
				: pending.promise,
		);
		await waitFor(() => expect(requests).toHaveLength(1));
		client.setConfig({ headers: { Cookie: "platform-session=test-b" } });
		rerender({ ...initial, identityKey: "test-login-b" });
		await waitFor(() => expect(result.current.status).toBe("ready"));
		await act(async () =>
			pending.resolve(new Response("Old rejection", { status: 403 })),
		);
		expect(result.current.status).toBe("ready");
		expect(result.current.failure).toBeNull();
		expect(result.current.items[0].conversationId).toBe("subject-b-only");
	});

	it("cancels an old Agent read and never reuses its cursor or data", async () => {
		const pending = deferred<Response>();
		const { result, requests, rerender, snapshots } = setup((request) =>
			new URL(request.url).pathname.includes("/agent-2/")
				? Response.json(page(["agent-2-only"], null, "agent-2"))
				: pending.promise,
		);
		await waitFor(() => expect(requests).toHaveLength(1));
		rerender({ ...initial, agentId: "agent-2" });
		expect(requests[0].signal.aborted).toBe(true);
		await waitFor(() => expect(result.current.status).toBe("ready"));
		await act(async () =>
			pending.resolve(Response.json(page(["agent-1-late"], "agent-1-cursor"))),
		);
		expect(
			snapshots
				.filter((item) => item.agentId === "agent-2")
				.every((item) => !item.ids.includes("agent-1-late")),
		).toBe(true);
		expect(result.current.items[0].conversationId).toBe("agent-2-only");
	});

	it("clears cached data and pending reads on explicit revocation, including retained callbacks", async () => {
		const pending = deferred<Response>();
		const { result, requests, queryClient } = setup((request) =>
			new URL(request.url).searchParams.has("cursor")
				? pending.promise
				: Response.json(page(["private-a"], "cursor-a")),
		);
		await waitFor(() => expect(result.current.hasNextPage).toBe(true));
		const previous = result.current;
		let reading: Promise<boolean>;
		act(() => {
			reading = result.current.loadMore();
		});
		await waitFor(() => expect(requests).toHaveLength(2));
		act(() => result.current.revoke());
		expect(result.current.items).toEqual([]);
		expect(result.current.status).toBe("denied");
		expect(requests[1].signal.aborted).toBe(true);
		expect(cached(queryClient)).toEqual([]);
		expect(await previous.loadMore()).toBe(false);
		await act(async () => {
			pending.resolve(Response.json(page(["late-private"])));
			await reading;
		});
		expect(result.current.items).toEqual([]);
		expect(cached(queryClient)).toEqual([]);
	});

	it("starts a clean lifetime on a new login by the same subject", async () => {
		let round = 0;
		const { result, rerender, queryClient } = setup(() =>
			Response.json(page([`session-${++round}`])),
		);
		await waitFor(() =>
			expect(result.current.items[0]?.conversationId).toBe("session-1"),
		);
		rerender({ ...initial, identityKey: "test-login-a-new" });
		expect(result.current.items).toEqual([]);
		await waitFor(() =>
			expect(result.current.items[0]?.conversationId).toBe("session-2"),
		);
		expect(JSON.stringify(cached(queryClient))).not.toContain("session-1");
	});

	it("cancels unmounted reads without removing another mounted subject's data", async () => {
		const pending = deferred<Response>();
		const queryClient = new QueryClient();
		const first = setup(() => pending.promise, initial, queryClient);
		const second = setup(
			() => Response.json(page(["subject-b-only"])),
			{ ...initial, identityKey: "test-login-b" },
			queryClient,
		);
		await waitFor(() => expect(second.result.current.status).toBe("ready"));
		first.unmount();
		expect(first.requests[0].signal.aborted).toBe(true);
		await act(async () =>
			pending.resolve(Response.json(page(["unmounted-private"]))),
		);
		expect(JSON.stringify(cached(queryClient))).not.toContain(
			"unmounted-private",
		);
		expect(second.result.current.items[0].conversationId).toBe(
			"subject-b-only",
		);
		expect(cached(queryClient)).toHaveLength(1);
		second.unmount();
		expect(cached(queryClient)).toEqual([]);
	});

	it("remains usable after StrictMode effect replay and cleans up the final observer", async () => {
		const { result, unmount, queryClient } = setup(
			() => Response.json(page()),
			initial,
			undefined,
			true,
		);
		await waitFor(() => expect(result.current.status).toBe("ready"));
		expect(result.current.items).toHaveLength(1);
		unmount();
		expect(cached(queryClient)).toEqual([]);
	});
});
