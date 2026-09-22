import {
	ConversationPageV1Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import { describe, expect, it } from "vitest";
import { createClient } from "../../pilot/generated/client/index.js";
import { loadConversationHistoryPage } from "./conversation-history.js";
import { deferred, history } from "./conversation-test-fixtures.js";
import { ConversationReadError } from "./execution-detail.js";

function page() {
	return ConversationPageV1Schema.parse({
		items: [history().conversation],
		nextCursor: "opaque cursor+/=",
	});
}

function setup(handler: (request: Request) => Response | Promise<Response>) {
	const requests: Request[] = [];
	const client = createClient({
		baseUrl: "https://platform.example.test",
		fetch: async (input, init) => {
			const request = new Request(input, init);
			requests.push(request);
			return handler(request);
		},
	});
	const controller = new AbortController();
	return {
		requests,
		controller,
		read: (options: { cursor?: string | null } = {}) =>
			loadConversationHistoryPage({
				...options,
				agentId: "agent-1",
				client,
				signal: controller.signal,
			}),
	};
}

describe("Personal conversation history generated-client transport", () => {
	it("reads one bounded page and preserves the opaque cursor without wire identity fields", async () => {
		const { read, requests } = setup(() => Response.json(page()));
		expect(await read()).toEqual(page());
		expect(requests).toHaveLength(1);
		const url = new URL(requests[0].url);
		expect(url.pathname).toBe("/api/v1/agents/agent-1/conversations");
		expect([...url.searchParams]).toEqual([["limit", "50"]]);
		expect(requests[0].method).toBe("GET");
		expect(requests[0].body).toBeNull();
		expect(requests[0].headers.has("Idempotency-Key")).toBe(false);
	});

	it("round-trips cursor punctuation without parsing or replacing it", async () => {
		const cursor = "opaque cursor+/=?&";
		const { read, requests } = setup(() =>
			Response.json({ ...page(), nextCursor: null }),
		);
		await read({ cursor });
		expect(new URL(requests[0].url).searchParams.get("cursor")).toBe(cursor);
	});

	it("returns a confirmed empty page as data", async () => {
		const empty = ConversationPageV1Schema.parse({
			items: [],
			nextCursor: null,
		});
		const { read } = setup(() => Response.json(empty));
		expect(await read()).toEqual(empty);
	});

	it.each([401, 403, 404])(
		"rejects HTTP %s without revealing response text",
		async (status) => {
			const { read } = setup(() =>
				Response.json(
					{ message: "Synthetic foreign conversation title" },
					{ status },
				),
			);
			await expect(read()).rejects.toMatchObject({
				message: "Conversation data is unavailable",
				failure: { kind: "authorization", status },
			});
		},
	);

	it("honors a schema-valid authorization revocation on a dependency response", async () => {
		const error = PilotProtocolErrorV1Schema.parse({
			schemaVersion: 1,
			code: "AUTHORIZATION_REVOKED",
			message: "Synthetic private error detail",
			retryable: false,
			traceId: "trace-history",
		});
		const { read } = setup(() => Response.json(error, { status: 503 }));
		await expect(read()).rejects.toMatchObject({
			failure: { kind: "authorization" },
		});
	});

	it.each([
		[400, "http"],
		[500, "service"],
		[503, "service"],
	] as const)(
		"keeps HTTP %s distinct from an empty list",
		async (status, kind) => {
			const { read } = setup(
				() => new Response("Synthetic failure", { status }),
			);
			await expect(read()).rejects.toMatchObject({ failure: { kind, status } });
		},
	);

	it("sanitizes thrown transport failures", async () => {
		const { read } = setup(() => {
			throw new Error("Synthetic sensitive request details");
		});
		const error = await read().catch((value: unknown) => value);
		expect(error).toBeInstanceOf(ConversationReadError);
		expect(error).toMatchObject({ failure: { kind: "network" } });
		expect(JSON.stringify(error)).not.toContain("sensitive");
	});

	it.each(["schema", "agent", "cursor", "limit", "internal-field"] as const)(
		"rejects an invalid %s response atomically",
		async (invalid) => {
			const data = page();
			const body =
				invalid === "schema"
					? { items: [] }
					: invalid === "agent"
						? {
								...data,
								items: [
									data.items[0],
									{
										...data.items[0],
										conversationId: "foreign",
										agentId: "agent-2",
									},
								],
							}
						: invalid === "cursor"
							? { ...data, nextCursor: "" }
							: invalid === "limit"
								? {
										...data,
										items: Array.from({ length: 51 }, (_, index) => ({
											...data.items[0],
											conversationId: `conversation-${index}`,
										})),
									}
								: {
										...data,
										items: [{ ...data.items[0], runtimeId: "internal" }],
									};
			const { read } = setup(() => Response.json(body));
			await expect(read()).rejects.toMatchObject({
				failure: { kind: "invalid" },
			});
		},
	);

	it.each([201, 202, 206])(
		"rejects an otherwise valid page under HTTP %s",
		async (status) => {
			const { read } = setup(() => Response.json(page(), { status }));
			await expect(read()).rejects.toMatchObject({
				failure: { kind: "invalid", status },
			});
		},
	);

	it("rejects the same continuation cursor", async () => {
		const { read } = setup(() =>
			Response.json({ ...page(), nextCursor: "cursor-a" }),
		);
		await expect(
			read({
				cursor: "cursor-a",
			}),
		).rejects.toMatchObject({ failure: { kind: "invalid" } });
	});

	it("rejects a malformed cursor before issuing a request", async () => {
		const { read, requests } = setup(() => Response.json(page()));
		await expect(read({ cursor: "" })).rejects.toMatchObject({
			failure: { kind: "invalid" },
		});
		expect(requests).toEqual([]);
	});

	it("ignores late data from a transport that does not honor cancellation", async () => {
		const pending = deferred<Response>();
		const { read, controller } = setup(() => pending.promise);
		const result = read().catch((error: unknown) => error);
		controller.abort();
		pending.resolve(Response.json(page()));
		expect(await result).toMatchObject({ name: "AbortError" });
	});
});
