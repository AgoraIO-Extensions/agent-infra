import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
} from "@agent-infra/agent-runtime";
import type { ExecutionGrantClaimsV1 } from "@agent-infra/contracts/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeHostApp } from "./app.js";

const directories: string[] = [];
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "runtime-host-http-"));
	directories.push(directory);
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
	const host = new RuntimeHost({
		store: await FileRuntimeStore.open(join(directory, "host.json")),
		driver,
		grantVerifier: {
			expectedIssuer: "agent-platform",
			expectedAudience: "agent-runtime-host",
			publicKeys: new Map([["key-http", publicKey]]),
			now: () => new Date("2026-08-28T10:00:00Z"),
		},
	});
	return {
		app: createRuntimeHostApp({
			host,
			serviceToken: "synthetic-service-proof",
		}),
		driver,
	};
}

function submitBody() {
	const claims: ExecutionGrantClaimsV1 = {
		schemaVersion: 1,
		issuer: "agent-platform",
		audience: ["agent-runtime-host"],
		issuedAt: "2026-08-28T09:59:00Z",
		expiresAt: "2026-08-28T10:01:00Z",
		grantId: "grant-http",
		actorId: "actor-http",
		channelId: "web",
		agentId: "agent-http",
		conversationId: "conversation-http",
		executionId: "execution-http",
		turnId: "turn-http",
		sessionGeneration: 1,
		operations: ["turn.submit", "events.replay"],
		attachments: [],
		actionSetVersion: "actions-http",
	};
	const payload = Buffer.from(JSON.stringify(claims));
	return {
		schemaVersion: 1,
		requestId: "request-http",
		agentId: claims.agentId,
		conversationId: claims.conversationId,
		executionId: claims.executionId,
		turnId: claims.turnId,
		sessionGeneration: claims.sessionGeneration,
		deliveryFence: 1,
		grant: {
			schemaVersion: 1,
			algorithm: "Ed25519",
			keyId: "key-http",
			payload: payload.toString("base64url"),
			signature: sign(null, payload, privateKey).toString("base64url"),
		},
		input: { text: "synthetic-http-input", attachments: [] },
	};
}

const authorizedHeaders = {
	authorization: "Bearer synthetic-service-proof",
	"content-type": "application/json",
};

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((value) => rm(value, { recursive: true })),
	);
});

describe("RuntimeHost HTTP/SSE adapter", () => {
	it("rejects unauthenticated and malformed commands before Runtime side effects", async () => {
		const { app, driver } = await setup();
		const unauthorized = await app.request("/internal/runtime/v1/turns", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(submitBody()),
		});
		expect(unauthorized.status).toBe(401);

		const malformed = await app.request("/internal/runtime/v1/turns", {
			method: "POST",
			headers: authorizedHeaders,
			body: JSON.stringify({ schemaVersion: 1 }),
		});
		expect(malformed.status).toBe(400);
		expect(await driver.sideEffectCount()).toBe(0);
	});

	it("submits a Turn and replays normalized events as SSE", async () => {
		const { app } = await setup();
		const body = submitBody();
		const submittedResponse = await app.request("/internal/runtime/v1/turns", {
			method: "POST",
			headers: authorizedHeaders,
			body: JSON.stringify(body),
		});
		expect(submittedResponse.status).toBe(200);
		const submitted = (await submittedResponse.json()) as {
			hostSessionRef: string;
		};

		const replayResponse = await app.request(
			"/internal/runtime/v1/events/replay",
			{
				method: "POST",
				headers: authorizedHeaders,
				body: JSON.stringify({
					schemaVersion: 1,
					requestId: "request-http-replay",
					agentId: body.agentId,
					conversationId: body.conversationId,
					executionId: body.executionId,
					turnId: body.turnId,
					sessionGeneration: body.sessionGeneration,
					deliveryFence: body.deliveryFence,
					hostSessionRef: submitted.hostSessionRef,
					grant: body.grant,
				}),
			},
		);
		expect(replayResponse.status).toBe(200);
		expect(replayResponse.headers.get("content-type")).toContain(
			"text/event-stream",
		);
		const stream = await replayResponse.text();
		expect(stream).toContain("id: fake-cursor-1");
		expect(stream).toContain('"type":"status"');
		expect(stream).not.toMatch(/native|vendor|stdio|protocol/i);
	});
});
