import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "../../pilot/generated-v2/client/index.js";
import {
	deferred,
	history,
} from "../conversation/conversation-test-fixtures.js";
import { useRecentPersonalConversations } from "./use-recent-personal-conversations.js";

const page = (ids: string[], nextCursor: string | null = null) => ({
	items: ids.map((id, index) => ({
		...history(id).conversation,
		agentId: `agent-${index}`,
	})),
	nextCursor,
});
const clients: QueryClient[] = [];
function setup(
	handler: (request: Request) => Response | Promise<Response>,
	identityKey = "login-a",
) {
	const queryClient = new QueryClient();
	clients.push(queryClient);
	const requests: Request[] = [];
	const client = createClient({
		baseUrl: "https://platform.example.test",
		fetch: async (input, init) => {
			const request = new Request(input, init);
			requests.push(request);
			return (await handler(request)).clone();
		},
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			<StrictMode>{children}</StrictMode>
		</QueryClientProvider>
	);
	return {
		...renderHook(
			(props: { identityKey: string }) =>
				useRecentPersonalConversations({ ...props, client }),
			{ initialProps: { identityKey }, wrapper },
		),
		requests,
		queryClient,
	};
}
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
});

describe("Personal recent login and continuation lifetime", () => {
	it("waits for a confirmed empty response and does not read without a login", async () => {
		const pending = deferred<Response>();
		const hook = setup(() => pending.promise);
		expect(hook.result.current.state).toEqual({ kind: "loading" });
		await act(async () => pending.resolve(Response.json(page([]))));
		await waitFor(() =>
			expect(hook.result.current.state).toEqual({
				kind: "ready",
				conversations: [],
				nextCursor: null,
			}),
		);
		hook.rerender({ identityKey: "" });
		const count = hook.requests.length;
		await act(async () => {
			await hook.result.current.refresh();
			await hook.result.current.loadMore();
		});
		expect(hook.requests).toHaveLength(count);
		expect(hook.result.current.state).toEqual({
			kind: "unavailable",
			retryable: false,
		});
	});

	it("preserves producer ordering and refreshes the current first page without an old continuation", async () => {
		let fresh = false;
		const hook = setup((request) => {
			const cursor = new URL(request.url).searchParams.get("cursor");
			return Response.json(
				fresh
					? page(["current-first"])
					: cursor
						? page(["later-agent-history"])
						: page(["recent-z", "recent-a"], "opaque-next/+?="),
			);
		});
		await waitFor(() => expect(hook.result.current.state.kind).toBe("ready"));
		await act(async () => hook.result.current.loadMore());
		await waitFor(() =>
			expect(hook.result.current.state).toMatchObject({
				kind: "ready",
				conversations: [
					{ conversationId: "recent-z" },
					{ conversationId: "recent-a" },
					{ conversationId: "later-agent-history" },
				],
			}),
		);
		fresh = true;
		await act(async () => hook.result.current.refresh());
		await waitFor(() =>
			expect(hook.result.current.state).toMatchObject({
				kind: "ready",
				conversations: [{ conversationId: "current-first" }],
				nextCursor: null,
			}),
		);
		expect(
			new URL(hook.requests.at(-1)?.url ?? "").searchParams.has("cursor"),
		).toBe(false);
		expect(
			hook.requests.every(
				(request) => request.method === "GET" && request.body === null,
			),
		).toBe(true);
	});

	it("keeps valid history beyond 100 user-requested pages without clearing rows or blocking continuation", async () => {
		const hook = setup((request) => {
			const cursor = new URL(request.url).searchParams.get("cursor");
			const index = cursor === null ? 0 : Number(cursor.slice("page-".length));
			return Response.json(page([`history-${index}`], `page-${index + 1}`));
		});
		await waitFor(() => expect(hook.result.current.state.kind).toBe("ready"));
		const initialReads = hook.requests.length;
		for (let index = 0; index < 101; index++)
			await act(async () => hook.result.current.loadMore());
		expect(hook.requests).toHaveLength(initialReads + 101);
		await waitFor(() =>
			expect(hook.result.current.state).toMatchObject({
				kind: "ready",
				conversations: Array.from({ length: 102 }, (_, index) => ({
					conversationId: `history-${index}`,
				})),
				nextCursor: "page-102",
			}),
		);
		expect(
			hook.requests.every(
				(request) =>
					request.method === "GET" &&
					new URL(request.url).searchParams.get("limit") === "50",
			),
		).toBe(true);
	});

	it("removes prior rows after a continuation failure; retained load-more cannot revive them and retry starts fresh", async () => {
		let recover = false;
		const hook = setup((request) =>
			new URL(request.url).searchParams.has("cursor")
				? new Response("Controlled unavailable", { status: 503 })
				: Response.json(
						page(
							[recover ? "recovered-first" : "old-first"],
							recover ? null : "old-cursor",
						),
					),
		);
		await waitFor(() => expect(hook.result.current.state.kind).toBe("ready"));
		const oldMore = hook.result.current.loadMore;
		await act(async () => oldMore());
		await waitFor(() =>
			expect(hook.result.current.state).toEqual({
				kind: "unavailable",
				retryable: true,
			}),
		);
		const count = hook.requests.length;
		await act(async () => oldMore());
		expect(hook.requests).toHaveLength(count);
		recover = true;
		await act(async () => hook.result.current.refresh());
		await waitFor(() =>
			expect(hook.result.current.state).toMatchObject({
				kind: "ready",
				conversations: [{ conversationId: "recovered-first" }],
			}),
		);
	});

	it("cancels the old login/role continuation and rejects ignored abort results and retained callbacks", async () => {
		const late = deferred<Response>();
		let nextIdentity = false;
		const hook = setup((request) =>
			new URL(request.url).searchParams.has("cursor")
				? late.promise
				: Response.json(
						page(
							[nextIdentity ? "person-b" : "person-a"],
							nextIdentity ? null : "person-a-cursor",
						),
					),
		);
		await waitFor(() => expect(hook.result.current.state.kind).toBe("ready"));
		const oldMore = hook.result.current.loadMore;
		const oldRefresh = hook.result.current.refresh;
		let reading!: Promise<void>;
		act(() => {
			reading = oldMore();
		});
		await waitFor(() =>
			expect(
				hook.requests.some((request) =>
					new URL(request.url).searchParams.has("cursor"),
				),
			).toBe(true),
		);
		const oldRequest = hook.requests.find((request) =>
			new URL(request.url).searchParams.has("cursor"),
		);
		nextIdentity = true;
		hook.rerender({ identityKey: "login-b:role-change" });
		expect(oldRequest?.signal.aborted).toBe(true);
		await act(async () => {
			late.resolve(Response.json(page(["late-person-a"])));
			await reading;
			await oldMore();
			await oldRefresh();
		});
		await waitFor(() =>
			expect(hook.result.current.state).toMatchObject({
				kind: "ready",
				conversations: [{ conversationId: "person-b" }],
			}),
		);
		expect(
			JSON.stringify(
				hook.queryClient
					.getQueryCache()
					.getAll()
					.map((query) => query.state.data),
			),
		).not.toContain("person-a");
	});

	it.each([
		[401, "authentication-required"],
		[403, "denied"],
		[404, "not-found"],
	] as const)(
		"clears earlier pages on %s and blocks old refresh/continuation",
		async (status, reason) => {
			const hook = setup((request) =>
				new URL(request.url).searchParams.has("cursor")
					? new Response("Controlled denial", { status })
					: Response.json(page(["old-personal-row"], "opaque-old")),
			);
			await waitFor(() => expect(hook.result.current.state.kind).toBe("ready"));
			const oldMore = hook.result.current.loadMore;
			const oldRefresh = hook.result.current.refresh;
			await act(async () => oldMore());
			await waitFor(() =>
				expect(hook.result.current.state).toEqual({
					kind: "unavailable",
					retryable: false,
					reason,
				}),
			);
			const count = hook.requests.length;
			await act(async () => {
				await oldMore();
				await oldRefresh();
			});
			expect(hook.requests).toHaveLength(count);
			expect(
				JSON.stringify(
					hook.queryClient
						.getQueryCache()
						.getAll()
						.map((query) => query.state.data),
				),
			).not.toContain("old-personal-row");
		},
	);

	it("rejects a cursor cycle spanning several pages without reporting partial success", async () => {
		const hook = setup((request) => {
			const cursor = new URL(request.url).searchParams.get("cursor");
			return Response.json(
				page(
					[cursor ?? "first"],
					cursor === "cursor-b"
						? "cursor-a"
						: cursor === "cursor-a"
							? "cursor-b"
							: "cursor-a",
				),
			);
		});
		await waitFor(() => expect(hook.result.current.state.kind).toBe("ready"));
		await act(async () => hook.result.current.loadMore());
		await act(async () => hook.result.current.loadMore());
		await waitFor(() =>
			expect(hook.result.current.state).toEqual({
				kind: "unavailable",
				retryable: false,
				reason: "invalid-response",
			}),
		);
		expect(
			JSON.stringify(
				hook.queryClient
					.getQueryCache()
					.getAll()
					.map((query) => query.state.data),
			),
		).not.toContain("conversationId");
	});
});
