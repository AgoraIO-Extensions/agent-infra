import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../../pilot/generated-v2/client/index.js";
import { pendingApplication } from "../my-agents/test-fixtures.js";
import { useWorkbenchCollections } from "./use-workbench-collections.js";

const agent = pilotFakeScenariosV2.starting.response.body;
const clients: QueryClient[] = [];
type Selection = { identityKey: string; administrator: boolean };
const employee: Selection = {
	identityKey: "login-a:employee",
	administrator: false,
};

function setup(
	handler: (request: Request) => Response | Promise<Response>,
	selection = employee,
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
		(props: Selection) => useWorkbenchCollections({ ...props, client }),
		{ wrapper, initialProps: selection },
	);
	return { ...hook, requests, queryClient };
}

function collectionResponse(request: Request) {
	const url = new URL(request.url);
	if (
		url.pathname === "/api/v2/agent-applications" ||
		url.pathname === "/api/v2/admin/agent-applications"
	) {
		return Response.json({ items: [pendingApplication], nextCursor: null });
	}
	if (
		url.pathname === "/api/v2/agents" ||
		url.pathname === "/api/v2/admin/agents"
	) {
		return Response.json({
			items: [
				{
					...agent,
					name: url.searchParams.has("scope") ? "Owned Agent" : "Visible Agent",
				},
			],
			nextCursor: null,
		});
	}
	throw new Error("Unexpected collection request");
}

afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
});

describe("Workbench existing collections", () => {
	it("does not read or show an indefinite loading state without a current login", async () => {
		const { result, requests } = setup(collectionResponse, {
			identityKey: "",
			administrator: true,
		});
		await act(async () => result.current.onRetry());
		expect(result.current.agents).toEqual({
			kind: "unavailable",
			retryable: false,
		});
		expect(result.current.ownerAgents).toEqual({
			kind: "unavailable",
			retryable: false,
		});
		expect(result.current.applications).toEqual({
			kind: "unavailable",
			retryable: false,
		});
		expect(result.current.pending).toEqual({
			kind: "unavailable",
			retryable: false,
		});
		expect(result.current.adminAgents).toEqual({ kind: "denied" });
		expect(result.current.refreshing).toBe(false);
		expect(requests).toEqual([]);
	});

	it("keeps employee, applicant and Owner reads separate without requesting administrator data", async () => {
		const { result, requests } = setup(collectionResponse);
		await waitFor(() => expect(result.current.refreshing).toBe(false));
		expect(result.current.agents).toMatchObject({
			kind: "ready",
			agents: [{ name: "Visible Agent" }],
		});
		expect(result.current.ownerAgents).toMatchObject({
			kind: "ready",
			agents: [{ name: "Owned Agent" }],
		});
		expect(result.current.applications).toMatchObject({
			kind: "ready",
			applications: [{ applicationId: pendingApplication.applicationId }],
		});
		expect(result.current.adminAgents).toEqual({ kind: "denied" });
		expect(result.current.pending).toEqual({
			kind: "unavailable",
			retryable: false,
		});
		expect(
			requests
				.map(
					(request) =>
						new URL(request.url).pathname + new URL(request.url).search,
				)
				.sort(),
		).toEqual([
			"/api/v2/agent-applications",
			"/api/v2/agents",
			"/api/v2/agents?scope=owner",
		]);
		expect(
			requests.every(
				(request) => request.method === "GET" && request.body === null,
			),
		).toBe(true);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it.each([
		{
			field: "agents",
			path: "/api/v2/agents",
			owner: false,
			failedState: { kind: "unavailable", retryable: true },
		},
		{
			field: "ownerAgents",
			path: "/api/v2/agents",
			owner: true,
			failedState: { kind: "unavailable", retryable: true },
		},
		{
			field: "applications",
			path: "/api/v2/agent-applications",
			failedState: { kind: "unavailable", retryable: true },
		},
		{
			field: "pending",
			path: "/api/v2/admin/agent-applications",
			failedState: { kind: "unavailable", retryable: true },
		},
		{
			field: "adminAgents",
			path: "/api/v2/admin/agents",
			failedState: { kind: "error", retryable: true },
		},
	] as const)(
		"removes previous $field rows on refresh failure and allows recovery without writes",
		async ({ field, path, failedState, ...scope }) => {
			let failed = false;
			const { result, requests } = setup(
				(request) => {
					const url = new URL(request.url);
					const selected =
						url.pathname === path &&
						(!("owner" in scope) ||
							(url.searchParams.get("scope") === "owner") === scope.owner);
					return failed && selected
						? new Response("Controlled service failure", { status: 503 })
						: collectionResponse(request);
				},
				{ identityKey: "login-a:administrator", administrator: true },
			);
			await waitFor(() => expect(result.current[field].kind).toBe("ready"));
			failed = true;
			await act(async () => result.current.onRetry());
			await waitFor(() => expect(result.current[field]).toEqual(failedState));
			failed = false;
			await act(async () => result.current.onRetry());
			await waitFor(() => expect(result.current[field].kind).toBe("ready"));
			expect(
				requests.every(
					(request) => request.method === "GET" && request.body === null,
				),
			).toBe(true);
			expect(globalThis.fetch).not.toHaveBeenCalled();
		},
	);

	it("cancels both administrator continuations on role loss and rejects late results and retained refresh", async () => {
		let finish!: (response: Response) => void;
		const late = new Promise<Response>((resolve) => {
			finish = resolve;
		});
		const { result, requests, rerender } = setup(
			(request) => {
				const url = new URL(request.url);
				if (!url.pathname.startsWith("/api/v2/admin/"))
					return collectionResponse(request);
				if (url.searchParams.has("cursor"))
					return late.then((response) => response.clone());
				return Response.json({
					items: url.pathname.endsWith("/agents")
						? [{ ...agent, name: "Old admin inventory" }]
						: [{ ...pendingApplication, name: "Old pending approval" }],
					nextCursor: "opaque-admin/+?=",
				});
			},
			{ identityKey: "login-a:administrator", administrator: true },
		);
		await waitFor(() => expect(requests).toHaveLength(7));
		expect(result.current.pending).toEqual({ kind: "loading" });
		expect(result.current.adminAgents).toEqual({ kind: "loading" });
		const oldRefresh = result.current.onRetry;
		const continuations = requests.filter((request) =>
			new URL(request.url).searchParams.has("cursor"),
		);
		rerender({ identityKey: "login-b:employee", administrator: false });
		expect(continuations.map((request) => request.signal.aborted)).toEqual([
			true,
			true,
		]);
		await act(async () => {
			finish(Response.json({ items: [], nextCursor: null }));
			oldRefresh();
		});
		await waitFor(() => expect(result.current.agents.kind).toBe("ready"));
		expect(result.current.pending).toEqual({
			kind: "unavailable",
			retryable: false,
		});
		expect(result.current.adminAgents).toEqual({ kind: "denied" });
		expect(requests).toHaveLength(10);
		expect(JSON.stringify(result.current)).not.toContain("Old admin");
		expect(JSON.stringify(result.current)).not.toContain("Old pending");
		expect(
			requests
				.slice(7)
				.every(
					(request) =>
						!new URL(request.url).pathname.startsWith("/api/v2/admin/"),
				),
		).toBe(true);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});
