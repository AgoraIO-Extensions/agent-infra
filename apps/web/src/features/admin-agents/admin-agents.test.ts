import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import { describe, expect, it } from "vitest";
import { createClient } from "../../pilot/generated-v2/client/index.js";
import { loadAdminAgents } from "./admin-agents.js";

const firstAgent = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);
const secondAgent = AgentProjectionV2Schema.parse({
	...firstAgent,
	agentId: "other-owner-agent",
	configuration: {
		...firstAgent.configuration,
		owners: [
			{
				userId: "other-owner",
				displayName: "Other Owner",
				roles: ["employee"],
			},
		],
	},
	name: "Later-page match",
});

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
	return { client, requests };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("Administrator Agent inventory generated-client consumer", () => {
	it("collects all opaque cursor pages and preserves the public projections", async () => {
		const cursor = "opaque/+cursor?owner=untrusted";
		const { client, requests } = setup((request) =>
			Response.json(
				new URL(request.url).searchParams.get("cursor") === cursor
					? { items: [secondAgent], nextCursor: null }
					: { items: [firstAgent], nextCursor: cursor },
			),
		);
		const controller = new AbortController();
		await expect(loadAdminAgents(client, controller.signal)).resolves.toEqual({
			kind: "ready",
			agents: [firstAgent, secondAgent],
		});
		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			"/api/v2/admin/agents",
			"/api/v2/admin/agents",
		]);
		expect(new URL(requests[1].url).searchParams.get("cursor")).toBe(cursor);
		expect([...new URL(requests[0].url).searchParams]).toEqual([]);
		controller.abort();
		expect(requests.every((request) => request.signal.aborted)).toBe(true);
	});

	it("keeps a valid empty inventory distinct from a failed response", async () => {
		const { client } = setup(() =>
			Response.json({ items: [], nextCursor: null }),
		);
		await expect(loadAdminAgents(client)).resolves.toEqual({
			kind: "ready",
			agents: [],
		});
	});

	it.each([
		[401, { kind: "denied", reason: "authentication-required" }],
		[403, { kind: "denied", reason: "denied" }],
		[404, { kind: "error", retryable: false, reason: "not-found" }],
		[429, { kind: "error", retryable: true }],
		[503, { kind: "error", retryable: true }],
	] as const)(
		"discards page one after HTTP %s without fallback or private error details",
		async (status, expected) => {
			const { client, requests } = setup((request) =>
				new URL(request.url).searchParams.has("cursor")
					? Response.json(
							{ message: "private-upstream-detail", retryable: status === 403 },
							{ status },
						)
					: Response.json({ items: [firstAgent], nextCursor: "next-page" }),
			);
			await expect(loadAdminAgents(client)).resolves.toEqual(expected);
			expect(requests).toHaveLength(2);
			expect(
				requests.every(
					(request) => new URL(request.url).pathname === "/api/v2/admin/agents",
				),
			).toBe(true);
		},
	);

	it.each([
		null,
		{ items: [], nextCursor: 42 },
		{ items: [], nextCursor: null, secret: "rejected-field" },
		{
			items: [{ ...secondAgent, managementStatus: "pending" }],
			nextCursor: null,
		},
	])("discards accumulated rows for an invalid later page %j", async (body) => {
		const { client, requests } = setup((request) =>
			Response.json(
				new URL(request.url).searchParams.has("cursor")
					? body
					: { items: [firstAgent], nextCursor: "next-page" },
			),
		);
		await expect(loadAdminAgents(client)).resolves.toEqual({
			kind: "error",
			retryable: false,
			reason: "invalid-response",
		});
		expect(requests).toHaveLength(2);
	});

	it("rejects a repeated cursor before issuing a third request", async () => {
		const { client, requests } = setup(() =>
			Response.json({ items: [firstAgent], nextCursor: "same-cursor" }),
		);
		await expect(loadAdminAgents(client)).resolves.toEqual({
			kind: "error",
			retryable: false,
		});
		expect(requests).toHaveLength(2);
	});

	it.each([false, true])(
		"bounds unique cursor chains at 100 pages (terminating=%s)",
		async (terminating) => {
			let pages = 0;
			const { client, requests } = setup(() => {
				pages += 1;
				return Response.json({
					items: pages === 100 ? [secondAgent] : [],
					nextCursor: terminating && pages === 100 ? null : `opaque-${pages}`,
				});
			});
			await expect(loadAdminAgents(client)).resolves.toEqual(
				terminating
					? { kind: "ready", agents: [secondAgent] }
					: { kind: "error", retryable: false },
			);
			expect(requests).toHaveLength(100);
		},
	);

	it("returns an opaque retryable transport failure", async () => {
		const { client } = setup(() => {
			throw new Error("synthetic-private-network-state");
		});
		await expect(loadAdminAgents(client)).resolves.toEqual({
			kind: "error",
			retryable: true,
		});
	});

	it("does not issue a request when the signal is already aborted", async () => {
		const { client, requests } = setup(() =>
			Response.json({ items: [], nextCursor: null }),
		);
		const controller = new AbortController();
		controller.abort();
		await expect(
			loadAdminAgents(client, controller.signal),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(requests).toEqual([]);
	});

	it("rejects late success from a transport that ignores abort, without reading the next page", async () => {
		const pending = deferred<Response>();
		const started = deferred<void>();
		const { client, requests } = setup(() => {
			started.resolve();
			return pending.promise;
		});
		const controller = new AbortController();
		const loading = loadAdminAgents(client, controller.signal);
		const rejected = expect(loading).rejects.toMatchObject({
			name: "AbortError",
		});
		await started.promise;
		controller.abort();
		pending.resolve(
			Response.json({ items: [firstAgent], nextCursor: "must-not-load" }),
		);
		await rejected;
		expect(requests).toHaveLength(1);
		expect(requests[0].signal.aborted).toBe(true);
	});
});
