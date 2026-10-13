import {
	ConversationDetailProjectionV2Schema,
	PersistedConversationEventV2Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../../pilot/generated-v2/client/index.js";
import type { PersistedConversationEventV2 } from "../../pilot/generated-v2/types.gen.js";
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
	type ConversationTimelineEnvironment,
	type ConversationTimelineState,
	createConversationTimeline,
} from "./conversation-timeline.js";

const readers: ReturnType<typeof createConversationTimeline>[] = [];

function setup(
	handler: (request: Request) => Response | Promise<Response>,
	headers?: Record<string, string>,
	reconnectDelaysMs: readonly number[] = [],
	healthyStreamMs?: number,
	slow: {
		slowReconnectMs?: number;
		environment?: ConversationTimelineEnvironment;
	} = {},
) {
	const requests: Request[] = [];
	const snapshots: ConversationTimelineState[] = [];
	const reader = createConversationTimeline({
		reconnectDelaysMs,
		...(healthyStreamMs === undefined ? {} : { healthyStreamMs }),
		...slow,
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

function windowedHistory(
	conversationId: string,
	events: PersistedConversationEventV2[],
	eventWindow: { hasEarlier: boolean; beforeCursor: string | null },
) {
	return ConversationDetailProjectionV2Schema.parse({
		...history(conversationId, events),
		eventWindow,
	});
}

afterEach(() => {
	for (const reader of readers.splice(0)) reader.abort();
});

describe("Conversation generated-client data consumer", () => {
	it("loads earlier event pages in order and advances the opaque cursor", async () => {
		const stream = sse();
		const recent = windowedHistory("conversation-1", [event(3), event(4)], {
			hasEarlier: true,
			beforeCursor: "before-cursor-2",
		});
		const earlier = windowedHistory("conversation-1", [event(1), event(2)], {
			hasEarlier: false,
			beforeCursor: null,
		});
		const { reader, requests } = setup((request) => {
			if (route(request) === "stream") return stream.response;
			return Response.json(
				new URL(request.url).searchParams.has("beforeCursor")
					? earlier
					: recent,
			);
		});
		await reader.open("conversation-1");
		await vi.waitFor(() => expect(reader.getSnapshot().hasEarlier).toBe(true));
		await reader.loadEarlier();
		expect(reader.getSnapshot()).toMatchObject({
			events: [event(1), event(2), event(3), event(4)],
			hasEarlier: false,
			beforeCursor: null,
			earlierLoading: false,
		});
		const historyRequests = requests.filter(
			(request) => route(request) === "history",
		);
		expect(
			new URL(historyRequests[1].url).searchParams.get("beforeCursor"),
		).toBe("before-cursor-2");
	});

	it("keeps live SSE events while an earlier page is pending", async () => {
		const stream = sse();
		const pending = deferred<Response>();
		const recent = windowedHistory("conversation-1", [event(3), event(4)], {
			hasEarlier: true,
			beforeCursor: "before-cursor-2",
		});
		const earlier = windowedHistory("conversation-1", [event(1), event(2)], {
			hasEarlier: false,
			beforeCursor: null,
		});
		const { reader } = setup((request) => {
			if (route(request) === "stream") return stream.response;
			return new URL(request.url).searchParams.has("beforeCursor")
				? pending.promise
				: Response.json(recent);
		});
		await reader.open("conversation-1");
		const loading = reader.loadEarlier();
		await vi.waitFor(() =>
			expect(reader.getSnapshot().earlierLoading).toBe(true),
		);
		stream.send(event(5));
		await vi.waitFor(() =>
			expect(reader.getSnapshot().events).toEqual([
				event(3),
				event(4),
				event(5),
			]),
		);
		pending.resolve(Response.json(earlier));
		await loading;
		expect(reader.getSnapshot().events).toEqual([
			event(1),
			event(2),
			event(3),
			event(4),
			event(5),
		]);
	});

	it("drops an earlier page that resolves after switching conversations", async () => {
		const pending = deferred<Response>();
		const { reader } = setup((request) => {
			if (route(request) === "stream") return sse().response;
			if (new URL(request.url).searchParams.has("beforeCursor"))
				return pending.promise;
			return Response.json(
				windowedHistory(
					request.url.includes("conversation-2")
						? "conversation-2"
						: "conversation-1",
					[
						event(
							3,
							request.url.includes("conversation-2")
								? "conversation-2"
								: "conversation-1",
						),
					],
					{
						hasEarlier: true,
						beforeCursor: "before-cursor-2",
					},
				),
			);
		});
		await reader.open("conversation-1");
		const loading = reader.loadEarlier();
		await vi.waitFor(() =>
			expect(reader.getSnapshot().earlierLoading).toBe(true),
		);
		await reader.open("conversation-2");
		pending.resolve(
			Response.json(
				windowedHistory("conversation-1", [event(1), event(2)], {
					hasEarlier: false,
					beforeCursor: null,
				}),
			),
		);
		await loading;
		expect(reader.getSnapshot().conversationId).toBe("conversation-2");
		expect(reader.getSnapshot().events).toEqual([event(3, "conversation-2")]);
	});

	it("clears earlier loading when a refresh cancels the page request", async () => {
		const pending = deferred<Response>();
		let historyReads = 0;
		const recent = windowedHistory("conversation-1", [event(3)], {
			hasEarlier: true,
			beforeCursor: "before-cursor-2",
		});
		const { reader } = setup((request) => {
			if (route(request) === "stream") return sse().response;
			if (new URL(request.url).searchParams.has("beforeCursor"))
				return pending.promise;
			return ++historyReads === 1
				? Response.json(recent)
				: Response.json(recent, { status: 503 });
		});
		await reader.open("conversation-1");
		const loading = reader.loadEarlier();
		await vi.waitFor(() =>
			expect(reader.getSnapshot().earlierLoading).toBe(true),
		);
		await reader.refresh();
		pending.resolve(Response.json(recent));
		await loading;
		expect(reader.getSnapshot()).toMatchObject({
			status: "unavailable",
			earlierLoading: false,
		});
	});

	it("rejects a schema-valid history body from a non-200 response", async () => {
		const { reader } = setup((request) =>
			route(request) === "history"
				? Response.json(history(), { status: 503 })
				: sse().response,
		);
		await reader.open("conversation-1");
		await vi.waitFor(() =>
			expect(reader.getSnapshot()).toMatchObject({
				status: "unavailable",
				failure: { kind: "service", status: 503 },
			}),
		);
		expect(reader.getSnapshot().history).toBeNull();
		expect(reader.getSnapshot().events).toEqual([]);
	});

	it("purges history for a schema-valid authorization error on a dependency response", async () => {
		const error = PilotProtocolErrorV1Schema.parse({
			schemaVersion: 1,
			code: "AUTHORIZATION_REVOKED",
			message: "Synthetic authorization failure",
			retryable: false,
			traceId: "trace-timeline",
		});
		const { reader } = setup((request) =>
			route(request) === "history"
				? Response.json(error, { status: 503 })
				: sse().response,
		);
		await reader.open("conversation-1");
		await vi.waitFor(() => expect(reader.getSnapshot().status).toBe("denied"));
		expect(reader.getSnapshot().failure).toEqual({
			kind: "authorization",
			status: 503,
		});
		expect(reader.getSnapshot().history).toBeNull();
	});

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
		it.each([401, 403])(
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

		it(`purges an ordinary ${endpoint} HTTP 404 and reconnects with fresh history`, async () => {
			let stream = sse();
			let missing = false;
			let restored = false;
			const updated = history("conversation-1", [event(2)]);
			const { reader, requests } = setup((request) => {
				if (missing && route(request) === endpoint)
					return new Response("Route missing", { status: 404 });
				if (route(request) === "stream") return stream.response;
				return Response.json(restored ? updated : history());
			});
			await reader.open("conversation-1");
			missing = true;
			if (endpoint === "history") stream.send(reload());
			else await reader.reconnect();
			await vi.waitFor(() =>
				expect(reader.getSnapshot().status).toBe("unavailable"),
			);
			expect(reader.getSnapshot()).toMatchObject({
				history: null,
				events: [],
				failure: { kind: "http", status: 404 },
			});
			const requestCount = requests.length;
			missing = false;
			restored = true;
			stream = sse();
			await reader.reconnect();
			await vi.waitFor(() => expect(requests).toHaveLength(requestCount + 2));
			expect(requests.slice(requestCount).map(route)).toEqual([
				"history",
				"stream",
			]);
			expect(reader.getSnapshot()).toMatchObject({
				status: "ready",
				history: updated,
				events: [event(2)],
				failure: null,
			});
			expect(
				new URL(requests[requests.length - 1].url).searchParams.get("cursor"),
			).toBe(event(2).conversationCursor);
			expect(requests.every((request) => request.method === "GET")).toBe(true);
		});

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

	it("represents empty history as ready and stream EOF as disconnected once no automatic reconnect remains", async () => {
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

	it("reconnects automatically from the last consumed cursor after a transient end and never submits a task (#1606)", async () => {
		const streams = [sse(), sse(), sse()];
		let opened = 0;
		const { reader, requests, snapshots } = setup(
			(request) =>
				route(request) === "stream"
					? (streams[opened++] ?? sse()).response
					: Response.json(history()),
			undefined,
			[1, 1],
		);
		await reader.open("conversation-1");
		streams[0]?.send(event(2));
		await vi.waitFor(() => expect(reader.getSnapshot().events).toHaveLength(2));
		// The server closed the stream without revoking access.
		streams[0]?.close();
		await vi.waitFor(() => expect(opened).toBe(2));
		await vi.waitFor(() => expect(reader.getSnapshot().status).toBe("ready"));
		// A network drop reconnects the same way.
		streams[1]?.disconnect();
		await vi.waitFor(() => expect(opened).toBe(3));
		streams[2]?.send(event(3));
		await vi.waitFor(() => expect(reader.getSnapshot().events).toHaveLength(3));
		expect(snapshots.map((snapshot) => snapshot.status)).toContain(
			"reconnecting",
		);
		expect(reader.getSnapshot()).toMatchObject({
			status: "ready",
			failure: null,
		});
		const streamRequests = requests.filter(
			(request) => route(request) === "stream",
		);
		expect(
			streamRequests.map((request) =>
				new URL(request.url).searchParams.get("cursor"),
			),
		).toEqual([
			event(1).conversationCursor,
			event(2).conversationCursor,
			event(2).conversationCursor,
		]);
		expect(
			requests.filter((request) => route(request) === "history"),
		).toHaveLength(1);
		expect(requests.every((request) => request.method === "GET")).toBe(true);
	});

	it("falls back to manual reconnect once the automatic attempts are spent (#1606)", async () => {
		let opened = 0;
		const { reader } = setup(
			(request) => {
				if (route(request) !== "stream") return Response.json(history());
				opened++;
				// Every stream ends at once, as during a longer outage.
				const stream = sse();
				stream.close();
				return stream.response;
			},
			undefined,
			[1, 1],
		);
		await reader.open("conversation-1");
		await vi.waitFor(() =>
			expect(reader.getSnapshot()).toMatchObject({
				status: "disconnected",
				failure: null,
			}),
		);
		expect(opened).toBe(3);
		// A manual reconnect re-arms the bounded automatic attempts.
		await reader.reconnect();
		await vi.waitFor(() => {
			expect(opened).toBe(6);
			expect(reader.getSnapshot().status).toBe("disconnected");
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(opened).toBe(6);
	});

	it("spends the automatic attempts on reconnects that are slow to fail (#1606)", async () => {
		let opened = 0;
		const { reader } = setup(
			async (request) => {
				if (route(request) !== "stream") return Response.json(history());
				opened++;
				// Fails only after longer than the healthy period, never accepted.
				await new Promise((resolve) => setTimeout(resolve, 40));
				throw new TypeError("Test slow network failure");
			},
			undefined,
			[1, 1],
			20,
		);
		await reader.open("conversation-1");
		await vi.waitFor(() =>
			expect(reader.getSnapshot()).toMatchObject({
				status: "unavailable",
				failure: { kind: "network" },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(opened).toBe(3);
	});

	it("never reconnects automatically after revocation or a denied read (#1606)", async () => {
		const revoked = sse();
		let opened = 0;
		const { reader } = setup(
			(request) => {
				if (route(request) !== "stream") return Response.json(history());
				opened++;
				return revoked.response;
			},
			undefined,
			[1, 1],
			undefined,
			{ slowReconnectMs: 1 },
		);
		await reader.open("conversation-1");
		revoked.send({
			schemaVersion: 1,
			kind: "control",
			type: "authorization.revoked",
			error: PilotProtocolErrorV1Schema.parse({
				schemaVersion: 1,
				code: "AUTHORIZATION_REVOKED",
				message: "Synthetic revocation",
				retryable: false,
				traceId: "trace-timeline",
			}),
		});
		await vi.waitFor(() => expect(reader.getSnapshot().status).toBe("denied"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(opened).toBe(1);

		let denied = 0;
		const missing = setup(
			(request) => {
				if (route(request) !== "stream") return Response.json(history());
				denied++;
				return Response.json(
					PilotProtocolErrorV1Schema.parse({
						schemaVersion: 1,
						code: "RESOURCE_UNAVAILABLE",
						message: "Synthetic missing conversation",
						retryable: false,
						traceId: "trace-timeline",
					}),
					{ status: 404 },
				);
			},
			undefined,
			[1, 1],
			undefined,
			{ slowReconnectMs: 1 },
		);
		await missing.reader.open("conversation-1");
		await vi.waitFor(() =>
			expect(missing.reader.getSnapshot().status).toBe("unavailable"),
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(denied).toBe(1);
	});

	it("keeps retrying slowly after the automatic attempts and resumes from the last cursor (#2151)", async () => {
		let opened = 0;
		const recovered = sse();
		const { reader, requests, snapshots } = setup(
			(request) => {
				if (route(request) !== "stream") return Response.json(history());
				opened++;
				// 前 6 次模拟 API 不可用（超过快速重连次数），之后恢复。
				if (opened <= 6) throw new TypeError("Synthetic connection refused");
				return recovered.response;
			},
			undefined,
			[1, 1],
			undefined,
			{ slowReconnectMs: 5 },
		);
		await reader.open("conversation-1");
		await vi.waitFor(() => expect(opened).toBe(7));
		recovered.send(event(2));
		await vi.waitFor(() =>
			expect(reader.getSnapshot()).toMatchObject({
				status: "ready",
				failure: null,
				events: [event(1), event(2)],
			}),
		);
		expect(snapshots.map((snapshot) => snapshot.status)).toContain(
			"unavailable",
		);
		const streamRequests = requests.filter(
			(request) => route(request) === "stream",
		);
		expect(
			new Set(
				streamRequests.map((request) =>
					new URL(request.url).searchParams.get("cursor"),
				),
			),
		).toEqual(new Set([event(1).conversationCursor]));
		expect(
			requests.filter((request) => route(request) === "history"),
		).toHaveLength(1);
		expect(requests.every((request) => request.method === "GET")).toBe(true);
	});

	it("pauses slow retries while hidden and retries at once when woken (#2151)", async () => {
		let visible = false;
		let wake: (() => void) | undefined;
		let unsubscribed = 0;
		let available = false;
		let opened = 0;
		const recovered = sse();
		const { reader } = setup(
			(request) => {
				if (route(request) !== "stream") return Response.json(history());
				opened++;
				if (!available) throw new TypeError("Synthetic connection refused");
				return recovered.response;
			},
			undefined,
			[1],
			undefined,
			{
				slowReconnectMs: 5,
				environment: {
					visible: () => visible,
					subscribe(listener) {
						wake = listener;
						return () => {
							unsubscribed++;
						};
					},
				},
			},
		);
		await reader.open("conversation-1");
		await vi.waitFor(() =>
			expect(reader.getSnapshot()).toMatchObject({
				status: "unavailable",
				failure: { kind: "network" },
			}),
		);
		const hiddenOpens = opened;
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(opened).toBe(hiddenOpens);
		available = true;
		visible = true;
		wake?.();
		await vi.waitFor(() => expect(reader.getSnapshot().status).toBe("ready"));
		expect(opened).toBe(hiddenOpens + 1);
		reader.abort();
		expect(unsubscribed).toBe(1);
	});

	it("retries a temporarily unavailable history read slowly instead of stopping (#2151)", async () => {
		let historyReads = 0;
		const stream = sse();
		const { reader } = setup(
			(request) => {
				if (route(request) === "stream") return stream.response;
				historyReads++;
				return historyReads <= 2
					? new Response("Unavailable", { status: 503 })
					: Response.json(history());
			},
			undefined,
			[],
			undefined,
			{ slowReconnectMs: 5 },
		);
		await reader.open("conversation-1");
		await vi.waitFor(() =>
			expect(reader.getSnapshot()).toMatchObject({
				status: "ready",
				failure: null,
				events: [event(1)],
			}),
		);
		expect(historyReads).toBe(3);
	});

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
