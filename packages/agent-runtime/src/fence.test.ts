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

import { FakeRuntimeDriver, FileRuntimeStore, RuntimeHost } from "./index.js";

const directories: string[] = [];
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

function signedGrant(
	binding: Pick<
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
		grantId: `grant-${binding.conversationId}-${operations.join("-")}`,
		actorId: "actor-fence",
		channelId: "web",
		agentId: binding.agentId,
		conversationId: binding.conversationId,
		executionId: binding.executionId,
		turnId: binding.turnId,
		sessionGeneration: binding.sessionGeneration,
		operations,
		attachments: [],
		actionSetVersion: "actions-fence",
	};
	const payload = Buffer.from(JSON.stringify(claims));
	return {
		schemaVersion: 1,
		algorithm: "Ed25519",
		keyId: "key-fence",
		payload: payload.toString("base64url"),
		signature: sign(null, payload, privateKey).toString("base64url"),
	};
}

function submitRequest(): RuntimeSubmitTurnRequestV1 {
	const binding = {
		agentId: "agent-fence",
		conversationId: "conversation-fence",
		executionId: "execution-fence",
		turnId: "turn-fence",
		sessionGeneration: 1,
	};
	return {
		schemaVersion: 1,
		requestId: "request-fence",
		...binding,
		deliveryFence: 1,
		grant: signedGrant(binding, ["turn.submit"]),
		input: { text: "synthetic-fence-input", attachments: [] },
	};
}

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((value) => rm(value, { recursive: true })),
	);
});

describe("RuntimeHost generation and delivery fencing", () => {
	it("deduplicates concurrent delivery and rejects stale or mismatched requests before side effects", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agent-runtime-fence-"));
		directories.push(directory);
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const runtimeHost = new RuntimeHost({
			store: await FileRuntimeStore.open(join(directory, "host.json")),
			driver,
			grantVerifier: {
				expectedIssuer: "agent-platform",
				expectedAudience: "agent-runtime-host",
				publicKeys: new Map([["key-fence", publicKey]]),
				now: () => new Date("2026-08-28T10:00:00Z"),
			},
		});
		const original = submitRequest();
		const [first, duplicate] = await Promise.all([
			runtimeHost.submitTurn(original),
			runtimeHost.submitTurn({
				...original,
				requestId: "request-fence-duplicate",
			}),
		]);
		expect(duplicate).toEqual(first);
		expect(await driver.sideEffectCount()).toBe(1);

		const takeover = await runtimeHost.submitTurn({
			...original,
			requestId: "request-fence-takeover",
			deliveryFence: 2,
			hostSessionRef: first.hostSessionRef,
		});
		expect(takeover).toEqual(first);
		expect(await driver.sideEffectCount()).toBe(1);

		await expect(
			runtimeHost.stop({
				schemaVersion: 1,
				requestId: "request-stale-stop",
				agentId: original.agentId,
				conversationId: original.conversationId,
				executionId: original.executionId,
				turnId: original.turnId,
				sessionGeneration: 1,
				deliveryFence: 1,
				executionDeliveryFence: 1,
				hostSessionRef: first.hostSessionRef,
				stopRequestId: "stop-stale",
				grant: signedGrant(original, ["turn.stop"]),
			}),
		).rejects.toMatchObject({ code: "RUNTIME_FENCE_STALE" });

		const otherConversation = {
			...original,
			conversationId: "conversation-other",
		};
		await expect(
			runtimeHost.replay({
				schemaVersion: 1,
				requestId: "request-cross-conversation",
				agentId: otherConversation.agentId,
				conversationId: otherConversation.conversationId,
				executionId: otherConversation.executionId,
				turnId: otherConversation.turnId,
				sessionGeneration: 1,
				deliveryFence: 2,
				hostSessionRef: first.hostSessionRef,
				grant: signedGrant(otherConversation, ["events.replay"]),
			}),
		).rejects.toMatchObject({ code: "RUNTIME_SESSION_BINDING_MISMATCH" });

		const nextGeneration = { ...original, sessionGeneration: 2 };
		await expect(
			runtimeHost.status({
				schemaVersion: 1,
				requestId: "request-wrong-generation",
				agentId: nextGeneration.agentId,
				conversationId: nextGeneration.conversationId,
				executionId: nextGeneration.executionId,
				turnId: nextGeneration.turnId,
				sessionGeneration: 2,
				deliveryFence: 2,
				hostSessionRef: first.hostSessionRef,
				grant: signedGrant(nextGeneration, ["session.status"]),
			}),
		).rejects.toMatchObject({ code: "RUNTIME_SESSION_BINDING_MISMATCH" });

		await expect(
			runtimeHost.submitTurn({
				...original,
				requestId: "request-tampered-grant",
				hostSessionRef: first.hostSessionRef,
				deliveryFence: 3,
				grant: { ...original.grant, signature: "dGFtcGVyZWQ" },
			}),
		).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
		expect(await driver.sideEffectCount()).toBe(1);
	});

	it("activates a durable generation barrier before confirming cancellation", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "agent-runtime-generation-"),
		);
		directories.push(directory);
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const runtimeHost = new RuntimeHost({
			store: await FileRuntimeStore.open(join(directory, "host.json")),
			driver,
			grantVerifier: {
				expectedIssuer: "agent-platform",
				expectedAudience: "agent-runtime-host",
				publicKeys: new Map([["key-fence", publicKey]]),
				now: () => new Date("2026-08-28T10:00:00Z"),
			},
		});
		const original = submitRequest();
		const submitted = await runtimeHost.submitTurn(original);
		const cancellation = {
			schemaVersion: 1 as const,
			requestId: "request-generation-cancel",
			agentId: original.agentId,
			conversationId: original.conversationId,
			executionId: original.executionId,
			turnId: original.turnId,
			sessionGeneration: original.sessionGeneration,
			deliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			tombstoneId: "generation-tombstone-1",
			grant: signedGrant(original, ["generation.cancel"]),
		};

		const cancelled = await runtimeHost.cancelGeneration(cancellation);
		expect(cancelled.result).toEqual({
			outcome: "accepted",
			status: "cancelled",
		});
		expect(
			await runtimeHost.cancelGeneration({
				...cancellation,
				requestId: "request-generation-cancel-retry",
				deliveryFence: 2,
			}),
		).toEqual(cancelled);
		expect(await driver.sideEffectCount()).toBe(2);

		await expect(
			runtimeHost.submitTurn({
				...original,
				requestId: "request-after-generation-cancel",
				deliveryFence: 2,
				hostSessionRef: submitted.hostSessionRef,
			}),
		).rejects.toMatchObject({ code: "RUNTIME_GENERATION_CANCELLED" });
		expect(await driver.sideEffectCount()).toBe(2);
	});
});
