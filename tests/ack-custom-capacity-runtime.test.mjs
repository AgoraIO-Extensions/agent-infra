import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { buildSync } from "esbuild";
import * as schemas from "../packages/contracts/src/runtime/index.ts";

function bundle(entry) {
	const result = buildSync({
		entryPoints: [entry],
		bundle: true,
		platform: "node",
		target: "node24",
		format: "cjs",
		write: false,
		logLevel: "error",
		metafile: true,
		alias: {
			"@agent-infra/contracts/runtime": resolve(
				"packages/contracts/src/runtime/index.ts",
			),
			"@agent-infra/contracts": resolve("packages/contracts/src/index.ts"),
			"@agent-infra/platform-core": resolve(
				"packages/platform-core/src/index.ts",
			),
		},
	});
	assert.ok(
		!Object.keys(result.metafile.inputs).some((path) =>
			/^packages\/[^/]+\/dist\//.test(path),
		),
		"Runtime probe must bundle tracked source, not ignored build outputs",
	);
	const module = { exports: {} };
	new Function("require", "module", "exports", result.outputFiles[0].text)(
		createRequire(import.meta.url),
		module,
		module.exports,
	);
	return module.exports;
}
const { measureCustomRuntime } = bundle(
	"deploy/ack/custom-capacity-runtime.mts",
);
const {
	createRuntimeExecutionGrantVerifierV2,
	validateRuntimeExecutionGrantV2,
} = bundle("packages/agent-runtime/src/grant-v2.ts");
const keys = generateKeyPairSync("ed25519");
const verify = createRuntimeExecutionGrantVerifierV2(
	new Map([["capacity-key", keys.publicKey]]),
);
const epoch = 1_800_000_000_000;
const iso = (offset) => new Date(epoch + offset).toISOString();
const routes = {
	"original-binding": [schemas.RuntimeStatusRequestV3Schema, "session.status"],
	turns: [schemas.RuntimeSubmitTurnRequestV3Schema, "turn.submit"],
	"events/stream": [
		schemas.RuntimeEventPersistRequestV3Schema,
		"events.persist",
	],
	"events/ack": [schemas.RuntimeEventAckRequestV3Schema, "events.ack"],
	"authorizations/renew": [
		schemas.RuntimeAuthorizationRenewRequestV3Schema,
		"execution.renew",
	],
};
function events(executionId) {
	const event = (n, type, payload, offset = n) => ({
		schemaVersion: type === "operation" ? 2 : 1,
		adapterEventKey: `key-${n}`,
		executionId,
		cursor: `cursor-${n}`,
		occurredAt: iso(offset),
		type,
		payload,
	});
	const model = {
		configVersion: "custom-v1",
		modelOptionId: "custom:model",
		modelId: "actual-model",
		reasoningLevel: "medium",
	};
	const operation = {
		kind: "model",
		operationRef: "model-operation",
		attemptRef: "model-attempt",
		model,
	};
	return [
		event(1, "operation", { ...operation, phase: "intent" }),
		event(2, "operation", {
			...operation,
			phase: "started",
			startedAt: iso(2),
		}),
		event(3, "text", { delta: "READY" }),
		event(4, "operation", {
			...operation,
			phase: "completed",
			startedAt: iso(2),
			finishedAt: iso(4),
			durationMs: 2,
		}),
		event(5, "completed", { status: "completed" }),
	];
}
const frame = (event) =>
	`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
function json(response, value, status = 200) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
}
function denial(response, code, status) {
	json(
		response,
		{
			schemaVersion: 1,
			code,
			message: "Runtime request rejected",
			retryable: false,
			traceId: "test-trace",
		},
		status,
	);
}
async function setup(t, behavior = {}) {
	const state = {
		now: epoch,
		requests: [],
		checkpoints: [],
		acks: [],
		denied: [],
		submits: [],
		reads: [],
		renewals: [],
		errors: [],
	};
	const server = createServer(async (req, res) => {
		try {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const body = JSON.parse(Buffer.concat(chunks).toString());
			const path = req.url.replace("/internal/runtime/v3/", "");
			state.requests.push({ path, body });
			assert.equal(req.method, "POST");
			assert.ok(routes[path], `unexpected path ${path}`);
			if (req.headers.authorization !== "Bearer synthetic-private-service") {
				state.denied.push("service");
				if (behavior.acceptWrongToken)
					return json(res, {
						schemaVersion: 3,
						executionId: body.executionId,
						hostSessionRef: "accepted-host",
						outcome: "binding_found",
					});
				return denial(res, "RUNTIME_SERVICE_UNAUTHORIZED", 401);
			}
			const [schema, command] = routes[path];
			const parsed = schema.parse(body);
			behavior.beforeValidate?.(path, parsed, state);
			let claims;
			try {
				claims = validateRuntimeExecutionGrantV2(
					parsed,
					command,
					verify(parsed.grant),
					{
						expectedIssuer: "capacity-issuer",
						expectedWorkerId: "capacity-worker",
						now: () => state.now,
					},
				);
			} catch {
				state.denied.push("grant");
				if (path === "original-binding" && behavior.acceptCrossBinding)
					return json(res, {
						schemaVersion: 3,
						executionId: body.executionId,
						hostSessionRef: "accepted-host",
						outcome: "binding_found",
					});
				return denial(res, "RUNTIME_GRANT_INVALID", 403);
			}
			if (path === "original-binding")
				return json(res, {
					schemaVersion: 3,
					executionId: body.executionId,
					hostSessionRef: "accepted-host",
					outcome: "binding_found",
				});
			assert.equal(body.operation.id, body.executionId);
			assert.equal(claims.principal.kind, "application");
			if (path === "turns") {
				assert.equal(body.hostSessionRef, null);
				assert.deepEqual(body.input.attachments, []);
				assert.match(body.input.text, /exactly READY.*Do not use tools/);
				state.submits.push(body);
				state.authority = claims.authorizationRecordId;
				state.executionId = body.executionId;
				state.wire = events(body.executionId);
				behavior.mutateEvents?.(state.wire);
				const accepted = {
					schemaVersion: 3,
					operationId: body.executionId,
					hostSessionRef: "accepted-host",
					result: { outcome: "accepted", status: "running" },
				};
				return behavior.submit
					? behavior.submit(res, accepted, state)
					: json(res, accepted);
			}
			assert.equal(body.executionId, state.executionId);
			assert.equal(body.hostSessionRef, "accepted-host");
			assert.equal(claims.hostSessionRef, "accepted-host");
			assert.equal(claims.authorizationRecordId, state.authority);
			if (path === "events/stream") {
				state.reads.push({ ...body, claims });
				state.now = Math.max(state.now, epoch + 10);
				if (behavior.stream) return behavior.stream(res, body, state);
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(state.wire.map(frame).join(""));
			} else if (path === "events/ack") {
				assert.equal(
					state.checkpoints.at(-1).confirmedCursor,
					body.confirmedCursor,
					"checkpoint must commit before cumulative ACK",
				);
				state.acks.push(body.confirmedCursor);
				const ack = {
					schemaVersion: 3,
					executionId: body.executionId,
					confirmedCursor: body.confirmedCursor,
				};
				if (behavior.ack) return behavior.ack(res, ack, state);
				json(res, ack);
			} else if (path === "authorizations/renew") {
				state.renewals.push(body);
				json(res, {
					schemaVersion: 3,
					executionId: body.executionId,
					expiresAt: claims.expiresAt,
				});
			}
		} catch (error) {
			state.errors.push(error);
			denial(res, "RUNTIME_INTERNAL_ERROR", 500);
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		assert.deepEqual(state.errors, []);
	});
	const controller = new AbortController();
	const options = {
		baseUrl: `http://127.0.0.1:${server.address().port}`,
		serviceToken: "synthetic-private-service",
		privateKey: keys.privateKey,
		grantIssuer: "capacity-issuer",
		grantKeyId: "capacity-key",
		workerId: "capacity-worker",
		agentId: "isolated-agent",
		principal: { kind: "application", id: "capacity-app" },
		modelOptionId: "custom:model",
		reasoningLevel: "medium",
		runtimeConfigVersion: "custom-v1",
		expectedModelId: "actual-model",
		expectedReply: "READY",
		signal: controller.signal,
		now: () => state.now,
		checkpoint: async (value) => {
			await behavior.checkpoint?.(value, state);
			state.checkpoints.push(value);
		},
	};
	return {
		state,
		options,
		controller,
		run: (extra = {}) => measureCustomRuntime({ ...options, ...extra }),
	};
}

test("real HTTP verifies V3 schemas and Grant V2 signature/binding before one submission and cumulative ACKs", async (t) => {
	const f = await setup(t);
	const result = await f.run();
	assert.deepEqual(f.state.denied, ["service", "grant"]);
	assert.equal(f.state.submits.length, 1);
	assert.equal(f.state.reads[0].afterCursor, null);
	assert.deepEqual(
		f.state.acks,
		[1, 2, 3, 4, 5].map((n) => `cursor-${n}`),
	);
	assert.equal(result.executionId, f.state.executionId);
	assert.equal(result.hostSessionRef, "accepted-host");
	assert.equal(result.submittedAt, iso(0));
	assert.equal(result.completedAt, iso(5));
	assert.equal(result.replyMatched, true);
	assert.equal(
		result.replySha256,
		createHash("sha256").update("READY").digest("hex"),
	);
	assert.deepEqual(
		result.modelFacts.map((e) => e.payload.phase),
		["started", "completed"],
	);
	assert.deepEqual(result.negativeChecks, {
		wrongServiceToken: true,
		crossBindingGrant: true,
	});
	assert.equal(f.state.checkpoints.at(-1).terminal, true);
	assert.doesNotMatch(
		JSON.stringify(f.state.checkpoints),
		/READY|synthetic-private-service|PRIVATE KEY|runtime-execution-jws/,
	);
});

test("ACP duration sampled one millisecond after finishedAt remains a valid completion", async (t) => {
	const f = await setup(t, {
		mutateEvents(events) {
			events[3].payload.durationMs = 3;
		},
	});
	const result = await f.run();
	assert.equal(result.replyMatched, true);
	assert.equal(result.modelFacts[1].payload.durationMs, 3);
	assert.equal(f.state.acks.at(-1), "cursor-5");
});

test("duration cannot underreport the observed model interval by more than one second", async (t) => {
	const f = await setup(t, {
		beforeValidate(path, _body, state) {
			if (path === "events/stream") state.now += 3_000;
		},
		mutateEvents(events) {
			events[3].occurredAt = iso(2_004);
			events[3].payload.finishedAt = iso(2_004);
			events[3].payload.durationMs = 0;
			events[4].occurredAt = iso(2_005);
		},
	});
	await assert.rejects(f.run(), { code: "CUSTOM_CAPACITY_MODEL_FACT_INVALID" });
	assert.ok(!f.state.acks.includes("cursor-5"));
});

test("a real non-rejection of the wrong service token fails before any submit", async (t) => {
	const f = await setup(t, { acceptWrongToken: true });
	await assert.rejects(f.run(), {
		code: "CUSTOM_CAPACITY_NEGATIVE_CHECK_FAILED",
	});
	assert.equal(f.state.submits.length, 0);
});

test("shared verifier rejects signed operation mismatch, altered signature, and host-session drift", async (t) => {
	const f = await setup(t);
	await f.run();
	const request = f.state.reads[0];
	for (const changed of [
		{ ...request, hostSessionRef: null },
		{
			...request,
			operation: { ...request.operation, id: "foreign-execution" },
		},
		{ ...request, executionId: "foreign-execution" },
		{
			...request,
			grant: {
				...request.grant,
				token: `${request.grant.token.slice(0, -2)}AA`,
			},
		},
	])
		assert.throws(() =>
			validateRuntimeExecutionGrantV2(
				changed,
				"events.persist",
				verify(changed.grant),
				{
					expectedIssuer: "capacity-issuer",
					expectedWorkerId: "capacity-worker",
					now: () => f.state.now,
				},
			),
		);
});

test("a cross-binding grant accepted by HTTP cannot pass the negative check", async (t) => {
	const f = await setup(t, { acceptCrossBinding: true });
	await assert.rejects(f.run(), {
		code: "CUSTOM_CAPACITY_NEGATIVE_CHECK_FAILED",
	});
	assert.equal(f.state.submits.length, 0);
});

test("expired SSE grants renew and resume the original cursor without resubmitting", async (t) => {
	let readAttempts = 0;
	const f = await setup(t, {
		beforeValidate(path, _body, state) {
			if (path === "events/stream" && ++readAttempts === 2) state.now += 31_000;
		},
		stream(res, body, state) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (state.reads.length === 1)
				res.end(state.wire.slice(0, 2).map(frame).join(""));
			else {
				assert.equal(body.afterCursor, "cursor-2");
				res.end(state.wire.slice(2).map(frame).join(""));
			}
		},
	});
	const result = await f.run();
	assert.equal(result.replyMatched, true);
	assert.equal(readAttempts, 3);
	assert.equal(f.state.submits.length, 1);
	assert.equal(f.state.renewals.length, 1);
	assert.equal(f.state.reads[1].afterCursor, "cursor-2");
	assert.notEqual(f.state.reads[0].grant.token, f.state.reads[1].grant.token);
});

for (const [name, mutate, code] of [
	[
		"cross-execution event",
		(e) => {
			e[0].executionId = "other";
		},
		"CUSTOM_CAPACITY_EVENT_INVALID",
	],
	[
		"model identity",
		(e) => {
			e[0].payload.model.modelId = "wrong-model";
		},
		"CUSTOM_CAPACITY_MODEL_IDENTITY_INVALID",
	],
	[
		"config version",
		(e) => {
			e[0].payload.model.configVersion = "other-version";
		},
		"CUSTOM_CAPACITY_MODEL_IDENTITY_INVALID",
	],
	[
		"model option",
		(e) => {
			e[0].payload.model.modelOptionId = "other-option";
		},
		"CUSTOM_CAPACITY_MODEL_IDENTITY_INVALID",
	],
	[
		"reasoning level",
		(e) => {
			e[0].payload.model.reasoningLevel = "high";
		},
		"CUSTOM_CAPACITY_MODEL_IDENTITY_INVALID",
	],
	[
		"cross-attempt completed fact",
		(e) => {
			e[3].payload.attemptRef = "other-attempt";
		},
		"CUSTOM_CAPACITY_MODEL_BINDING_INVALID",
	],
	[
		"cross-operation completed fact",
		(e) => {
			e[3].payload.operationRef = "other-operation";
		},
		"CUSTOM_CAPACITY_MODEL_BINDING_INVALID",
	],
	[
		"unknown model",
		(e) => {
			e[3].payload.phase = "unknown";
		},
		"CUSTOM_CAPACITY_MODEL_FACT_INVALID",
	],
	[
		"failed model",
		(e) => {
			e[3].payload.phase = "failed";
		},
		"CUSTOM_CAPACITY_MODEL_FACT_INVALID",
	],
	[
		"duration overreport beyond the one-second sampling tolerance",
		(e) => {
			e[3].payload.durationMs = 1_003;
		},
		"CUSTOM_CAPACITY_MODEL_FACT_INVALID",
	],
	[
		"negative duration",
		(e) => {
			e[3].payload.durationMs = -1;
		},
		"CUSTOM_CAPACITY_EVENT_INVALID",
	],
	[
		"fractional duration",
		(e) => {
			e[3].payload.durationMs = 1.5;
		},
		"CUSTOM_CAPACITY_EVENT_INVALID",
	],
	[
		"changed start time",
		(e) => {
			e[3].payload.startedAt = iso(3);
		},
		"CUSTOM_CAPACITY_MODEL_FACT_INVALID",
	],
	[
		"future event",
		(e) => {
			e[0].occurredAt = iso(30_000);
		},
		"CUSTOM_CAPACITY_EVENT_TIME_INVALID",
	],
	[
		"pre-submit fact",
		(e) => {
			e[1].payload.startedAt = iso(-1);
		},
		"CUSTOM_CAPACITY_EVENT_TIME_INVALID",
	],
	[
		"missing model completion",
		(e) => {
			e.splice(3, 1);
		},
		"CUSTOM_CAPACITY_COMPLETION_INVALID",
	],
	[
		"duplicate model start",
		(e) => {
			e[3].payload = structuredClone(e[1].payload);
		},
		"CUSTOM_CAPACITY_MODEL_FACT_INVALID",
	],
	[
		"unknown status",
		(e) => {
			e[2].type = "status";
			e[2].payload = { status: "unknown" };
		},
		"CUSTOM_CAPACITY_EXECUTION_UNCONFIRMED",
	],
	[
		"reply mismatch",
		(e) => {
			e[2].payload.delta = "not ready";
		},
		"CUSTOM_CAPACITY_COMPLETION_INVALID",
	],
	[
		"tool activity",
		(e) => {
			e[2].type = "tool";
			e[2].payload = { toolCallId: "tool", name: "Bash", phase: "started" };
		},
		"CUSTOM_CAPACITY_UNEXPECTED_EVENT",
	],
	[
		"duplicate cursor",
		(e) => {
			e[2].cursor = e[1].cursor;
		},
		"CUSTOM_CAPACITY_EVENT_BINDING_INVALID",
	],
])
	test(`rejects ${name} without a terminal success`, async (t) => {
		const f = await setup(t, { mutateEvents: mutate });
		await assert.rejects(f.run(), { code });
		assert.equal(f.state.submits.length, 1);
		assert.ok(!f.state.acks.includes("cursor-5"));
	});

for (const terminal of [false, true])
	test(`${terminal ? "terminal" : "first"} ACK failure cannot return success`, async (t) => {
		const f = await setup(t, {
			ack(res, ack) {
				if (!terminal || ack.confirmedCursor === "cursor-5")
					denial(res, "RUNTIME_INTERNAL_ERROR", 500);
				else json(res, ack);
			},
		});
		await assert.rejects(f.run(), { code: "CUSTOM_CAPACITY_ACK_FAILED" });
		assert.equal(f.state.submits.length, 1);
	});

test("checkpoint failure prevents ACK of uncommitted events", async (t) => {
	const f = await setup(t, {
		checkpoint(value) {
			if (value.confirmedCursor)
				throw new Error("private body must not escape");
		},
	});
	await assert.rejects(f.run(), {
		code: "CUSTOM_CAPACITY_CHECKPOINT_FAILED",
		message: "CUSTOM_CAPACITY_CHECKPOINT_FAILED",
	});
	assert.deepEqual(f.state.acks, []);
});

for (const outcome of ["unknown", "wrong-operation"])
	test(`submit ${outcome} never starts stream or retries`, async (t) => {
		const f = await setup(t, {
			submit(res, accepted) {
				if (outcome === "unknown")
					accepted.result = {
						outcome: "unknown",
						code: "RUNTIME_ACCEPTANCE_UNKNOWN",
						message: "Runtime command acceptance could not be confirmed",
					};
				else accepted.operationId = "foreign";
				json(res, accepted);
			},
		});
		await assert.rejects(f.run(), {
			code: "CUSTOM_CAPACITY_SUBMIT_UNCONFIRMED",
		});
		assert.equal(f.state.submits.length, 1);
		assert.equal(f.state.reads.length, 0);
	});

test("deadline bounds stalled HTTP response bodies", async (t) => {
	let timer;
	const f = await setup(t, {
		stream(res) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(": waiting\n\n");
			timer = setTimeout(() => f.controller.abort(), 30);
		},
	});
	t.after(() => clearTimeout(timer));
	await assert.rejects(f.run(), { code: "CUSTOM_CAPACITY_DEADLINE" });
	assert.equal(f.state.reads.length, 1);
});

for (const changed of [
	{ executionId: "other-execution" },
	{ confirmedCursor: "other-cursor" },
])
	test(`ACK response binding ${Object.keys(changed)[0]} is checked`, async (t) => {
		const f = await setup(t, {
			ack(res, ack) {
				json(res, { ...ack, ...changed });
			},
		});
		await assert.rejects(f.run(), { code: "CUSTOM_CAPACITY_ACK_FAILED" });
	});

test("deadline bounds a terminal ACK body even when the transport ignores abort", async (t) => {
	const f = await setup(t);
	const fetcher = async (input, init) => {
		const response = await fetch(input, init);
		if (
			String(input).endsWith("/events/ack") &&
			JSON.parse(init.body).confirmedCursor === "cursor-5"
		) {
			await response.body.cancel();
			setImmediate(() => f.controller.abort());
			return new Response(
				new ReadableStream({
					pull() {
						return new Promise(() => {});
					},
				}),
				{ headers: { "content-type": "application/json" } },
			);
		}
		return response;
	};
	await assert.rejects(f.run({ fetch: fetcher }), {
		code: "CUSTOM_CAPACITY_DEADLINE",
	});
	assert.equal(f.state.acks.at(-1), "cursor-5");
});

test("deadline rejects a late submit result from a fetch dependency ignoring abort", async (t) => {
	const f = await setup(t);
	let release;
	const fetcher = async (input, init) => {
		const response = await fetch(input, init);
		if (!String(input).endsWith("/turns")) return response;
		await new Promise((resolve) => {
			release = resolve;
			f.controller.abort();
		});
		return response;
	};
	await assert.rejects(f.run({ fetch: fetcher }), {
		code: "CUSTOM_CAPACITY_DEADLINE",
	});
	release();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.state.reads.length, 0);
	assert.deepEqual(f.state.checkpoints, []);
});

test("deadline rejects a late checkpoint and never ACKs it", async (t) => {
	const f = await setup(t);
	let release;
	await assert.rejects(
		f.run({
			checkpoint: async (value) => {
				if (!value.confirmedCursor) {
					f.state.checkpoints.push(value);
					return;
				}
				await new Promise((resolve) => {
					release = resolve;
					f.controller.abort();
				});
			},
		}),
		{ code: "CUSTOM_CAPACITY_DEADLINE" },
	);
	release();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(f.state.acks, []);
});

test("total byte limit bounds endless valid SSE comments", async (t) => {
	const f = await setup(t, {
		stream(res) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(": synthetic\n\n".repeat(100_000));
		},
	});
	await assert.rejects(f.run(), { code: "CUSTOM_CAPACITY_EVENT_LIMIT" });
});

test("event count is bounded independently of byte count", async (t) => {
	const f = await setup(t, {
		stream(res, body) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(
				Array.from({ length: 257 }, (_, n) => ({
					schemaVersion: 1,
					executionId: body.executionId,
					adapterEventKey: `event-${n}`,
					cursor: `cursor-${n}`,
					occurredAt: iso(1),
					type: "status",
					payload: { status: "running" },
				}))
					.map(frame)
					.join(""),
			);
		},
	});
	await assert.rejects(f.run(), { code: "CUSTOM_CAPACITY_EVENT_LIMIT" });
	assert.equal(f.state.acks.length, 256);
});
