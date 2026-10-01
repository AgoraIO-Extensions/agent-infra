import {
	focusManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../../pilot/generated-v2/client/index.js";
import { pendingApplication } from "../my-agents/test-fixtures.js";
import { usePendingAgentApplications } from "./use-pending-agent-applications.js";

type Selection = { identityKey: string; enabled: boolean };
const initial: Selection = { identityKey: "login-a", enabled: true };
const clients: QueryClient[] = [];
const page = (
	name = "Controlled pending application",
	nextCursor: string | null = null,
) => ({
	items: [{ ...pendingApplication, name }],
	nextCursor,
});

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
) {
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected default fetch");
		}),
	);
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
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	const hook = renderHook(
		(props: Selection) => usePendingAgentApplications({ ...props, client }),
		{ wrapper, initialProps: selection },
	);
	return { ...hook, requests, queryClient };
}

afterEach(() => {
	cleanup();
	focusManager.setFocused(undefined);
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
});

describe("Pending approval reads respect the current login and role", () => {
	it.each([
		{ ...initial, enabled: false },
		{ ...initial, identityKey: "" },
	])(
		"does not read or manually retry without a current administrator (%j)",
		async (selection) => {
			const { result, requests } = setup(
				() => Response.json(page()),
				selection,
			);
			expect(result.current.state).toEqual({
				kind: "unavailable",
				retryable: false,
			});
			await act(async () => {
				await result.current.refetch();
				focusManager.setFocused(false);
				focusManager.setFocused(true);
			});
			expect(requests).toEqual([]);
			expect(globalThis.fetch).not.toHaveBeenCalled();
			expect(result.current.isFetching).toBe(false);
		},
	);

	it.each(["role", "login"] as const)(
		"cancels pagination, clears old data and blocks retained retries on %s change",
		async (change) => {
			const pending = deferred<Response>();
			let nextLogin = false;
			const { result, requests, queryClient, rerender } = setup((request) =>
				nextLogin
					? Response.json(page("Current login application"))
					: new URL(request.url).searchParams.has("cursor")
						? pending.promise
						: Response.json(page("Old initial page", "opaque-next/+?=")),
			);
			await waitFor(() => expect(requests).toHaveLength(2));
			expect(result.current.state.kind).toBe("loading");
			const retainedRefetch = result.current.refetch;
			const oldKeys = queryClient
				.getQueryCache()
				.findAll({ queryKey: ["admin", "agent-applications"] })
				.map((query) => query.queryKey);
			nextLogin = change === "login";
			rerender(
				change === "login"
					? { ...initial, identityKey: "login-b" }
					: { ...initial, enabled: false },
			);
			expect(requests[1].signal.aborted).toBe(true);
			expect(oldKeys.map((key) => queryClient.getQueryState(key))).toEqual([
				undefined,
			]);
			await act(async () => {
				pending.resolve(Response.json(page("Old late application")));
				await retainedRefetch();
			});
			if (change === "login") {
				await waitFor(() =>
					expect(result.current.state).toMatchObject({
						kind: "ready",
						applications: [{ name: "Current login application" }],
					}),
				);
				expect(requests).toHaveLength(3);
			} else {
				expect(result.current.state).toEqual({
					kind: "unavailable",
					retryable: false,
				});
				expect(requests).toHaveLength(2);
			}
			expect(
				JSON.stringify(
					queryClient
						.getQueryCache()
						.findAll()
						.map((query) => query.state.data),
				),
			).not.toContain("Old late application");
		},
	);

	it.each([
		{ status: 401, reason: "authentication-required" },
		{ status: 403, reason: "denied" },
	])(
		"removes prior results and stops retained/manual/background reads after HTTP $status",
		async ({ status, reason }) => {
			let denied = false;
			const { result, requests } = setup(() =>
				denied
					? new Response("controlled opaque denial", { status })
					: Response.json(page("Previously permitted application")),
			);
			await waitFor(() => expect(result.current.state.kind).toBe("ready"));
			const retainedRefetch = result.current.refetch;
			denied = true;
			await act(async () => {
				await result.current.refetch();
			});
			await waitFor(() =>
				expect(result.current.state).toEqual({
					kind: "unavailable",
					retryable: false,
					reason,
				}),
			);
			expect(requests).toHaveLength(2);
			await act(async () => {
				await retainedRefetch();
				await result.current.refetch();
				focusManager.setFocused(false);
				focusManager.setFocused(true);
			});
			expect(requests).toHaveLength(2);
			expect(result.current.isFetching).toBe(false);
		},
	);
});
