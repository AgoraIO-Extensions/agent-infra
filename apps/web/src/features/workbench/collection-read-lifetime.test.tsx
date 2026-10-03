import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import {
	focusManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type Client,
	createClient,
} from "../../pilot/generated-v2/client/index.js";
import { useAgentDiscovery } from "../agent-discovery/use-agent-discovery.js";
import { pendingApplication } from "../my-agents/test-fixtures.js";
import { useMyAgentApplications } from "../my-agents/use-my-agent-applications.js";

const queryClients: QueryClient[] = [];
const agent = pilotFakeScenariosV2.starting.response.body;
const readers = [
	{
		name: "visible Agents",
		prefix: ["agents"],
		useReader: (identityKey: string, client: Client) =>
			useAgentDiscovery({ identityKey, client }),
		page: (name = "Current Agent", nextCursor: string | null = null) => ({
			items: [{ ...agent, name }],
			nextCursor,
		}),
	},
	{
		name: "Owner Agents",
		prefix: ["agents"],
		useReader: (identityKey: string, client: Client) =>
			useAgentDiscovery({ identityKey, client, scope: "owner" }),
		page: (name = "Current Owner Agent", nextCursor: string | null = null) => ({
			items: [{ ...agent, name }],
			nextCursor,
		}),
	},
	{
		name: "own applications",
		prefix: ["my-agents"],
		useReader: (identityKey: string, client: Client) =>
			useMyAgentApplications({ identityKey, client }),
		page: (name = "Current application", nextCursor: string | null = null) => ({
			items: [{ ...pendingApplication, name }],
			nextCursor,
		}),
	},
];

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function setup(handler: (request: Request) => Response | Promise<Response>) {
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected default fetch");
		}),
	);
	const queryClient = new QueryClient();
	queryClients.push(queryClient);
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
	return { client, queryClient, requests, wrapper };
}

afterEach(() => {
	cleanup();
	focusManager.setFocused(undefined);
	for (const client of queryClients.splice(0)) client.clear();
	vi.unstubAllGlobals();
});

describe.each(readers)("$name lifetime and recovery", (reader) => {
	it("does not read or refresh without a current login", async () => {
		const { client, requests, wrapper } = setup(() =>
			Response.json(reader.page()),
		);
		const { result } = renderHook(() => reader.useReader("", client), {
			wrapper,
		});
		await act(async () => {
			await result.current.refetch();
			focusManager.setFocused(false);
			focusManager.setFocused(true);
		});
		expect(result.current.data).toBeUndefined();
		expect(result.current.isFetching).toBe(false);
		expect(requests).toEqual([]);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it.each([
		{ failure: 401, reason: "authentication-required" },
		{ failure: 403, reason: "denied" },
		{ failure: 404, reason: "not-found" },
		{ failure: "invalid", reason: "invalid-response" },
	] as const)(
		"clears earlier results and blocks retained/background reads on $failure",
		async ({ failure, reason }) => {
			let failed = false;
			const { client, requests, wrapper } = setup(() =>
				!failed
					? Response.json(reader.page("Previously permitted data"))
					: failure === "invalid"
						? Response.json({ items: [{ unexpected: true }], nextCursor: null })
						: new Response("Controlled opaque failure", { status: failure }),
			);
			const { result } = renderHook(() => reader.useReader("login-a", client), {
				wrapper,
			});
			await waitFor(() => expect(result.current.data?.kind).toBe("ready"));
			const retainedRefresh = result.current.refetch;
			failed = true;
			await act(async () => {
				await result.current.refetch();
			});
			await waitFor(() =>
				expect(result.current.data).toEqual({
					kind: "unavailable",
					retryable: false,
					reason,
				}),
			);
			await act(async () => {
				await retainedRefresh();
				await result.current.refetch();
				focusManager.setFocused(false);
				focusManager.setFocused(true);
			});
			expect(requests).toHaveLength(2);
			expect(result.current.isFetching).toBe(false);
			expect(globalThis.fetch).not.toHaveBeenCalled();
		},
	);

	it("aborts pagination and blocks late completion/retained refresh after unmount", async () => {
		const pending = deferred<Response>();
		const { client, requests, wrapper } = setup((request) =>
			new URL(request.url).searchParams.has("cursor")
				? pending.promise
				: Response.json(reader.page("Old first page", "opaque-next/+?=")),
		);
		const { result, unmount } = renderHook(
			() => reader.useReader("login-a", client),
			{ wrapper },
		);
		await waitFor(() => expect(requests).toHaveLength(2));
		expect(result.current.data).toBeUndefined();
		const retainedRefresh = result.current.refetch;
		unmount();
		expect(requests[1].signal.aborted).toBe(true);
		await act(async () => {
			pending.resolve(Response.json(reader.page("Old late data")));
			await retainedRefresh();
		});
		expect(requests).toHaveLength(2);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("preserves the existing successful-mutation invalidation prefix", async () => {
		let changed = false;
		const { client, requests, wrapper, queryClient } = setup(() =>
			Response.json(
				reader.page(
					changed ? "Updated authorized data" : "Original authorized data",
				),
			),
		);
		const { result } = renderHook(() => reader.useReader("login-a", client), {
			wrapper,
		});
		await waitFor(() => expect(result.current.data?.kind).toBe("ready"));
		changed = true;
		await act(async () => {
			await queryClient.invalidateQueries({ queryKey: reader.prefix });
		});
		await waitFor(() =>
			expect(JSON.stringify(result.current.data)).toContain(
				"Updated authorized data",
			),
		);
		expect(requests).toHaveLength(2);
		if (reader.name === "Owner Agents") {
			expect(requests.map((request) => new URL(request.url).search)).toEqual([
				"?scope=owner",
				"?scope=owner",
			]);
		}
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("allows an explicit current-login retry to recover a service error", async () => {
		let failed = true;
		const { client, requests, wrapper } = setup(() =>
			failed
				? new Response("Controlled service failure", { status: 503 })
				: Response.json(reader.page("Recovered authorized data")),
		);
		const { result } = renderHook(() => reader.useReader("login-a", client), {
			wrapper,
		});
		await waitFor(() => expect(result.current.isError).toBe(true));
		failed = false;
		await act(async () => {
			await result.current.refetch();
		});
		await waitFor(() => expect(result.current.data?.kind).toBe("ready"));
		expect(requests).toHaveLength(2);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});

describe("Existing workbench collections respect the current login", () => {
	it("reads only the current applicant collection through the generated SDK", async () => {
		const { client, requests, wrapper } = setup(() =>
			Response.json({ items: [pendingApplication], nextCursor: null }),
		);
		const { result } = renderHook(
			() => useMyAgentApplications({ identityKey: "login-a", client }),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.data?.kind).toBe("ready"));
		expect(requests).toHaveLength(1);
		expect(requests[0].method).toBe("GET");
		expect(requests[0].url).toBe(
			"https://platform.example.test/api/v2/agent-applications",
		);
		expect(requests[0].body).toBe(null);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
	it("reads the visible collection through the generated SDK without submitting identity", async () => {
		const { client, requests, wrapper } = setup(() =>
			Response.json({
				items: [agent],
				nextCursor: null,
			}),
		);
		const { result } = renderHook(
			() => useAgentDiscovery({ identityKey: "login-a", client }),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.data?.kind).toBe("ready"));
		expect(requests).toHaveLength(1);
		expect(requests[0].method).toBe("GET");
		expect(requests[0].url).toBe("https://platform.example.test/api/v2/agents");
		expect(requests[0].credentials).toBe("same-origin");
		expect(requests[0].body).toBe(null);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("cancels old pagination and blocks retained refresh callbacks after a login change", async () => {
		const pending = deferred<Response>();
		let currentLogin = false;
		const { client, requests, wrapper } = setup((request) =>
			currentLogin
				? Response.json({
						items: [{ ...agent, name: "Current login Agent" }],
						nextCursor: null,
					})
				: new URL(request.url).searchParams.has("cursor")
					? pending.promise
					: Response.json({
							items: [{ ...agent, name: "Old login Agent" }],
							nextCursor: "opaque-next/+?=",
						}),
		);
		const { result, rerender } = renderHook(
			({ identityKey }) => useAgentDiscovery({ identityKey, client }),
			{ wrapper, initialProps: { identityKey: "login-a" } },
		);
		await waitFor(() => expect(requests).toHaveLength(2));
		expect(result.current.data).toBeUndefined();
		const retainedRefresh = result.current.refetch;
		currentLogin = true;
		rerender({ identityKey: "login-b" });
		await waitFor(() =>
			expect(result.current.data).toMatchObject({
				kind: "ready",
				agents: [{ name: "Current login Agent" }],
			}),
		);
		expect(requests[1].signal.aborted).toBe(true);
		await act(async () => {
			pending.resolve(
				Response.json({
					items: [{ ...agent, name: "Old late Agent" }],
					nextCursor: null,
				}),
			);
			await retainedRefresh();
		});
		expect(requests).toHaveLength(3);
		expect(result.current.data).toMatchObject({
			kind: "ready",
			agents: [{ name: "Current login Agent" }],
		});
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("blocks an old applicant refresh while a new login reads its own applications", async () => {
		const pending = deferred<Response>();
		let currentLogin = false;
		const { client, requests, wrapper } = setup((request) =>
			currentLogin
				? Response.json({
						items: [
							{ ...pendingApplication, name: "Current login application" },
						],
						nextCursor: null,
					})
				: new URL(request.url).searchParams.has("cursor")
					? pending.promise
					: Response.json({
							items: [{ ...pendingApplication, name: "Old login application" }],
							nextCursor: "opaque-next/+?=",
						}),
		);
		const { result, rerender } = renderHook(
			({ identityKey }) => useMyAgentApplications({ identityKey, client }),
			{ wrapper, initialProps: { identityKey: "login-a" } },
		);
		await waitFor(() => expect(requests).toHaveLength(2));
		expect(result.current.data).toBeUndefined();
		const retainedRefresh = result.current.refetch;
		currentLogin = true;
		rerender({ identityKey: "login-b" });
		await waitFor(() =>
			expect(result.current.data).toMatchObject({
				kind: "ready",
				applications: [{ name: "Current login application" }],
			}),
		);
		expect(requests[1].signal.aborted).toBe(true);
		await act(async () => {
			pending.resolve(
				Response.json({
					items: [{ ...pendingApplication, name: "Old late application" }],
					nextCursor: null,
				}),
			);
			await retainedRefresh();
		});
		expect(requests).toHaveLength(3);
		expect(result.current.data).toMatchObject({
			kind: "ready",
			applications: [{ name: "Current login application" }],
		});
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});
