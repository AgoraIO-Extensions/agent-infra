import { once } from "node:events";
import { createServer } from "node:http";
import { ConversationPageV1Schema } from "@agent-infra/contracts/pilot";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createClient, createConfig } from "../generated-v2/client/index.js";
import { listRecentPersonalConversationsV2 } from "../generated-v2/index.js";
import type {
	ListRecentPersonalConversationsV2Data,
	ListRecentPersonalConversationsV2Responses,
} from "../generated-v2/types.gen.js";

describe("recent personal conversation generated Client", () => {
	it("exposes only limit/cursor and V1 metadata without path or body inputs", () => {
		expectTypeOf<
			ListRecentPersonalConversationsV2Data["query"]
		>().toEqualTypeOf<{ cursor?: string; limit?: number } | undefined>();
		expectTypeOf<
			ListRecentPersonalConversationsV2Data["body"]
		>().toEqualTypeOf<undefined>();
		expectTypeOf<
			ListRecentPersonalConversationsV2Data["path"]
		>().toEqualTypeOf<undefined>();
		expectTypeOf<
			ListRecentPersonalConversationsV2Responses[200]["items"][number]["schemaVersion"]
		>().toEqualTypeOf<1>();
	});

	it("reads ordered metadata/continuation and protocol errors over loopback HTTP", async () => {
		const cursor = "opaque:boundary/+==";
		const page = ConversationPageV1Schema.parse({
			items: ["z", "a"].map((id) => ({
				schemaVersion: 1,
				conversationId: `conversation-${id}`,
				agentId: `agent-${id}`,
				title: null,
				status: "ready",
				selectedModelOptionId: null,
				selectedReasoningLevel: null,
				lastConversationCursor: null,
				createdAt: "2026-10-01T00:00:00Z",
				updatedAt: "2026-10-01T01:00:00Z",
			})),
			nextCursor: cursor,
		});
		const requests: {
			method: string | undefined;
			path: string;
			query: Record<string, string>;
			cookie: string | undefined;
			body: string;
		}[] = [];
		const server = createServer(async (request, response) => {
			const url = new URL(request.url ?? "", "http://localhost");
			let body = "";
			for await (const chunk of request) body += chunk;
			requests.push({
				method: request.method,
				path: url.pathname,
				query: Object.fromEntries(url.searchParams),
				cookie: request.headers.cookie,
				body,
			});
			response.setHeader("content-type", "application/json");
			const fault = url.searchParams.get("cursor");
			if (fault === "denied" || fault === "unavailable") {
				response.statusCode = fault === "denied" ? 403 : 503;
				response.end(
					JSON.stringify({
						schemaVersion: 1,
						code:
							fault === "denied"
								? "AUTHORIZATION_REVOKED"
								: "DEPENDENCY_UNAVAILABLE",
						retryable: fault !== "denied",
						message: "Controlled contract response",
						traceId: "contract-trace",
					}),
				);
			} else response.end(JSON.stringify(page));
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		try {
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("Loopback listener unavailable");
			const client = createClient(
				createConfig({
					baseUrl: `http://127.0.0.1:${address.port}`,
					credentials: "include",
					headers: { Cookie: "__Host-platform-session=contract-fixture" },
				}),
			);
			const first = await listRecentPersonalConversationsV2({ client });
			expect(first.response?.status).toBe(200);
			expect(first.data).toEqual(page);
			expect(requests[0]).toEqual({
				method: "GET",
				path: "/api/v2/me/conversations/recent",
				query: {},
				cookie: "__Host-platform-session=contract-fixture",
				body: "",
			});
			const next = await listRecentPersonalConversationsV2({
				client,
				query: { limit: 100, cursor: first.data?.nextCursor ?? undefined },
			});
			expect(next.data?.items.map((item) => item.conversationId)).toEqual([
				"conversation-z",
				"conversation-a",
			]);
			expect(requests[1]?.query).toEqual({ limit: "100", cursor });
			for (const [fault, status, code, retryable] of [
				["denied", 403, "AUTHORIZATION_REVOKED", false],
				["unavailable", 503, "DEPENDENCY_UNAVAILABLE", true],
			] as const) {
				const result = await listRecentPersonalConversationsV2({
					client,
					query: { cursor: fault },
				});
				expect(result.response?.status).toBe(status);
				expect(result.data).toBeUndefined();
				expect(result.error).toMatchObject({ code, retryable });
			}
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
});
