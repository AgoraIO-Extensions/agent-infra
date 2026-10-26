import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";

import { expect, it } from "vitest";

import {
	RuntimeNativeCapabilityRequestV4Schema,
	RuntimePrivateRelayKeyFieldV1Schema,
} from "./host-v4.ts";
import {
	RuntimeBusinessGrantClaimsV6Schema,
	RuntimeNativeCapabilityRequestV6Schema,
	RuntimeNativeCapabilityTransportV6Schema,
	RuntimeRestoreExecutionKeyGrantClaimsV6Schema,
	RuntimeRestoreExecutionKeyRequestV6Schema,
	runtimeOperationDigestV6,
	runtimeRequestDigestV6,
	runtimeRequestSigningPayloadV6,
	validateVerifiedRuntimeExecutionGrantClaimsV6,
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

it("preserves the accepted digest across request renewal, but not frozen-input changes", async () => {
	const original = await runtimeOperationDigestV6(request);
	const renewed = {
		...request,
		requestId: "new-request",
		traceId: "new-trace",
		grant: { ...request.grant, token: "x.y.z" },
		operation: {
			...request.operation,
			deliveryFence: 3,
			executionDeliveryFence: 3,
		},
	};
	expect(await runtimeOperationDigestV6(renewed)).toBe(original);
	expect(await runtimeRequestDigestV6(renewed)).not.toBe(
		await runtimeRequestDigestV6(request),
	);
	for (const changed of [
		{ principal: { kind: "user" as const, id: "bob" } },
		{ agentId: "agent-2" },
		{ conversationId: "conversation-2" },
		{ executionId: "execution-2" },
		{ turnId: "turn-2" },
		{ sessionGeneration: 2 },
		{ hostSessionRef: "session-2" },
		{ configVersion: "configuration-2" },
		{ selection: { ...request.selection, modelOptionId: "other-model" } },
		{ keyBinding: { ...request.keyBinding, version: 2 } },
		{ directoryRevision: "a".repeat(64) },
		{ parametersDigest: "f".repeat(64) },
		{ capabilitySourceVersion: "other-release" },
	])
		expect(await runtimeOperationDigestV6({ ...request, ...changed })).not.toBe(
			original,
		);
});

it("bounds V6 grants to command execution without attachments or event access", () => {
	const context = {
		expectedIssuer: "platform-worker",
		expectedWorkerId: "worker-1",
		now: 1000,
	};
	const claims = {
		schemaVersion: 6,
		issuer: context.expectedIssuer,
		audience: "runtime_host",
		workerId: context.expectedWorkerId,
		issuedAt: 1000,
		expiresAt: 31000,
		grantId: "grant-1",
		principal: request.principal,
		agentId: request.agentId,
		channelId: request.channelId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		traceId: request.traceId,
		hostSessionRef: request.hostSessionRef,
		operation: request.operation,
		executionSource: request.executionSource,
		relayKeyBinding: request.keyBinding,
		requestDigest: "a".repeat(64),
		purpose: "business",
		authorizationRecordId: "authorization-1",
		allowedCommands: ["native-capability.invoke"],
		attachments: [],
	};
	expect(
		validateVerifiedRuntimeExecutionGrantClaimsV6(claims, context),
	).toEqual(claims);
	for (const changed of [
		{ expiresAt: 1000 },
		{ expiresAt: 31001 },
		{ issuedAt: 1001 },
		{ schemaVersion: 4 },
		{ issuer: "foreign" },
		{ workerId: "foreign" },
		{ allowedCommands: ["turn.submit"] },
		{ attachments: [{ attachmentId: "file", operations: ["read"] }] },
		{
			eventAccess: {
				command: "events.persist",
				consumer: "platform_worker_persistence",
				afterCursor: null,
			},
		},
		{ operation: { ...request.operation, kind: "message" } },
	])
		expect(() =>
			validateVerifiedRuntimeExecutionGrantClaimsV6(
				{ ...claims, ...changed },
				context,
			),
		).toThrow();
	expect(
		RuntimeBusinessGrantClaimsV6Schema.safeParse({
			...claims,
			purpose: "control",
		}).success,
	).toBe(false);
});

it("publishes the strict V6 request and sender response in generated artifacts", async () => {
	const schema = JSON.parse(
		await readFile(
			new URL(
				"../../artifacts/json-schema/runtime.v6.schema.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const openapi = JSON.parse(
		await readFile(
			new URL(
				"../../artifacts/openapi/runtime-host.v6.openapi.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const validate = new Ajv2020({
		strictSchema: false,
		strictTuples: false,
		validateFormats: false,
	}).compile({
		$defs: schema.$defs,
		$ref: "#/$defs/RuntimeNativeCapabilityRequestV6",
	});
	expect(validate(request)).toBe(true);
	for (const changed of [
		{ schemaVersion: 4 },
		{ selection: undefined },
		{ configVersion: undefined },
		{ capabilityKind: "skill" },
		{ attachments: [] },
	])
		expect(validate({ ...request, ...changed })).toBe(false);
	const operation =
		openapi.paths["/internal/runtime/v6/native-capability"].post;
	expect(operation.requestBody.content["application/json"].schema.$ref).toBe(
		"#/components/schemas/RuntimeNativeCapabilityTransportV6",
	);
	expect(
		operation.responses["200"].content["application/json"].schema.$ref,
	).toBe("#/components/schemas/RuntimeOperationResponseV6");
});
