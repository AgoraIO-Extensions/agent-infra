import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type Client,
	createClient,
} from "../pilot/generated-v2/client/index.js";
import { useApiCredentials } from "./api-credentials/use-api-credentials.js";
import { loadOwnApplication } from "./application-management/application-management.js";
import { useOwnApplication } from "./application-management/use-application-management.js";

const timestamp = "2026-10-10T00:00:00Z";
const readers = [
	{
		name: "personal credentials",
		prefix: ["api-credentials"],
		read: (identityKey: string, client: Client, _applicationId: string) =>
			useApiCredentials({ identityKey, client }),
		response: (marker: string) => ({
			items: [
				{
					credentialId: marker,
					scopes: ["agent:read"],
					expiresAt: null,
					revokedAt: null,
					createdAt: timestamp,
					lastUsedAt: null,
				},
			],
			nextCursor: null,
		}),
	},
	{
		name: "owned application",
		prefix: ["application-management"],
		read: (identityKey: string, client: Client, applicationId: string) =>
			useOwnApplication({ identityKey, client, applicationId }),
		response: (marker: string) => ({
			applicationId: marker,
			name: marker,
			responsibleUserId: "controlled-owner",
			status: "active",
			authorizationRevision: "revision-1",
			createdAt: timestamp,
			updatedAt: timestamp,
		}),
	},
];

const queryClients: QueryClient[] = [];
function setup(handler: (request: Request) => Response | Promise<Response>) {
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
	for (const client of queryClients.splice(0)) client.clear();
	vi.restoreAllMocks();
});

describe.each(readers)("$name read lifetime", (reader) => {
	it("recovers from a failed manual refresh on a successful background read", async () => {
		let failed = false;
		const { client, queryClient, wrapper } = setup(() => {
			if (failed) throw new Error("Controlled transport failure");
			return Response.json(reader.response("current-data"));
		});
		const { result } = renderHook(
			() => reader.read("login-a", client, "application-a"),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.state.kind).toBe("ready"));
		failed = true;
		await act(async () => {
			await result.current.refetch();
		});
		await waitFor(() => expect(result.current.state.kind).toBe("unavailable"));
		expect(JSON.stringify(result.current.state)).not.toContain("current-data");
		failed = false;
		await act(async () => {
			await queryClient.invalidateQueries({ queryKey: reader.prefix });
		});
		await waitFor(() => expect(result.current.state.kind).toBe("ready"));
	});

	it.each(["success", "failure"])(
		"cancels an old login refresh and ignores its late %s",
		async (outcome) => {
			let finish!: (response: Response) => void;
			let fail!: (error: Error) => void;
			const late = new Promise<Response>((resolve, reject) => {
				finish = resolve;
				fail = reject;
			});
			let calls = 0;
			const { client, requests, queryClient, wrapper } = setup(() => {
				calls += 1;
				return calls === 2
					? late
					: Response.json(
							reader.response(calls === 1 ? "old-data" : "new-data"),
						);
			});
			const { result, rerender } = renderHook(
				({ identityKey }) => reader.read(identityKey, client, "application-a"),
				{ wrapper, initialProps: { identityKey: "login-a" } },
			);
			await waitFor(() => expect(result.current.state.kind).toBe("ready"));
			let refreshing: Promise<unknown>;
			act(() => {
				refreshing = result.current.refetch();
			});
			await waitFor(() => expect(requests).toHaveLength(2));
			rerender({ identityKey: "login-b" });
			await waitFor(() =>
				expect(JSON.stringify(result.current.state)).toContain("new-data"),
			);
			expect(requests[1]?.signal.aborted).toBe(true);
			await act(async () => {
				if (outcome === "success")
					finish(Response.json(reader.response("old-late-data")));
				else fail(new Error("Old login transport failure"));
				await refreshing;
			});
			expect(result.current.state.kind).toBe("ready");
			expect(JSON.stringify(result.current.state)).toContain("new-data");
			expect(
				JSON.stringify(
					queryClient
						.getQueryCache()
						.getAll()
						.map((q) => q.state.data),
				),
			).not.toContain("old-data");
		},
	);

	it("hides cached data on authorization failure and does not read after unmount", async () => {
		let denied = false;
		const { client, requests, wrapper } = setup(() =>
			denied
				? new Response("Controlled denial", { status: 403 })
				: Response.json(reader.response("old-data")),
		);
		const { result, unmount } = renderHook(
			() => reader.read("login-a", client, "application-a"),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.state.kind).toBe("ready"));
		denied = true;
		await act(async () => {
			await result.current.refetch();
		});
		await waitFor(() =>
			expect(result.current.state).toEqual({
				kind: "unavailable",
				reason: "denied",
				retryable: false,
			}),
		);
		const refresh = result.current.refetch;
		unmount();
		await refresh();
		expect(requests).toHaveLength(2);
	});

	it("does not read without a current login", async () => {
		const { client, requests, wrapper } = setup(() =>
			Response.json(reader.response("unexpected")),
		);
		const { result } = renderHook(
			() => reader.read("", client, "application-a"),
			{ wrapper },
		);
		await act(async () => {
			await result.current.refetch();
		});
		expect(result.current.state.kind).toBe("denied");
		expect(requests).toHaveLength(0);
	});
});

it("cancels the old application GET when switching application IDs", async () => {
	let finish!: (response: Response) => void;
	const late = new Promise<Response>((resolve) => {
		finish = resolve;
	});
	const reader = readers[1];
	if (!reader) throw new Error("Missing owned application reader");
	const { client, requests, wrapper } = setup((request) =>
		request.url.endsWith("application-a")
			? late
			: Response.json(reader.response("application-b")),
	);
	const { result, rerender } = renderHook(
		({ applicationId }) =>
			useOwnApplication({ identityKey: "login-a", applicationId, client }),
		{ wrapper, initialProps: { applicationId: "application-a" } },
	);
	await waitFor(() => expect(requests).toHaveLength(1));
	const oldSignal = requests[0]?.signal;
	act(() => rerender({ applicationId: "application-b" }));
	await waitFor(() =>
		expect(JSON.stringify(result.current.state)).toContain("application-b"),
	);
	expect(oldSignal?.aborted).toBe(true);
	await act(async () => {
		finish(Response.json(reader.response("application-a")));
		await late;
	});
	expect(JSON.stringify(result.current.state)).not.toContain("application-a");
});

it("distinguishes absent selection from an unavailable requested application", async () => {
	const { client, requests } = setup(
		() => new Response("Controlled missing resource", { status: 404 }),
	);
	expect(await loadOwnApplication("", client)).toEqual({ kind: "empty" });
	expect(requests).toHaveLength(0);
	expect(await loadOwnApplication("foreign-or-missing", client)).toEqual({
		kind: "unavailable",
		reason: "not-found",
		retryable: false,
	});
});
