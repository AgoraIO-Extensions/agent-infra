import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	RuntimeBusinessGrantClaimsV6Schema,
	RuntimeNativeCapabilityRequestV6Schema,
	RuntimePrivateRelayKeyFieldV1Schema,
	runtimeRequestDigestV6,
} from "@agent-infra/contracts/runtime";
import { afterEach, expect, it, vi } from "vitest";

import { FakeRuntimeDriver } from "./fake-runtime-driver.js";
import { FileRuntimeStore } from "./file-runtime-store.js";
import { RuntimeHost } from "./runtime-host.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("validates V6 admission and fails closed before Store/Key/Driver side effects", async () => {
	const directory = await mkdtemp(join(tmpdir(), "runtime-host-v6-admission-"));
	const store = await FileRuntimeStore.open(join(directory, "host.json"));
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
	const host = await RuntimeHost.open({
		store,
		driver,
		grantValidation: { expectedIssuer: "platform-fixture" },
		validateGrantV6: async (_value) => ({ request, claims }),
	});
	cleanups.push(async () => {
		await host.close();
		await store.close();
		await rm(directory, { recursive: true, force: true });
	});

	const request = RuntimeNativeCapabilityRequestV6Schema.parse({
		schemaVersion: 6,
		requestId: "request-1",
		traceId: "trace-1",
		principal: { kind: "user", id: "alice" },
		executionSource: "web",
		channelId: "web",
		agentId: "agent-1",
		conversationId: "conversation-1",
		executionId: "execution-1",
		turnId: "turn-1",
		sessionGeneration: 1,
		hostSessionRef: "session-1",
		operation: {
			kind: "execution",
			id: "execution-1",
			deliveryFence: 1,
			executionDeliveryFence: 1,
		},
		grant: {
			schemaVersion: 6,
			format: "runtime-execution-jws",
			token: "a.b.c",
		},
		keyBinding: {
			purpose: "personal",
			subjectId: "alice",
			ciphertextRef: "key-1",
			version: 1,
		},
		capabilityId: "c".repeat(64),
		capabilityKind: "command",
		directoryRevision: "d".repeat(64),
		parameters: "compact",
		parametersDigest: createHash("sha256").update("compact").digest("hex"),
		capabilitySourceVersion: "0.153.0",
		selection: {
			schemaVersion: 1,
			modelOptionId: "model-option-primary",
			reasoningLevel: "high",
		},
		configVersion: "configuration-1",
	});
	const requestDigest = await runtimeRequestDigestV6(request);
	const claims = RuntimeBusinessGrantClaimsV6Schema.parse({
		schemaVersion: 6,
		issuer: "platform-fixture",
		audience: "runtime_host",
		issuedAt: 1,
		expiresAt: 30_000,
		grantId: "grant-1",
		workerId: "worker-1",
		principal: request.principal,
		agentId: request.agentId,
		channelId: request.channelId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		traceId: request.traceId,
		hostSessionRef: request.hostSessionRef,
		executionSource: request.executionSource,
		relayKeyBinding: request.keyBinding,
		operation: request.operation,
		requestDigest,
		purpose: "business",
		authorizationRecordId: "authorization-1",
		allowedCommands: ["native-capability.invoke"],
		attachments: [],
	});
	const privateKeyField = RuntimePrivateRelayKeyFieldV1Schema.parse({
		schemaVersion: 1,
		context: {
			requestId: request.requestId,
			grantId: claims.grantId,
			requestDigest,
			traceId: request.traceId,
			principal: request.principal,
			executionSource: request.executionSource,
			channelId: request.channelId,
			agentId: request.agentId,
			conversationId: request.conversationId,
			executionId: request.executionId,
			turnId: request.turnId,
			sessionGeneration: request.sessionGeneration,
			hostSessionRef: request.hostSessionRef,
			operation: request.operation,
			keyBinding: request.keyBinding,
		},
		keyDelivery: { relayKey: "private-key-value-k1" },
	});
	const transport = { businessRequest: request, privateKeyField };
	const before = await readFile(join(directory, "host.json"), "utf8");
	const execute = vi.spyOn(driver, "execute");

	await expect(host.nativeCapabilityV6(transport)).rejects.toMatchObject({
		code: "RUNTIME_NATIVE_CAPABILITY_UNSUPPORTED",
	});
	expect(await readFile(join(directory, "host.json"), "utf8")).toBe(before);
	expect(execute).not.toHaveBeenCalled();
});
