import {
	focusManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "../../pilot/generated/client/index.js";
import type { AuditFilters, AuditScope } from "./audit-query.js";
import { auditPage, auditRecord } from "./audit-test-fixtures.js";
import { useAuditQuery } from "./use-audit-query.js";

type Selection = {
	identityKey: string;
	scope: AuditScope;
	filters?: AuditFilters;
	auditId?: string | null;
};
const initial: Selection = { identityKey: "login-a", scope: "own" };
const clients: QueryClient[] = [];

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function setup(
	handler: (request: Request) => Response | Promise<Response>,
	selection = initial,
	strict = false,
) {
	const queryClient = new QueryClient();
	clients.push(queryClient);
	const requests: Request[] = [];
	const client = createClient({
		baseUrl: "https://platform.example.test",
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
		(props: Selection) => useAuditQuery({ ...props, client }),
		{ wrapper, initialProps: selection },
	);
	return { ...hook, client, requests, queryClient };
}

function cached(queryClient: QueryClient) {
	return queryClient
		.getQueryCache()
		.findAll({ queryKey: ["audit-query"] })
		.map((query) => query.state.data)
		.filter((data) => data !== undefined);
}

afterEach(() => {
	cleanup();
	focusManager.setFocused(undefined);
	for (const client of clients.splice(0)) client.clear();
});

describe("Audit page and detail lifetimes", () => {
	it("shows one page at a time and uses opaque cursors for previous/next without totals", async () => {
		const { result, requests } = setup((request) =>
			Response.json(
				new URL(request.url).searchParams.has("cursor")
					? auditPage("second")
					: auditPage("first", "cursor-next"),
			),
		);
		expect(result.current.status).toBe("loading");
		await waitFor(() => expect(result.current.hasNextPage).toBe(true));
		act(() => {
			expect(result.current.nextPage()).toBe(true);
		});
		await waitFor(() =>
			expect(result.current.items[0]?.auditId).toBe("second"),
		);
		expect(result.current.items).toHaveLength(1);
		expect(result.current.pageNumber).toBe(2);
		expect(result.current.canPreviousPage).toBe(true);
		expect(result.current.hasNextPage).toBe(false);
		act(() => {
			expect(result.current.previousPage()).toBe(true);
		});
		await waitFor(() => expect(result.current.items[0]?.auditId).toBe("first"));
		expect(result.current.pageNumber).toBe(1);
		expect(
			requests.map((request) =>
				new URL(request.url).searchParams.get("cursor"),
			),
		).toEqual([null, "cursor-next", null]);
	});

	it.each(["identity", "scope", "filter"] as const)(
		"aborts old pagination and clears rows/details on %s changes",
		async (change) => {
			const pending = deferred<Response>();
			const { result, rerender, requests, queryClient } = setup(
				(request) => {
					const url = new URL(request.url);
					if (url.searchParams.has("cursor")) return pending.promise;
					if (url.pathname.endsWith("/audit-a"))
						return Response.json(auditRecord());
					return Response.json(auditPage("audit-a", "cursor-a"));
				},
				{ ...initial, auditId: "audit-a" },
			);
			await waitFor(() =>
				expect(result.current.detail?.auditId).toBe("audit-a"),
			);
			await waitFor(() => expect(result.current.hasNextPage).toBe(true));
			act(() => {
				result.current.nextPage();
			});
			await waitFor(() =>
				expect(
					requests.some((request) =>
						new URL(request.url).searchParams.has("cursor"),
					),
				).toBe(true),
			);
			const pagination = requests.find((request) =>
				new URL(request.url).searchParams.has("cursor"),
			);
			rerender({
				...initial,
				...(change === "identity"
					? { identityKey: "login-b" }
					: change === "scope"
						? { scope: "administrator" as const }
						: { filters: { agentId: "agent-b" } }),
			});
			expect(result.current.items).toEqual([]);
			expect(result.current.detail).toBeUndefined();
			expect(result.current.pageNumber).toBe(1);
			expect(pagination?.signal.aborted).toBe(true);
			await act(async () => {
				pending.resolve(Response.json(auditPage("old-late")));
			});
			await waitFor(() => expect(result.current.status).toBe("ready"));
			expect(JSON.stringify(cached(queryClient))).not.toContain("old-late");
			expect(requests.slice(-1)[0].url).not.toContain("cursor=");
		},
	);

	it.each([401, 403, 404])(
		"purges list and detail together after HTTP %s and blocks retained callbacks",
		async (status) => {
			let denied = false;
			const { result, queryClient, requests } = setup(
				(request) =>
					denied
						? new Response("synthetic-private-error", { status })
						: Response.json(
								new URL(request.url).pathname.endsWith("/audit-a")
									? auditRecord()
									: auditPage(),
							),
				{ ...initial, auditId: "audit-a" },
			);
			await waitFor(() => expect(result.current.detail).toBeDefined());
			await waitFor(() => expect(result.current.status).toBe("ready"));
			queryClient.setQueryData(["unrelated"], "preserve");
			const retained = result.current;
			denied = true;
			await act(async () => {
				await result.current.retryDetail();
			});
			await waitFor(() => expect(result.current.status).toBe("denied"));
			expect(result.current.detailStatus).toBe("denied");
			expect(result.current.items).toEqual([]);
			expect(result.current.detail).toBeUndefined();
			expect(cached(queryClient)).toEqual([]);
			const count = requests.length;
			await retained.refresh();
			await retained.retryDetail();
			expect(requests).toHaveLength(count);
			expect(queryClient.getQueryData(["unrelated"])).toBe("preserve");
		},
	);

	it("hides stale rows after service failure and retries explicitly, keeping empty success distinct", async () => {
		let fail = false;
		let empty = false;
		const { result } = setup(() =>
			fail
				? new Response("private service state", { status: 503 })
				: Response.json(empty ? { items: [], nextCursor: null } : auditPage()),
		);
		await waitFor(() => expect(result.current.items).toHaveLength(1));
		fail = true;
		await act(async () => {
			await result.current.refresh();
		});
		await waitFor(() => expect(result.current.status).toBe("error"));
		expect(result.current.items).toEqual([]);
		expect(result.current.canRetry).toBe(true);
		fail = false;
		empty = true;
		await act(async () => {
			await result.current.retry();
		});
		await waitFor(() => expect(result.current.status).toBe("ready"));
		expect(result.current.items).toEqual([]);
		expect(result.current.failure).toBeNull();
	});

	it("blocks cursor cycles instead of issuing repeated reads", async () => {
		const { result, requests, queryClient } = setup(() =>
			Response.json(auditPage("audit-a", "cursor-a")),
		);
		await waitFor(() => expect(result.current.hasNextPage).toBe(true));
		act(() => {
			result.current.nextPage();
		});
		await waitFor(() => expect(result.current.status).toBe("error"));
		expect(result.current.failure?.kind).toBe("invalid");
		expect(result.current.items).toEqual([]);
		expect(cached(queryClient)).toEqual([]);
		expect(result.current.nextPage()).toBe(false);
		expect(requests).toHaveLength(2);
	});

	it("revalidates current permission on focus and removes cached metadata after revocation", async () => {
		let denied = false;
		const { result, queryClient } = setup(() =>
			denied
				? new Response("permission changed", { status: 404 })
				: Response.json(auditPage()),
		);
		await waitFor(() => expect(result.current.status).toBe("ready"));
		denied = true;
		act(() => {
			focusManager.setFocused(false);
			focusManager.setFocused(true);
		});
		await waitFor(() => expect(result.current.status).toBe("denied"));
		expect(result.current.items).toEqual([]);
		expect(cached(queryClient)).toEqual([]);
	});

	it("coalesces same-tick paging and retains a semantically equal filter lifetime", async () => {
		const pending = deferred<Response>();
		const { result, requests, rerender } = setup(
			(request) =>
				new URL(request.url).searchParams.has("cursor")
					? pending.promise
					: Response.json(auditPage("first", "cursor-a")),
			{
				...initial,
				filters: { agentId: "agent-a", executionId: "execution-a" },
			},
		);
		await waitFor(() => expect(result.current.hasNextPage).toBe(true));
		act(() => {
			expect(result.current.nextPage()).toBe(true);
			expect(result.current.nextPage()).toBe(false);
		});
		rerender({
			...initial,
			filters: { executionId: "execution-a", agentId: "agent-a" },
		});
		expect(result.current.pageNumber).toBe(2);
		await waitFor(() => expect(requests).toHaveLength(2));
		expect(requests[1].signal.aborted).toBe(false);
		await act(async () => {
			pending.resolve(Response.json(auditPage("second")));
		});
		await waitFor(() =>
			expect(result.current.items[0]?.auditId).toBe("second"),
		);
	});

	it("explicit revocation aborts in-flight reads and rejects their late success", async () => {
		const pending = deferred<Response>();
		const { result, requests, queryClient } = setup(() => pending.promise);
		await waitFor(() => expect(requests).toHaveLength(1));
		const retained = result.current;
		act(() => {
			result.current.revoke();
		});
		expect(requests[0].signal.aborted).toBe(true);
		expect(result.current.status).toBe("denied");
		await act(async () => {
			pending.resolve(Response.json(auditPage("late-private")));
		});
		await retained.refresh();
		expect(requests).toHaveLength(1);
		expect(result.current.items).toEqual([]);
		expect(cached(queryClient)).toEqual([]);
	});

	it("aborts stale detail selection while preserving the page and ignores its late denial", async () => {
		const pending = deferred<Response>();
		const { result, rerender, requests } = setup(
			(request) =>
				new URL(request.url).pathname.endsWith("/old")
					? pending.promise
					: Response.json(
							new URL(request.url).pathname.endsWith("/new")
								? auditRecord("new")
								: auditPage("list-row"),
						),
			{ ...initial, auditId: "old" },
		);
		await waitFor(() => expect(result.current.status).toBe("ready"));
		const old = requests.find((request) =>
			new URL(request.url).pathname.endsWith("/old"),
		);
		rerender({ ...initial, auditId: "new" });
		expect(old?.signal.aborted).toBe(true);
		await waitFor(() => expect(result.current.detail?.auditId).toBe("new"));
		await act(async () => {
			pending.resolve(new Response("old denial", { status: 404 }));
		});
		expect(result.current.status).toBe("ready");
		expect(result.current.items[0]?.auditId).toBe("list-row");
		expect(result.current.detail?.auditId).toBe("new");
	});

	it("clears logout and unmount caches and works through StrictMode effect replay", async () => {
		const { result, rerender, unmount, queryClient } = setup(
			() => Response.json(auditPage()),
			initial,
			true,
		);
		await waitFor(() => expect(result.current.status).toBe("ready"));
		rerender({ ...initial, identityKey: "" });
		expect(result.current.status).toBe("idle");
		expect(result.current.items).toEqual([]);
		expect(cached(queryClient)).toEqual([]);
		unmount();
		expect(cached(queryClient)).toEqual([]);
	});
});
