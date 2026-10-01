import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import {
	focusManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "../../pilot/generated-v2/client/index.js";
import type { AdminAgentsState } from "./admin-agents.js";
import { useAdminAgents } from "./use-admin-agents.js";

const agent = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);
const page = (name = "Current Agent", nextCursor: string | null = null) => ({
	items: [{ ...agent, name }],
	nextCursor,
});
type Selection = { identityKey: string; enabled: boolean };
const initial: Selection = {
	identityKey: "user-a:login-generation-1",
	enabled: true,
};
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
		(props: Selection) => useAdminAgents({ ...props, client }),
		{
			wrapper,
			initialProps: selection,
		},
	);
	return { ...hook, requests, queryClient };
}

function cached(queryClient: QueryClient) {
	return queryClient
		.getQueryCache()
		.findAll({ queryKey: ["admin-agents"] })
		.map((query) => query.state.data as AdminAgentsState | undefined)
		.filter((data) => data !== undefined);
}

afterEach(() => {
	cleanup();
	focusManager.setFocused(undefined);
	for (const client of clients.splice(0)) client.clear();
});

describe("Administrator inventory authorization and login lifetimes", () => {
	it.each([
		{ ...initial, enabled: false },
		{ ...initial, identityKey: "" },
	])("never requests the inventory while disabled (%j)", async (selection) => {
		const { result, requests } = setup(() => Response.json(page()), selection);
		expect(result.current.state).toEqual({ kind: "denied" });
		expect(result.current.isFetching).toBe(false);
		await act(async () => {
			await result.current.refetch();
			focusManager.setFocused(false);
			focusManager.setFocused(true);
		});
		expect(requests).toEqual([]);
	});

	it("exposes no partial rows while a later cursor page is pending", async () => {
		const pending = deferred<Response>();
		const { result, requests } = setup((request) =>
			new URL(request.url).searchParams.has("cursor")
				? pending.promise
				: Response.json(page("First page", "opaque-next")),
		);
		await waitFor(() => expect(requests).toHaveLength(2));
		expect(result.current.state).toEqual({ kind: "loading" });
		expect(result.current.isFetching).toBe(true);
		await act(async () => {
			pending.resolve(Response.json(page("Later page")));
		});
		await waitFor(() => expect(result.current.state.kind).toBe("ready"));
		expect(result.current.state).toMatchObject({
			kind: "ready",
			agents: [{ name: "First page" }, { name: "Later page" }],
		});
	});

	it.each(["generation", "role"] as const)(
		"cancels pending pagination, clears the prior cache and rejects late success on %s change",
		async (change) => {
			const pending = deferred<Response>();
			let newGeneration = false;
			const { result, requests, rerender, queryClient } = setup((request) =>
				newGeneration
					? Response.json(page("Current-generation result"))
					: new URL(request.url).searchParams.has("cursor")
						? pending.promise
						: Response.json(page("Initial page", "opaque-next")),
			);
			await waitFor(() => expect(requests).toHaveLength(2));
			const oldQueryKeys = queryClient
				.getQueryCache()
				.findAll({ queryKey: ["admin-agents"] })
				.map((query) => query.queryKey);
			const retainedRefetch = result.current.refetch;
			newGeneration = change === "generation";
			rerender(
				change === "generation"
					? { ...initial, identityKey: "user-a:login-generation-2" }
					: { ...initial, enabled: false },
			);
			expect(result.current.state.kind).toBe(
				change === "role" ? "denied" : "loading",
			);
			expect(requests[1].signal.aborted).toBe(true);
			expect(oldQueryKeys.map((key) => queryClient.getQueryData(key))).toEqual([
				undefined,
			]);
			await act(async () => {
				pending.resolve(Response.json(page("Old late private result")));
				await retainedRefetch();
			});
			if (change === "generation")
				await waitFor(() => expect(result.current.state.kind).toBe("ready"));
			expect(JSON.stringify(cached(queryClient))).not.toContain(
				"Old late private result",
			);
			if (change === "role") {
				expect(result.current.state).toEqual({ kind: "denied" });
				expect(requests).toHaveLength(2);
				expect(cached(queryClient)).toEqual([]);
			}
		},
	);

	it("hides old rows after a refresh error and explicitly retries to a valid empty result", async () => {
		const pending = deferred<Response>();
		let mode: "ready" | "pending" | "empty" = "ready";
		const { result, queryClient } = setup(() =>
			mode === "pending"
				? pending.promise
				: Response.json(
						mode === "empty" ? { items: [], nextCursor: null } : page(),
					),
		);
		await waitFor(() => expect(result.current.state.kind).toBe("ready"));
		mode = "pending";
		let refreshing!: ReturnType<typeof result.current.refetch>;
		act(() => {
			refreshing = result.current.refetch();
		});
		await waitFor(() => expect(result.current.isFetching).toBe(true));
		expect(result.current.state.kind).toBe("ready");
		await act(async () => {
			pending.resolve(
				new Response("synthetic-private-upstream-state", { status: 503 }),
			);
			await refreshing;
		});
		await waitFor(() =>
			expect(result.current.state).toEqual({ kind: "error", retryable: true }),
		);
		expect(cached(queryClient)).toEqual([{ kind: "error", retryable: true }]);
		mode = "empty";
		await act(async () => {
			await result.current.refetch();
		});
		await waitFor(() =>
			expect(result.current.state).toEqual({ kind: "ready", agents: [] }),
		);
	});

	it.each([
		{ status: 401, reason: "authentication-required" },
		{ status: 403, reason: "denied" },
	])(
		"clears refreshed rows and stops background reads/retained callbacks after HTTP $status",
		async ({ status, reason }) => {
			let denied = false;
			const { result, requests, queryClient } = setup((request) =>
				denied && new URL(request.url).searchParams.has("cursor")
					? new Response("synthetic-private-denial", { status })
					: Response.json(
							page("Authorized row", denied ? "denied-page" : null),
						),
			);
			await waitFor(() => expect(result.current.state.kind).toBe("ready"));
			const retainedRefetch = result.current.refetch;
			denied = true;
			await act(async () => {
				await result.current.refetch();
			});
			await waitFor(() =>
				expect(result.current.state).toEqual({ kind: "denied", reason }),
			);
			expect(cached(queryClient)).toEqual([{ kind: "denied", reason }]);
			const count = requests.length;
			await act(async () => {
				await retainedRefetch();
				await result.current.refetch();
				focusManager.setFocused(false);
				focusManager.setFocused(true);
			});
			expect(requests).toHaveLength(count);
			expect(result.current.isFetching).toBe(false);
		},
	);

	it("revalidates on focus and removes rows when permission is revoked with HTTP403", async () => {
		let denied = false;
		const { result, queryClient, requests } = setup(() =>
			denied
				? new Response("synthetic-permission-change", { status: 403 })
				: Response.json(page()),
		);
		await waitFor(() => expect(result.current.state.kind).toBe("ready"));
		denied = true;
		act(() => {
			focusManager.setFocused(false);
			focusManager.setFocused(true);
		});
		await waitFor(() =>
			expect(result.current.state).toEqual({
				kind: "denied",
				reason: "denied",
			}),
		);
		expect(requests).toHaveLength(2);
		expect(cached(queryClient)).toEqual([{ kind: "denied", reason: "denied" }]);
	});

	it("aborts and removes only its own query on unmount, preserving unrelated data", async () => {
		const pending = deferred<Response>();
		const { unmount, requests, queryClient } = setup(() => pending.promise);
		await waitFor(() => expect(requests).toHaveLength(1));
		queryClient.setQueryData(["unrelated"], "preserve");
		unmount();
		expect(requests[0].signal.aborted).toBe(true);
		await act(async () => {
			pending.resolve(Response.json(page("Unmounted late result")));
		});
		expect(cached(queryClient)).toEqual([]);
		expect(queryClient.getQueryData(["unrelated"])).toBe("preserve");
	});

	it("works through StrictMode replay and clears same-user role changes before re-enabling", async () => {
		const { result, rerender, queryClient } = setup(
			() => Response.json(page()),
			initial,
			true,
		);
		await waitFor(() => expect(result.current.state.kind).toBe("ready"));
		rerender({ ...initial, enabled: false });
		expect(result.current.state).toEqual({ kind: "denied" });
		expect(cached(queryClient)).toEqual([]);
		rerender(initial);
		expect(result.current.state).toEqual({ kind: "loading" });
		await waitFor(() => expect(result.current.state.kind).toBe("ready"));
	});
});
