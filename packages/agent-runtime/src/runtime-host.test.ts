import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	ExecutionGrantClaimsV1,
	RuntimeGrantOperationV1,
	RuntimeSubmitTurnRequestV1,
	SignedExecutionGrantV1,
} from "@agent-infra/contracts/runtime";
import { afterEach, describe, expect, it } from "vitest";

import {
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
	runtimeDriverConformanceTable,
} from "./index.js";

const directories: string[] = [];
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const now = new Date("2026-08-28T10:00:00Z");

async function runtimeDirectory() {
	const directory = await mkdtemp(join(tmpdir(), "agent-runtime-conformance-"));
	directories.push(directory);
	return directory;
}

function grant(
	request: Pick<
		RuntimeSubmitTurnRequestV1,
		| "agentId"
		| "conversationId"
		| "executionId"
		| "turnId"
		| "sessionGeneration"
	>,
	operations: RuntimeGrantOperationV1[],
): SignedExecutionGrantV1 {
	const claims: ExecutionGrantClaimsV1 = {
		schemaVersion: 1,
		issuer: "agent-platform",
		audience: ["agent-runtime-host"],
		issuedAt: "2026-08-28T09:59:00Z",
		expiresAt: "2026-08-28T10:01:00Z",
		grantId: `grant-${request.executionId}-${operations.join("-")}`,
		actorId: "actor-conformance",
		channelId: "web",
		agentId: request.agentId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		operations,
		attachments: [],
		actionSetVersion: "actions-conformance",
	};
	const payload = Buffer.from(JSON.stringify(claims));
	return {
		schemaVersion: 1,
		algorithm: "Ed25519",
		keyId: "key-conformance",
		payload: payload.toString("base64url"),
		signature: sign(null, payload, privateKey).toString("base64url"),
	};
}

function submitRequest(): RuntimeSubmitTurnRequestV1 {
	const binding = {
		agentId: "agent-conformance",
		conversationId: "conversation-conformance",
		executionId: "execution-conformance-1",
		turnId: "turn-conformance-1",
		sessionGeneration: 1,
	};
	return {
		schemaVersion: 1,
		requestId: "request-conformance-1",
		...binding,
		deliveryFence: 1,
		grant: grant(binding, ["turn.submit"]),
		input: { text: "synthetic-conformance-input", attachments: [] },
	};
}

function host(store: FileRuntimeStore, driver: FakeRuntimeDriver) {
	return RuntimeHost.open({
		store,
		driver,
		grantVerifier: {
			expectedIssuer: "agent-platform",
			expectedAudience: "agent-runtime-host",
			publicKeys: new Map([["key-conformance", publicKey]]),
			now: () => now,
		},
	});
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true })),
	);
});

describe("RuntimeHost durable Session", () => {
	it("recovers the same opaque Host Session after Host and Driver restart", async () => {
		const directory = await runtimeDirectory();
		const firstHost = await host(
			await FileRuntimeStore.open(join(directory, "host.json")),
			await FakeRuntimeDriver.open(join(directory, "driver.json")),
		);
		const submitted = await firstHost.submitTurn(submitRequest());

		expect(submitted).toMatchObject({
			schemaVersion: 1,
			operationId: "execution-conformance-1",
			result: { outcome: "accepted", status: "running" },
		});
		expect(submitted.hostSessionRef).not.toContain("native");
		expect(JSON.stringify(submitted)).not.toMatch(
			/native|vendor|stdio|protocol/i,
		);

		const restartedHost = await host(
			await FileRuntimeStore.open(join(directory, "host.json")),
			await FakeRuntimeDriver.open(join(directory, "driver.json")),
		);
		const binding = submitRequest();
		const status = await restartedHost.status({
			schemaVersion: 1,
			requestId: "request-conformance-status",
			agentId: binding.agentId,
			conversationId: binding.conversationId,
			executionId: binding.executionId,
			turnId: binding.turnId,
			sessionGeneration: binding.sessionGeneration,
			deliveryFence: binding.deliveryFence,
			hostSessionRef: submitted.hostSessionRef,
			grant: grant(binding, ["session.status"]),
		});

		expect(status).toEqual({
			schemaVersion: 1,
			hostSessionRef: submitted.hostSessionRef,
			executionId: "execution-conformance-1",
			status: "running",
		});
	});

	it("passes the Session, Turn, event, stop, status, and capability conformance table", async () => {
		const directory = await runtimeDirectory();
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const runtimeHost = await host(
			await FileRuntimeStore.open(join(directory, "host.json")),
			driver,
		);
		const submittedRequest = submitRequest();
		const submitted = await runtimeHost.submitTurn(submittedRequest);
		const base = {
			schemaVersion: 1 as const,
			agentId: submittedRequest.agentId,
			conversationId: submittedRequest.conversationId,
			executionId: submittedRequest.executionId,
			turnId: submittedRequest.turnId,
			sessionGeneration: submittedRequest.sessionGeneration,
		};

		const capabilities = await runtimeHost.capabilities({
			...base,
			requestId: "request-capabilities",
			deliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			grant: grant(base, ["capabilities.read"]),
		});
		expect(capabilities.capabilities).toMatchObject({
			attachments: true,
			supplementaryInstruction: true,
		});

		const initialReplay = await runtimeHost.replay({
			...base,
			requestId: "request-replay-1",
			deliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			grant: grant(base, ["events.replay"]),
		});
		expect(initialReplay.events).toEqual([
			expect.objectContaining({
				adapterEventKey: "fake-event-1",
				type: "status",
				payload: { status: "running" },
			}),
		]);

		const supplemented = await runtimeHost.supplement({
			...base,
			requestId: "request-supplement-1",
			deliveryFence: 1,
			executionDeliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			messageId: "message-supplement-1",
			grant: grant(base, ["turn.supplement"]),
			input: { text: "synthetic-supplement", attachments: [] },
		});
		expect(supplemented.result).toEqual({
			outcome: "accepted",
			status: "running",
		});

		const replayed = await runtimeHost.replay({
			...base,
			requestId: "request-replay-2",
			deliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			afterCursor: initialReplay.events[0]?.cursor,
			grant: grant(base, ["events.replay"]),
		});
		expect(replayed.events).toEqual([
			expect.objectContaining({
				type: "text",
				payload: { delta: "synthetic-supplement-accepted" },
			}),
		]);

		const secondBinding = {
			...base,
			executionId: "execution-conformance-2",
			turnId: "turn-conformance-2",
		};
		const busy = await runtimeHost.submitTurn({
			...secondBinding,
			requestId: "request-busy",
			deliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			grant: grant(secondBinding, ["turn.submit"]),
			input: { text: "synthetic-busy-input", attachments: [] },
		});
		expect(busy.result).toEqual({ outcome: "busy" });

		const stopped = await runtimeHost.stop({
			...base,
			requestId: "request-stop-1",
			deliveryFence: 1,
			executionDeliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			stopRequestId: "stop-1",
			grant: grant(base, ["turn.stop"]),
		});
		expect(stopped.result).toEqual({
			outcome: "accepted",
			status: "cancelled",
		});

		const stoppedAgain = await runtimeHost.stop({
			...base,
			requestId: "request-stop-retry",
			deliveryFence: 2,
			executionDeliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			stopRequestId: "stop-1",
			grant: grant(base, ["turn.stop"]),
		});
		expect(stoppedAgain).toEqual(stopped);
		expect(await driver.sideEffectCount()).toBe(3);

		const status = await runtimeHost.status({
			...base,
			requestId: "request-status-cancelled",
			deliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			grant: grant(base, ["session.status"]),
		});
		expect(status.status).toBe("cancelled");

		const rejected = await runtimeHost.supplement({
			...base,
			requestId: "request-supplement-rejected",
			deliveryFence: 1,
			executionDeliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			messageId: "message-supplement-2",
			grant: grant(base, ["turn.supplement"]),
			input: { text: "synthetic-late-supplement", attachments: [] },
		});
		expect(rejected.result).toMatchObject({
			outcome: "rejected",
			code: "RUNTIME_TURN_NOT_ACTIVE",
		});

		const observations = {
			turn: submitted.result.outcome,
			event: initialReplay.events[0]?.type,
			supplement: supplemented.result.outcome,
			busy: busy.result.outcome,
			stop: stopped.result.outcome,
			status: status.status,
			capabilities: capabilities.capabilities.supplementaryInstruction,
			rejected: rejected.result.outcome,
		};
		expect(observations).toEqual(
			Object.fromEntries(
				runtimeDriverConformanceTable.map(({ capability, expected }) => [
					capability,
					expected,
				]),
			),
		);
	});
});
