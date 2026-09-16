import { PersistedConversationEventV2Schema } from "@agent-infra/contracts/pilot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../../pilot/generated-v2/client/index.js";
import {
	deferred,
	event,
	history,
	reload,
	route,
	sse,
	timestamp,
} from "./conversation-test-fixtures.js";
import {
	type ConversationTimelineState,
	createConversationTimeline,
} from "./conversation-timeline.js";

const readers: ReturnType<typeof createConversationTimeline>[] = [];

function setup(
	handler: (request: Request) => Response | Promise<Response>,
	headers?: Record<string, string>,
) {
	const requests: Request[] = [];
	const snapshots: ConversationTimelineState[] = [];
	const reader = createConversationTimeline({
		client: createClient({
			baseUrl: "https://platform.example.test",
			headers,
			fetch: async (input, init) => {
				const request = new Request(input, init);
				requests.push(request);
				return handler(request);
			},
		}),
	});
	reader.subscribe(() => snapshots.push(reader.getSnapshot()));
	readers.push(reader);
	return { reader, requests, snapshots };
}

afterEach(() => {
	for (const reader of readers.splice(0)) reader.abort();
});

describe("Conversation generated-client data consumer", () => {
	it("refreshes the authoritative projection after a receipt and resumes from the new cursor", async () => {
		const first = sse();
		const second = sse();
		let reads = 0;
		let streams = 0;
		const updated = history("conversation-1", [event(1), event(2)]);
		const { reader, requests } = setup((request) =>
			route(request) === "stream"
				? (++streams === 1 ? first : second).response
				: Response.json(++reads === 1 ? history() : updated),
		);
		await reader.open("conversation-1");
		await reader.refresh();
		expect(reader.getSnapshot().history).toEqual(updated);
		await vi.waitFor(() => expect(streams).toBe(2));
		expect(
			new URL(requests[requests.length - 1].url).searchParams.get("cursor"),
		).toBe(event(2).conversationCursor);
		expect(requests.every((request) => request.method === "GET")).toBe(true);
	});
	it("drops a delayed refresh after switching scope and cannot refresh after denial", async () => {
		const pending = deferred<Response>();
		let reads = 0;
		const { reader, requests } = setup((request) => {
			if (route(request) === "stream") return sse().response;
			if (new URL(request.url).pathname.endsWith("conversation-2"))
				return Response.json(history("conversation-2"));
			return ++reads === 1 ? Response.json(history()) : pending.promise;
		});
		await reader.open("conversation-1");
		const refresh = reader.refresh();
		await reader.open("conversation-2");
		pending.resolve(Response.json(history("conversation-1", [event(9)])));
		await refresh;
		expect(reader.getSnapshot().conversationId).toBe("conversation-2");
		expect(reader.getSnapshot().events).toEqual([event(1, "conversation-2")]);
		reader.rejectRead({ kind: "authorization" });
		const count = requests.length;
		await reader.refresh();
		expect(requests).toHaveLength(count);
		expect(reader.getSnapshot().history).toBeNull();
	});

	it("merges original persisted history, mixed live facts and duplicate replay", async () => {
		const first = event(1);
		const second = event(2);
		const operation = PersistedConversationEventV2Schema.parse({
			...event(3),
			schemaVersion: 2,
			type: "execution.operation",
			payload: {
				kind: "model",
				operationRef: "operation-1",
				attemptRef: "attempt-1",
				phase: "unknown",
				failureCode: "response_incomplete",
				model: {
					configVersion: "config-1",
					modelOptionId: "option-1",
					modelId: "model-1",
				},
			},
		});
		const persisted = history("conversation-1", [first, first]);
		const stream = sse();
		const { reader, requests } = setup((request) => {
			if (route(request) === "stream") return stream.response;
			return Response.json(persisted);
		});
		await reader.open("conversation-1");
		stream.send(first, second, second, operation, {
			schemaVersion: 1,
			kind: "control",
			type: "heartbeat",
			occurredAt: timestamp,
		});
		await vi.waitFor(() => expect(reader.getSnapshot().events).toHaveLength(3));
		expect(reader.getSnapshot()).toMatchObject({
			status: "ready",
			history: persisted,
			events: [first, second, operation],
			failure: null,
		});
		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			"/api/v2/conversations/conversation-1",
			"/api/v2/conversations/conversation-1/events",
		]);
		expect(requests.every((request) => request.method === "GET")).toBe(true);
	});

	it("reconnects once from the last consumed cursor without regressing on duplicates", async () => {
		const first = sse();
		const second = sse();
		let streams = 0;
		const { reader, requests } = setup(
			(request) =>
				route(request) === "stream"
					? (++streams === 1 ? first : second).response
					: Response.json(history()),
			{ "Last-Event-ID": "another-readers-event" },
		);
		await reader.open("conversation-1");
		first.send(event(2), event(1));
		await vi.waitFor(() => expect(reader.getSnapshot().events).toHaveLength(2));
		first.disconnect();
		await vi.waitFor(() =>
			expect(reader.getSnapshot().failure).toEqual({ kind: "network" }),
		);
		expect(streams).toBe(1);
		await reader.reconnect();
		second.send(event(2), event(3));
		await vi.waitFor(() => expect(reader.getSnapshot().events).toHaveLength(3));
		const streamRequests = requests.filter(
			(request) => route(request) === "stream",
		);
		expect(
			streamRequests.map((request) =>
				new URL(request.url).searchParams.get("cursor"),
			),
		).toEqual([event(1).conversationCursor, event(2).conversationCursor]);
		expect(
			streamRequests.every((request) => !request.headers.has("Last-Event-ID")),
		).toBe(true);
		expect(
			requests.filter((request) => route(request) === "history"),
		).toHaveLength(1);
		expect(requests.every((request) => request.method === "GET")).toBe(true);
	});

	it("reloads persisted history before resuming and never submits a task", async () => {
		const first = sse();
		const second = sse();
		const persisted = history("conversation-1", [event(1), event(2), event(3)]);
		let histories = 0;
		let streams = 0;
		const { reader, requests } = setup((request) => {
			if (route(request) === "stream")
				return (++streams === 1 ? first : second).response;
			return Response.json(++histories === 1 ? history() : persisted);
		});
		await reader.open("conversation-1");
		first.send(reload(event(2).conversationCursor), event(9));
		await vi.waitFor(() => expect(streams).toBe(2));
		second.send(event(3), event(4));
		await vi.waitFor(() => expect(reader.getSnapshot().events).toHaveLength(4));
		expect(reader.getSnapshot().history).toEqual(persisted);
		expect(reader.getSnapshot().events).toEqual([
			event(1),
			event(2),
			event(3),
			event(4),
		]);
		expect(requests.map((request) => route(request))).toEqual([
			"history",
			"stream",
			"history",
			"stream",
		]);
		expect(new URL(requests[3].url).searchParams.get("cursor")).toBe(
			event(3).conversationCursor,
		);
		expect(requests.every((request) => request.method === "GET")).toBe(true);
	});

	it("retries a failed reload as a history read before any further stream", async () => {
		const first = sse();
		const second = sse();
		let histories = 0;
		let streams = 0;
		const { reader, requests } = setup((request) => {
			if (route(request) === "stream")
				return (++streams === 1 ? first : second).response;
			histories += 1;
			return histories === 2
				? new Response("Unavailable", { status: 503 })
				: Response.json(
						history(
							"conversation-1",
							histories === 1 ? [event(1)] : [event(1), event(2)],
						),
					);
		});
		await reader.open("conversation-1");
		first.send(reload());
		await vi.waitFor(() =>
			expect(reader.getSnapshot().failure).toEqual({
				kind: "service",
				status: 503,
			}),
		);
		expect(streams).toBe(1);
		await reader.reconnect();
		await vi.waitFor(() => expect(streams).toBe(2));
		expect(reader.getSnapshot().events).toEqual([event(1), event(2)]);
		expect(requests.map((request) => route(request))).toEqual([
			"history",
			"stream",
			"history",
			"history",
			"stream",
		]);
	});

	for (const endpoint of ["history", "stream"] as const) {
		it.each([401, 403, 404])(
			`clears data and stops on ${endpoint} HTTP %s`,
			async (status) => {
				const stream = sse();
				let deny = false;
				const { reader, requests } = setup((request) => {
					if (deny && route(request) === endpoint)
						return new Response("Opaque failure", { status });
					if (route(request) === "stream") return stream.response;
					return Response.json(history());
				});
				await reader.open("conversation-1");
				deny = true;
				if (endpoint === "history") stream.send(reload());
				else await reader.reconnect();
				await vi.waitFor(() =>
					expect(reader.getSnapshot().status).toBe("denied"),
				);
				const requestCount = requests.length;
				await reader.reconnect();
				expect(requests).toHaveLength(requestCount);
				expect(reader.getSnapshot()).toMatchObject({
					history: null,
					events: [],
					failure: { kind: "authorization", status },
				});
			},
		);

		it.each(["network", "service"] as const)(
			`distinguishes ${endpoint} %s failure from empty or denied data`,
			async (kind) => {
				const stream = sse();
				const { reader } = setup((request) => {
					if (route(request) === endpoint) {
						if (kind === "network")
							throw new TypeError("Synthetic network failure");
						return new Response("Unavailable", { status: 503 });
					}
					return route(request) === "stream"
						? stream.response
						: Response.json(history());
				});
				await reader.open("conversation-1");
				await vi.waitFor(() => {
					const state = reader.getSnapshot();
					expect(state).toMatchObject({
						status: "unavailable",
						failure: kind === "network" ? { kind } : { kind, status: 503 },
					});
				});
			},
		);
	}

	it("represents empty history as ready and stream EOF as disconnected", async () => {
		const stream = sse();
		const { reader } = setup((request) =>
			route(request) === "stream"
				? stream.response
				: Response.json(history("conversation-1", [])),
		);
		await reader.open("conversation-1");
		expect(reader.getSnapshot()).toMatchObject({
			status: "ready",
			history: { messages: [], events: [] },
			events: [],
			failure: null,
		});
		stream.close();
		await vi.waitFor(() =>
			expect(reader.getSnapshot()).toMatchObject({
				status: "disconnected",
				failure: null,
			}),
		);
	});

	for (const endpoint of ["history", "stream"] as const) {
		it(`isolates a late ${endpoint} response after switching conversation`, async () => {
			const pending = deferred<Response>();
			const oldStream = sse();
			const newStream = sse();
			const { reader, snapshots, requests } = setup((request) => {
				if (request.url.includes("conversation-old")) {
					if (route(request) === endpoint) return pending.promise;
					return route(request) === "stream"
						? oldStream.response
						: Response.json(history("conversation-old"));
				}
				return route(request) === "stream"
					? newStream.response
					: Response.json(history("conversation-new"));
			});
			const opening = reader.open("conversation-old");
			if (endpoint !== "history") await opening;
			await vi.waitFor(() =>
				expect(requests.some((request) => route(request) === endpoint)).toBe(
					true,
				),
			);
			await reader.open("conversation-new");
			const switchedAt = snapshots.length;
			if (endpoint === "stream") oldStream.send(event(2, "conversation-old"));
			pending.resolve(
				endpoint === "stream"
					? oldStream.response
					: Response.json(history("conversation-old")),
			);
			await opening;
			newStream.send(event(2, "conversation-new"));
			await vi.waitFor(() =>
				expect(reader.getSnapshot().events).toHaveLength(2),
			);
			expect(reader.getSnapshot()).toMatchObject({
				conversationId: "conversation-new",
				events: [event(1, "conversation-new"), event(2, "conversation-new")],
			});
			expect(JSON.stringify(snapshots.slice(switchedAt))).not.toContain(
				"conversation-old",
			);
		});
	}

	it("aborts pending history and clears all state without allowing reconnect", async () => {
		const pending = deferred<Response>();
		const { reader, requests } = setup(() => pending.promise);
		const opening = reader.open("conversation-1");
		await vi.waitFor(() => expect(requests).toHaveLength(1));
		reader.abort();
		pending.resolve(Response.json(history()));
		await opening;
		await reader.reconnect();
		expect(reader.getSnapshot()).toMatchObject({
			status: "idle",
			conversationId: null,
			history: null,
			events: [],
		});
		expect(requests).toHaveLength(1);
		expect(requests[0].signal.aborted).toBe(true);
	});

	it.each(["history", "stream"] as const)(
		"rejects %s data bound to another conversation",
		async (endpoint) => {
			const stream = sse();
			const { reader, snapshots } = setup((request) => {
				if (route(request) === "stream") return stream.response;
				if (route(request) === endpoint)
					return Response.json(history("foreign-conversation"));
				return Response.json(history());
			});
			await reader.open("conversation-1");
			if (endpoint === "stream") stream.send(event(2, "foreign-conversation"));
			await vi.waitFor(() =>
				expect(reader.getSnapshot()).toMatchObject({
					status: "unavailable",
					history: null,
					events: [],
					failure: { kind: "invalid" },
				}),
			);
			expect(JSON.stringify(snapshots)).not.toContain("foreign-conversation");
		},
	);

	it("rejects malformed SSE without publishing its raw payload", async () => {
		const stream = sse();
		const { reader, snapshots } = setup((request) =>
			route(request) === "stream" ? stream.response : Response.json(history()),
		);
		await reader.open("conversation-1");
		stream.raw('data: {"private":"untrusted-payload"}\n\n');
		await vi.waitFor(() =>
			expect(reader.getSnapshot().failure).toEqual({ kind: "invalid" }),
		);
		expect(reader.getSnapshot().events).toEqual([]);
		expect(JSON.stringify(snapshots)).not.toContain("untrusted-payload");
	});
});
