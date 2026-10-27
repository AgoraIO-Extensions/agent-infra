import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { provisionAgents } from "../deploy/ack/provision-agents.mjs";

test("Agent provision sends private credentials and returns only bounded hashes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ack-agent-provision-"));
	const credential = join(directory, "credential");
	const bodyFile = join(directory, "body.json");
	const secret = "Bearer-private-test-value";
	await writeFile(credential, secret, { mode: 0o600 });
	await writeFile(
		bodyFile,
		JSON.stringify({
			schemaVersion: 1,
			name: "controlled-agent",
			description: "private body",
			source: {
				kind: "custom",
				imageReference: `registry.example/agent@sha256:${"a".repeat(64)}`,
				interactionMode: "platform-adapter",
			},
			coOwnerIds: [],
			availability: [],
			actions: [],
			environment: [],
			secrets: [{ name: "MODEL_KEY", value: "private-secret" }],
		}),
		{ mode: 0o600 },
	);
	const calls = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		calls.push({ url, init });
		if (String(url).endsWith("/state"))
			return new Response(
				JSON.stringify({
					schemaVersion: 1,
					agentId: "agent-private",
					status: "available",
					serviceAvailability: "ready",
					revision: 1,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		return new Response(
			JSON.stringify({
				schemaVersion: 1,
				agentId: "agent-private",
				status: "creating",
				revision: 1,
				replayed: false,
			}),
			{ status: 201, headers: { "content-type": "application/json" } },
		);
	};
	try {
		const result = await provisionAgents({
			schemaVersion: 1,
			origin: "https://ack.example.test",
			waitSeconds: 0,
			requests: [
				{
					name: "controlled",
					bodyFile,
					credentialFile: credential,
					idempotencyKey: "controlled-key",
				},
			],
		});
		if (!result.pass || result.results[0].agentHash === undefined)
			throw new Error("bounded provision receipt did not pass");
		const headers = new Headers(calls[0].init.headers);
		if (headers.get("authorization") !== `Bearer ${secret}`)
			throw new Error("credential was not sent to the API");
		if (
			JSON.stringify(result).includes(secret) ||
			JSON.stringify(result).includes("private-secret")
		)
			throw new Error("provision receipt leaked private content");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Agent provision rejects an unpinned or mutable origin before networking", async () => {
	await assert.rejects(
		provisionAgents({
			schemaVersion: 1,
			origin: "http://ack.example.test",
			requests: [],
		}),
		/CONFIGURATION_INVALID/,
	);
});
