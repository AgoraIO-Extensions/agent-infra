import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import {
	RuntimeNativeCapabilityRequestV4Schema,
	RuntimePrivateRelayKeyFieldV1Schema,
} from "./host-v4.ts";
import {
	RuntimeNativeCapabilityRequestV6Schema,
	RuntimeNativeCapabilityTransportV6Schema,
	RuntimeRestoreExecutionKeyGrantClaimsV6Schema,
	RuntimeRestoreExecutionKeyRequestV6Schema,
	runtimeRequestDigestV6,
	runtimeRequestSigningPayloadV6,
} from "./host-v6.ts";

const parameters = "compact";
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
		deliveryFence: 2,
		executionDeliveryFence: 2,
	},
	grant: { schemaVersion: 6, format: "runtime-execution-jws", token: "a.b.c" },
	keyBinding: {
		purpose: "personal",
		subjectId: "alice",
		ciphertextRef: "key-1",
		version: 1,
	},
	capabilityId: "c".repeat(64),
	capabilityKind: "command",
	directoryRevision: "d".repeat(64),
	parameters,
	parametersDigest: createHash("sha256").update(parameters).digest("hex"),
	capabilitySourceVersion: "0.153.0",
	selection: {
		schemaVersion: 1,
		modelOptionId: "model-option-primary",
		reasoningLevel: "high",
	},
	configVersion: "configuration-1",
});

const privateKeyField = RuntimePrivateRelayKeyFieldV1Schema.parse({
	schemaVersion: 1,
	context: {
		requestId: request.requestId,
		grantId: "grant-1",
		requestDigest: "a".repeat(64),
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

it("requires frozen selection and config for a V6 command", () => {
	expect(request.capabilityKind).toBe("command");
	expect(
		RuntimeNativeCapabilityRequestV4Schema.safeParse({
			...request,
			schemaVersion: 4,
		}).success,
	).toBe(false);
	for (const field of ["selection", "configVersion", "keyBinding"]) {
		const value = { ...request } as Record<string, unknown>;
		delete value[field];
		expect(
			RuntimeNativeCapabilityRequestV6Schema.safeParse(value).success,
		).toBe(false);
	}
	expect(
		RuntimeNativeCapabilityRequestV6Schema.safeParse({
			...request,
			capabilityKind: "skill",
		}).success,
	).toBe(false);
});

it("keeps V6 private transport and restore contracts distinct", () => {
	const transport = RuntimeNativeCapabilityTransportV6Schema.parse({
		businessRequest: request,
		privateKeyField,
	});
	expect(transport.businessRequest.schemaVersion).toBe(6);
	const restore = RuntimeRestoreExecutionKeyRequestV6Schema.parse({
		schemaVersion: 6,
		mode: "existing-accepted-only",
		acceptedHostSessionRef: request.hostSessionRef,
		acceptedOperationDigest: "e".repeat(64),
		grant: {
			schemaVersion: 6,
			format: "runtime-execution-jws",
			token: "a.b.c",
		},
		originalRequest: request,
	});
	expect(restore.mode).toBe("existing-accepted-only");
	expect(
		RuntimeRestoreExecutionKeyGrantClaimsV6Schema.safeParse({
			schemaVersion: 6,
			issuer: "platform-worker",
			audience: "runtime_host",
			issuedAt: 1,
			expiresAt: 2,
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
			requestDigest: "a".repeat(64),
			purpose: "business",
			authorizationRecordId: "authorization-1",
			allowedCommands: ["execution.key.restore"],
			attachments: [],
			mode: "existing-accepted-only",
			acceptedHostSessionRef: request.hostSessionRef,
			acceptedOperationDigest: "e".repeat(64),
		}).success,
	).toBe(true);
});

it("binds the private Key context to the accompanying business request", () => {
	const transport = RuntimeNativeCapabilityTransportV6Schema.parse({
		businessRequest: request,
		privateKeyField,
	});
	expect(
		RuntimeNativeCapabilityTransportV6Schema.safeParse({
			...transport,
			businessRequest: { ...request, executionId: "execution-2" },
		}).success,
	).toBe(false);
});

it("binds the digest to selection/config but excludes the Grant token", async () => {
	const payload = runtimeRequestSigningPayloadV6(request);
	const digest = await runtimeRequestDigestV6(request);
	expect(payload).not.toContain("a.b.c");
	expect(digest).toBe(createHash("sha256").update(payload).digest("hex"));
	expect(
		await runtimeRequestDigestV6({
			...request,
			selection: { ...request.selection, reasoningLevel: "low" },
		}),
	).not.toBe(digest);
	expect(
		await runtimeRequestDigestV6({
			...request,
			grant: { ...request.grant, token: "x.y.z" },
		}),
	).toBe(digest);
});
