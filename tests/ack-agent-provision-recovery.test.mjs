import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { provisionAgents } from "../deploy/ack/provision-agents.ts";

const token = "SYNTHETIC_PRIVATE_CREDENTIAL";
const body = {
	schemaVersion: 3,
	name: "private-name",
	defaultRelayKey: "SYNTHETIC_PRIVATE_KEY",
};
const request = {
	name: "first",
	bodyFile: "/private/body.json",
	credentialFile: "/private/token",
	idempotencyKey: "original-create-key",
};
const input = {
	schemaVersion: 1,
	origin: "https://platform.example.test",
	waitSeconds: 10,
	requests: [request],
};
const created = {
	schemaVersion: 1,
	agentId: "original-agent",
	status: "creating",
	revision: 1,
};
const state = {
	schemaVersion: 1,
	agentId: created.agentId,
	status: "available",
	serviceAvailability: "ready",
};
function fixture(extra = {}) {
	let now = 0;
	const bindings = [];
	return {
		options: {
			materials: { first: { token, body } },
			onBinding: async (value) => bindings.push(value),
			clock: {
				now: () => now,
				wait: async (milliseconds) => {
					now += milliseconds;
				},
			},
			...extra,
		},
		advance: (milliseconds) => {
			now += milliseconds;
		},
		bindings,
	};
}
function assertPrivate(result) {
	for (const value of [
		token,
		body.defaultRelayKey,
		body.name,
		created.agentId,
		input.origin,
		"SYNTHETIC_ERROR_SECRET",
	])
		assert.equal(JSON.stringify(result).includes(value), false);
}

test("committed HTTP creation with a lost response replays the same request until its original Agent is recovered", async (t) => {
	const received = [];
	let commits = 0;
	const server = createServer(async (req, res) => {
		if (req.method === "GET") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(state));
			return;
		}
		let bytes = "";
		for await (const chunk of req) bytes += chunk;
		received.push({
			key: req.headers["idempotency-key"],
			authorization: req.headers.authorization,
			bytes,
		});
		if (received.length === 1) {
			commits++;
			req.socket.destroy();
			return;
		}
		res.setHeader("content-type", "application/json");
		if (received.length === 2) {
			res.statusCode = 503;
			res.end(JSON.stringify({ error: { code: "DEPENDENCY_UNAVAILABLE" } }));
			return;
		}
		res.end(JSON.stringify({ ...created, replayed: true }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const realFetch = globalThis.fetch;
	t.mock.method(globalThis, "fetch", (url, options) => {
		assert(String(url).startsWith(`${input.origin}/api/v2/agents`));
		return realFetch(
			String(url).replace(
				input.origin,
				`http://127.0.0.1:${server.address().port}`,
			),
			options,
		);
	});
	const f = fixture();
	const result = await provisionAgents(input, f.options);
	assert.equal(result.pass, true);
	assert.equal(commits, 1);
	assert.equal(received.length, 3);
	assert(
		received.every(
			(value) =>
				value.key === request.idempotencyKey &&
				value.authorization === `Bearer ${token}` &&
				value.bytes === JSON.stringify(body),
		),
	);
	assert.deepEqual(f.bindings, [
		{ name: "first", agentId: created.agentId, ready: false },
		{ name: "first", agentId: created.agentId, ready: true },
	]);
	assert.equal(result.results[0].creation.attempts, 3);
	assert.equal(result.results[0].creation.dependencyUnavailableResponses, 1);
	assert.deepEqual(result.results[0].creation.transportFailures, [
		"UND_ERR_SOCKET",
	]);
	assertPrivate(result);
});

test("a legitimate 72-second creation remains inside the client budget", async (t) => {
	const f = fixture();
	const deadlines = new WeakMap();
	t.mock.method(AbortSignal, "timeout", (milliseconds) => {
		const signal = new AbortController().signal;
		deadlines.set(signal, milliseconds);
		return signal;
	});
	t.mock.method(globalThis, "fetch", async (_url, options) => {
		if (options.method === "POST") {
			f.advance(72_000);
			if (deadlines.get(options.signal) < 72_000)
				throw new DOMException("SYNTHETIC_ERROR_SECRET", "TimeoutError");
			return Response.json(created, { status: 201 });
		}
		return Response.json(state);
	});
	const result = await provisionAgents(input, f.options);
	assert.equal(result.pass, true);
	assert.equal(result.results[0].creation.attempts, 1);
});

test("a connection lost while consuming the committed response body is replayed", async (t) => {
	const f = fixture();
	let posts = 0;
	t.mock.method(globalThis, "fetch", async (_url, options) => {
		if (options.method !== "POST") return Response.json(state);
		if (++posts === 1)
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.error(
							new TypeError("SYNTHETIC_ERROR_SECRET", {
								cause: { code: "UND_ERR_SOCKET" },
							}),
						);
					},
				}),
				{ status: 201 },
			);
		return Response.json({ ...created, replayed: true });
	});
	const result = await provisionAgents(input, f.options);
	assert.equal(result.pass, true);
	assert.equal(posts, 2);
	assert.deepEqual(result.results[0].creation.transportFailures, [
		"UND_ERR_SOCKET",
	]);
	assertPrivate(result);
});

test("exhausted creation budget never sends a later Agent request", async (t) => {
	const f = fixture();
	const calls = [];
	t.mock.method(globalThis, "fetch", async (_url, options) => {
		calls.push(new Headers(options.headers).get("idempotency-key"));
		f.advance(100_000);
		return Response.json(
			{ error: { code: "DEPENDENCY_UNAVAILABLE" } },
			{ status: 503 },
		);
	});
	const result = await provisionAgents(
		{
			...input,
			requests: [
				request,
				{ ...request, name: "second", idempotencyKey: "different-key" },
			],
		},
		{
			...f.options,
			materials: { first: { token, body }, second: { token, body } },
		},
	);
	assert.equal(result.pass, false);
	assert(calls.length > 1 && calls.length <= 3);
	assert(calls.every((key) => key === request.idempotencyKey));
	assert.equal(result.results[0].creation.budgetExhausted, true);
	assert.equal(result.skippedRequestCount, 1);
	assert.equal(f.bindings.length, 0);
	assertPrivate(result);
});

for (const scenario of [
	400,
	401,
	403,
	409,
	"tls",
	"unknown",
	"invalid-json",
	"wrong-contract",
	"wrong-503-code",
]) {
	test(`creation rejects ${scenario} without retrying or leaking private errors`, async (t) => {
		const f = fixture();
		let calls = 0;
		t.mock.method(globalThis, "fetch", async () => {
			calls++;
			if (scenario === "tls" || scenario === "unknown")
				throw new TypeError("SYNTHETIC_ERROR_SECRET", {
					cause: Object.assign(new Error("SYNTHETIC_ERROR_SECRET"), {
						code:
							scenario === "tls"
								? "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
								: "SYNTHETIC_ERROR_SECRET",
					}),
				});
			if (scenario === "invalid-json")
				return new Response("SYNTHETIC_ERROR_SECRET", { status: 201 });
			if (scenario === "wrong-contract")
				return Response.json(
					{ ...created, schemaVersion: 99 },
					{ status: 201 },
				);
			return Response.json(
				{ error: { code: "FORBIDDEN" } },
				{ status: scenario === "wrong-503-code" ? 503 : scenario },
			);
		});
		const result = await provisionAgents(input, f.options);
		assert.equal(result.pass, false);
		assert.equal(calls, 1);
		assert.equal(f.bindings.length, 0);
		assertPrivate(result);
	});
}

test("an existing binding recovers a transient state read without recreating the Agent", async (t) => {
	const f = fixture({ bindings: { first: created.agentId } });
	let calls = 0;
	t.mock.method(globalThis, "fetch", async (url, options) => {
		assert.notEqual(options.method, "POST");
		assert(String(url).endsWith(`/${created.agentId}/state`));
		if (++calls === 1)
			throw new TypeError("SYNTHETIC_ERROR_SECRET", {
				cause: { code: "ECONNRESET" },
			});
		return Response.json(state);
	});
	const result = await provisionAgents(input, f.options);
	assert.equal(result.pass, true);
	assert.equal(calls, 2);
	assertPrivate(result);
});

test("zero readiness wait remains a single observation", async (t) => {
	const f = fixture({ bindings: { first: created.agentId } });
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
		throw new TypeError("SYNTHETIC_ERROR_SECRET", {
			cause: { code: "ECONNRESET" },
		});
	});
	const result = await provisionAgents({ ...input, waitSeconds: 0 }, f.options);
	assert.equal(result.pass, false);
	assert.equal(calls, 1);
});

for (const status of [401, 403, 503]) {
	test(`a failed ${status} response body cannot authorize a transport retry`, async (t) => {
		const f = fixture();
		let calls = 0;
		t.mock.method(globalThis, "fetch", async () => {
			calls++;
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.error(
							new TypeError("SYNTHETIC_ERROR_SECRET", {
								cause: { code: "UND_ERR_SOCKET" },
							}),
						);
					},
				}),
				{ status },
			);
		});
		const result = await provisionAgents(input, f.options);
		assert.equal(result.pass, false);
		assert.equal(calls, 1);
		assertPrivate(result);
	});
}

for (const scenario of ["wrong-agent", "forbidden", "expired-budget"]) {
	test(`state read cannot convert ${scenario} to success`, async (t) => {
		const f = fixture({ bindings: { first: created.agentId } });
		let calls = 0;
		t.mock.method(globalThis, "fetch", async (_url, options) => {
			assert.notEqual(options.method, "POST");
			calls++;
			if (scenario === "expired-budget") {
				f.advance(20_000);
				throw new TypeError("SYNTHETIC_ERROR_SECRET", {
					cause: { code: "ECONNRESET" },
				});
			}
			return scenario === "forbidden"
				? Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
				: Response.json({ ...state, agentId: "foreign-agent" });
		});
		const result = await provisionAgents(input, f.options);
		assert.equal(result.pass, false);
		assert.equal(calls, 1);
		assertPrivate(result);
	});
}
