import assert from "node:assert/strict";
import { test } from "node:test";
import {
	parseLoadOptions,
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
