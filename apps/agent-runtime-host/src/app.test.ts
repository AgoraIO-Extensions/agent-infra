import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createExecutionGrantVerifier,
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
	RuntimeHostError,
} from "@agent-infra/agent-runtime";
import type {
	ExecutionGrantClaimsV1,
	ExecutionGrantCommandV1,
	ExecutionGrantV1,
} from "@agent-infra/contracts/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeHostApp } from "./app.js";

const directories: string[] = [];
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

interface GrantBinding {
	agentId: string;
	actorId: string;
	channelId: string;
	conversationId: string;
	executionId: string;
	turnId: string;
	sessionGeneration: number;
	traceId: string;
}

function executionGrant(
	binding: GrantBinding,
	allowedCommands: ExecutionGrantCommandV1[],
	grantId: string,
): ExecutionGrantV1 {
	const claims: ExecutionGrantClaimsV1 = {
		schemaVersion: 1,
		issuer: "agent-platform",
		audience: ["runtime_host"],
		issuedAt: "2026-08-28T09:59:00Z",
		expiresAt: "2026-08-28T10:01:00Z",
		grantId,
		agentId: binding.agentId,
		actorId: binding.actorId,
		channelId: binding.channelId,
		conversationId: binding.conversationId,
		turnId: binding.turnId,
		executionId: binding.executionId,
		sessionGeneration: binding.sessionGeneration,
		allowedCommands,
		attachments: [],
		actionSetVersion: "actions-http",
		actionIds: [],
		traceId: binding.traceId,
	};
	const protectedSegment = Buffer.from(
		JSON.stringify({ alg: "EdDSA", kid: "key-http" }),
	).toString("base64url");
	const payloadSegment = Buffer.from(JSON.stringify(claims)).toString(
		"base64url",
	);
	const signingInput = `${protectedSegment}.${payloadSegment}`;
	const signatureSegment = sign(
		null,
		Buffer.from(signingInput, "ascii"),
		privateKey,
	).toString("base64url");
	return {
		schemaVersion: 1,
		format: "compact-jws",
		token: `${signingInput}.${signatureSegment}`,
	};
}

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "runtime-host-http-"));
	directories.push(directory);
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
	const host = await RuntimeHost.open({
		store: await FileRuntimeStore.open(join(directory, "host.json")),
		driver,
		grantValidation: {
			expectedIssuer: "agent-platform",
			now: () => "2026-08-28T10:00:00Z",
		},
	});
	return {
		app: createRuntimeHostApp({
			host,
			serviceToken: "synthetic-service-proof",
			verifyGrant: createExecutionGrantVerifier(
				new Map([["key-http", publicKey]]),
			),
		}),
		driver,
	};
}

function submitBody() {
	const binding = {
		agentId: "agent-http",
		actorId: "actor-http",
		channelId: "web",
		conversationId: "conversation-http",
		executionId: "execution-http",
		turnId: "turn-http",
		sessionGeneration: 1,
		traceId: "trace-http",
	};
	return {
		schemaVersion: 1 as const,
		requestId: "request-http",
		...binding,
		deliveryFence: 1,
		grant: executionGrant(
			binding,
			["turn.submit", "events.replay"],
			"grant-http",
		),
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
		const invalidGrant = submitBody();
		const segments = invalidGrant.grant.token.split(".");
		segments[2] = "dGFtcGVyZWQ";
		invalidGrant.grant.token = segments.join(".");
		const rejected = await app.request("/internal/runtime/v1/turns", {
			method: "POST",
			headers: authorizedHeaders,
			body: JSON.stringify(invalidGrant),
		});
		expect(rejected.status).toBe(403);
		Object.assign(driver, {
			execute: async () => {
				throw new RuntimeHostError(
					"UPSTREAM_SECRET_ERROR",
					"Provider returned bearer secret-value",
					418,
				);
			},
		});
		const driverFailure = await app.request("/internal/runtime/v1/turns", {
			method: "POST",
			headers: authorizedHeaders,
			body: JSON.stringify(submitBody()),
		});
		expect(driverFailure.status).toBe(503);
		const driverFailureBody = await driverFailure.json();
		expect(driverFailureBody).toMatchObject({
			code: "RUNTIME_DRIVER_INVALID",
			message: "Runtime Driver response is invalid",
		});
		expect(JSON.stringify(driverFailureBody)).not.toContain("secret-value");
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
					...body,
					requestId: "request-http-replay",
					hostSessionRef: submitted.hostSessionRef,
					input: undefined,
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

	it("keeps a live SSE subscription open after the confirmed cursor", async () => {
		const { app } = await setup();
		const body = submitBody();
		const submittedResponse = await app.request("/internal/runtime/v1/turns", {
			method: "POST",
			headers: authorizedHeaders,
			body: JSON.stringify(body),
		});
		const submitted = (await submittedResponse.json()) as {
			hostSessionRef: string;
		};
		const abort = new AbortController();
		const liveResponse = await app.request(
			"/internal/runtime/v1/events/stream",
			{
				method: "POST",
				headers: authorizedHeaders,
				signal: abort.signal,
				body: JSON.stringify({
					...body,
					requestId: "request-http-live",
					hostSessionRef: submitted.hostSessionRef,
					afterCursor: "fake-cursor-1",
					input: undefined,
				}),
			},
		);
		expect(liveResponse.status).toBe(200);
		expect(liveResponse.headers.get("content-type")).toContain(
			"text/event-stream",
		);
		const reader = liveResponse.body?.getReader();
		if (!reader) throw new Error("expected live SSE body");

		const supplemented = await app.request(
			"/internal/runtime/v1/instructions",
			{
				method: "POST",
				headers: authorizedHeaders,
				body: JSON.stringify({
					...body,
					requestId: "request-http-live-supplement",
					deliveryFence: 1,
					executionDeliveryFence: 1,
					hostSessionRef: submitted.hostSessionRef,
					messageId: "message-http-live",
					grant: executionGrant(
						body,
						["turn.supplement"],
						"grant-http-supplement",
					),
					input: { text: "synthetic-live-supplement", attachments: [] },
				}),
			},
		);
		expect(supplemented.status).toBe(200);
		const next = await Promise.race([
			reader.read(),
			new Promise<never>((_resolve, reject) =>
				setTimeout(() => reject(new Error("live SSE event timed out")), 2_000),
			),
		]);
		expect(next.done).toBe(false);
		const chunk = new TextDecoder().decode(next.value);
		expect(chunk).toContain("id: fake-cursor-2");
		expect(chunk).not.toContain("fake-cursor-1");

		abort.abort();
		await reader.cancel();
	});
});
