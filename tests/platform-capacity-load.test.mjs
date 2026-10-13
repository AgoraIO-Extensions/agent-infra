import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	parseLoadOptions,
	requestSse,
	runCapacityLoad,
} from "./platform-capacity-load.mjs";

const baseEnv = {
	PLATFORM_LOAD_BASE_URL: "https://platform.example.test",
	PLATFORM_LOAD_AGENT_ID: "agent-under-test",
	PLATFORM_LOAD_ENVIRONMENT: "controlled-fixture",
	PLATFORM_LOAD_MODEL: "model-under-test",
	PLATFORM_LOAD_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
	PLATFORM_LOAD_CONFIRM: "I_HAVE_AUTHORIZED_PLATFORM_TARGET",
	PLATFORM_LOAD_TOKEN: "synthetic-token",
	PLATFORM_LOAD_SOURCE_SHA: "source-sha",
};

function streamBody(chunks) {
	let index = 0;
	return {
		getReader() {
			return {
				async read() {
					if (index >= chunks.length) return { done: true, value: undefined };
					return {
						done: false,
						value: new TextEncoder().encode(chunks[index++]),
					};
				},
				async cancel() {},
			};
		},
	};
}

test("requires explicit target metadata and confirmation", () => {
	assert.throws(
		() => parseLoadOptions([], { ...baseEnv, PLATFORM_LOAD_CONFIRM: "no" }),
		/PLATFORM_LOAD_CONFIRM/,
	);
	assert.throws(
		() => parseLoadOptions(["--users", "2"], baseEnv),
		/PLATFORM_LOAD_TOKENS_FILE/,
	);
});

test("bounds the load plan and rejects non-origin targets", () => {
	assert.throws(
		() => parseLoadOptions(["--tasks", "101"], baseEnv),
		/tasks must be between 1 and 100/,
	);
	assert.throws(
		() =>
			parseLoadOptions([], {
				...baseEnv,
				PLATFORM_LOAD_BASE_URL: "https://user:pass@platform.example.test/api",
			}),
		/HTTP\(S\) origin/,
	);
});

test("records accepted tasks, durable readback and duplicate references without bodies", async () => {
	const calls = [];
	const responses = [
		{ status: 200, body: {} },
		{
			status: 202,
			body: {
				schemaVersion: 1,
				status: "accepted",
				conversationId: "conversation-1",
				executionId: "execution-1",
				messageId: "message-1",
			},
		},
		{
			status: 200,
			body: {
				schemaVersion: 1,
				conversationId: "conversation-1",
				executionId: "execution-1",
				status: "waiting",
				output: "private response must not be recorded",
				events: [],
			},
		},
	];
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		const response = responses.shift();
		return {
			ok: response.status >= 200 && response.status < 300,
			status: response.status,
			json: async () => response.body,
		};
	};
	const options = parseLoadOptions([], baseEnv);
	const evidence = await runCapacityLoad({
		fetchImpl,
		options,
		tokens: ["synthetic-token"],
	});
	assert.equal(evidence.result.acceptedTasks, 1);
	assert.equal(evidence.result.readbackReferences[0].status, "waiting");
	assert.equal(evidence.result.duplicateExecutions, 0);
	assert.equal(evidence.result.summary.byOutcome["preflight:http_ok"], 1);
	assert.equal(evidence.result.summary.byOutcome["submit:http_ok"], 1);
	assert.equal(evidence.result.summary.byOutcome["readback:http_ok"], 1);
	assert.equal(typeof evidence.result.summary.latencyMs.max, "number");
	assert.equal(JSON.stringify(evidence).includes("private response"), false);
	assert.equal(calls[1].init.headers.Authorization, "Bearer synthetic-token");
	assert.match(calls[1].init.headers["Idempotency-Key"], /^platform-load-/);
});

test("stops after an unsuccessful preflight", async () => {
	let requests = 0;
	const evidence = await runCapacityLoad({
		options: parseLoadOptions([], baseEnv),
		tokens: ["synthetic-token"],
		fetchImpl: async () => {
			requests += 1;
			return { ok: false, status: 503, json: async () => ({}) };
		},
	});
	assert.equal(requests, 1);
	assert.equal(evidence.result.acceptedTasks, 0);
	assert.equal(evidence.result.summary.byOutcome["preflight:http_503"], 1);
});

test("marks mismatched durable readback identities as a failure", async () => {
	const responses = [
		{ status: 200, body: {} },
		{
			status: 202,
			body: {
				schemaVersion: 1,
				status: "accepted",
				conversationId: "conversation-1",
				executionId: "execution-1",
				messageId: "message-1",
			},
		},
		{
			status: 200,
			body: {
				schemaVersion: 1,
				conversationId: "conversation-1",
				executionId: "other-execution",
				status: "waiting",
			},
		},
	];
	const evidence = await runCapacityLoad({
		options: parseLoadOptions([], baseEnv),
		tokens: ["synthetic-token"],
		fetchImpl: async () => {
			const response = responses.shift();
			return {
				ok: response.status >= 200 && response.status < 300,
				status: response.status,
				json: async () => response.body,
			};
		},
	});
	assert.equal(
		evidence.result.summary.byOutcome["readback_validation:identity_mismatch"],
		1,
	);
	assert.equal(evidence.result.readbackReferences[0].status, undefined);
});

test("requires a complete non-heartbeat SSE event", async () => {
	const run = (chunks) =>
		requestSse({
			fetchImpl: async () => ({
				ok: true,
				status: 200,
				body: streamBody(chunks),
			}),
			url: "https://platform.example.test/events",
			token: "synthetic-token",
			timeoutMs: 100,
		});
	assert.equal((await run([])).outcome, "stream_ended_without_event");
	assert.equal(
		(await run([": heartbeat\n\n"])).outcome,
		"stream_ended_without_event",
	);
	assert.equal(
		(await run(['data: {"kind":"', 'event"}\n\n'])).outcome,
		"frame_read",
	);
});

test("CLI exits nonzero when the preflight is unavailable", async () => {
	const server = createServer((_request, response) => {
		response.writeHead(503, { "content-type": "application/json" });
		response.end("{}");
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const env = {
		...process.env,
		...baseEnv,
		PLATFORM_LOAD_BASE_URL: `http://127.0.0.1:${address.port}`,
	};
	delete env.PLATFORM_LOAD_TOKEN_FILE;
	delete env.PLATFORM_LOAD_TOKENS_FILE;
	const child = spawn(
		process.execPath,
		[fileURLToPath(new URL("./platform-capacity-load.mjs", import.meta.url))],
		{ env, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stdout = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	const exitCode = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	await new Promise((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	assert.equal(exitCode, 1);
	assert.equal(
		JSON.parse(stdout).result.summary.byOutcome["preflight:http_503"],
		1,
	);
});
