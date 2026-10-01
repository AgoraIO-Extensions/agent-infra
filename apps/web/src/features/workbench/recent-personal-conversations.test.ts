import { ConversationPageV1Schema } from "@agent-infra/contracts/pilot";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "../../pilot/generated-v2/client/index.js";
import { history } from "../conversation/conversation-test-fixtures.js";
import { loadRecentPersonalConversationsPage } from "./recent-personal-conversations.js";

const page = ConversationPageV1Schema.parse({
	items: [
		{
			...history("conversation-z").conversation,
			agentId: "agent-b",
			updatedAt: "2026-10-01T03:00:00Z",
		},
		{
			...history("conversation-a").conversation,
			agentId: "agent-a",
			updatedAt: "2026-10-01T02:00:00Z",
		},
		{
			...history("conversation-m").conversation,
			agentId: "agent-b",
			updatedAt: "2026-10-01T01:00:00Z",
		},
	],
	nextCursor: "opaque/+?=游标",
});

describe("Personal recent generated Client read", () => {
	it("preserves cross-Agent producer order and sends only bounded limit and opaque cursor", async () => {
		const requests: Request[] = [];
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async (request) => {
				requests.push(new Request(request));
				return Response.json({ ...page, nextCursor: null });
			},
		});
		await expect(
			loadRecentPersonalConversationsPage({
				client,
				cursor: page.nextCursor,
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({ ...page, nextCursor: null });
		const request = requests[0];
		expect(request?.method).toBe("GET");
		expect(request?.body).toBeNull();
		const url = new URL(request?.url ?? "");
		expect(url.pathname).toBe("/api/v2/me/conversations/recent");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			limit: "50",
			cursor: page.nextCursor,
		});
	});

	it.each([
		[401, "authentication-required", false],
		[403, "denied", false],
		[404, "not-found", false],
		[503, undefined, true],
	] as const)(
		"keeps HTTP %s distinct without caching an opaque error body",
		async (status, reason, retryable) => {
			const client = createClient({
				baseUrl: "https://platform.example.test",
				fetch: async () =>
					Response.json({ detail: "controlled failure" }, { status }),
			});
			await expect(
				loadRecentPersonalConversationsPage({
					client,
					signal: new AbortController().signal,
				}),
			).rejects.toMatchObject({
				state: {
					kind: "unavailable",
					retryable,
					...(reason ? { reason } : {}),
				},
			});
		},
	);

	it.each([
		{ ...page, items: [{ ...page.items[0], schemaVersion: 2 }] },
		{
			...page,
			items: Array.from({ length: 51 }, (_, index) => ({
				...page.items[0],
				conversationId: `conversation-${index}`,
			})),
		},
		page,
	])(
		"rejects invalid DTO, oversized page and self-repeating cursor",
		async (body) => {
			const client = createClient({
				baseUrl: "https://platform.example.test",
				fetch: async () => Response.json(body),
			});
			await expect(
				loadRecentPersonalConversationsPage({
					client,
					cursor: page.nextCursor,
					signal: new AbortController().signal,
				}),
			).rejects.toMatchObject({
				state: {
					kind: "unavailable",
					retryable: false,
					reason: "invalid-response",
				},
			});
		},
	);

	it("discards a successful response from a transport that ignores cancellation", async () => {
		const controller = new AbortController();
		const fetch = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				expect(request.signal.aborted).toBe(false);
				controller.abort();
				return Response.json(page);
			},
		);
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch,
		});
		await expect(
			loadRecentPersonalConversationsPage({
				client,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fetch).toHaveBeenCalledTimes(1);
		await expect(
			loadRecentPersonalConversationsPage({
				client,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
