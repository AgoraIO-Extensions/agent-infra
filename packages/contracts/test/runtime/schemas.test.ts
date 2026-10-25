import { describe, expect, it } from "vitest";

import {
	ExecutionGrantV1Schema,
	RuntimeCapabilitiesV1Schema,
	RuntimeDriverLookupV1Schema,
	RuntimeDriverOperationRecordV1Schema,
	RuntimeDriverSubmitTurnCommandV2Schema,
	RuntimeDriverSubmitTurnOperationRecordV2Schema,
	RuntimeEventV1Schema,
	RuntimeOperationResponseV1Schema,
	RuntimeOperationResponseV2Schema,
	RuntimeOperationResponseV3Schema,
	RuntimeOperationResponseV4Schema,
	RuntimeOperationResponseV5Schema,
	RuntimeOperationResultV1Schema,
	RuntimeOperationResultV2Schema,
	RuntimeReplayRequestV1Schema,
	RuntimeStopRequestV1Schema,
	RuntimeSubmitTurnRequestV1Schema,
	RuntimeSubmitTurnRequestV2Schema,
	RuntimeSupplementRequestV1Schema,
} from "../../src/runtime/index.js";

const signedGrant = {
	schemaVersion: 1,
	format: "compact-jws",
	token: "header.payload.signature",
} as const;

const requestContext = {
	schemaVersion: 1,
	requestId: "request-runtime-1",
	traceId: "trace-runtime-1",
	actorId: "actor-1",
	channelId: "web",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	turnId: "turn-1",
	sessionGeneration: 1,
	deliveryFence: 4,
	grant: signedGrant,
} as const;

describe("RuntimeHost V1 wire schemas", () => {
	it("accepts versioned grant, command, replay, and normalized event shapes", () => {
		expect(ExecutionGrantV1Schema.parse(signedGrant)).toEqual(signedGrant);
		expect(
			RuntimeSubmitTurnRequestV1Schema.parse({
				...requestContext,
				input: { text: "synthetic-conformance-input", attachments: [] },
			}),
		).toMatchObject({ executionId: "execution-1", deliveryFence: 4 });
		expect(
			RuntimeSubmitTurnRequestV1Schema.parse({
				...requestContext,
				input: { attachments: ["attachment-1"] },
			}),
		).toMatchObject({ input: { attachments: ["attachment-1"] } });
		expect(
			RuntimeSupplementRequestV1Schema.parse({
				...requestContext,
				hostSessionRef: "host-session-1",
				messageId: "message-1",
				executionDeliveryFence: 4,
				deliveryFence: 2,
				input: { text: "synthetic-supplement", attachments: [] },
			}),
		).toMatchObject({
			messageId: "message-1",
			executionDeliveryFence: 4,
			deliveryFence: 2,
		});
		expect(
			RuntimeStopRequestV1Schema.parse({
				...requestContext,
				hostSessionRef: "host-session-1",
				stopRequestId: "stop-1",
				executionDeliveryFence: 4,
				deliveryFence: 2,
			}),
		).toMatchObject({ stopRequestId: "stop-1", executionDeliveryFence: 4 });
		expect(
			RuntimeReplayRequestV1Schema.parse({
				...requestContext,
				hostSessionRef: "host-session-1",
				afterCursor: "runtime-cursor-4",
			}),
		).toMatchObject({ afterCursor: "runtime-cursor-4" });
		expect(
			RuntimeEventV1Schema.parse({
				schemaVersion: 1,
				adapterEventKey: "adapter-event-5",
				executionId: "execution-1",
				cursor: "runtime-cursor-5",
				type: "status",
				occurredAt: "2026-08-28T12:00:00Z",
				payload: { status: "running" },
			}),
		).toMatchObject({ type: "status", payload: { status: "running" } });
		expect(
			RuntimeCapabilitiesV1Schema.parse({
				modelSelection: false,
				attachments: true,
				resultFiles: true,
				connection: false,
				supplementaryInstruction: true,
			}),
		).toMatchObject({ supplementaryInstruction: true });
	});

	it("rejects native protocol leakage, malformed fences, and expanded objects", () => {
		expect(
			RuntimeEventV1Schema.safeParse({
				schemaVersion: 1,
				adapterEventKey: "event-error-1",
				executionId: "execution-1",
				cursor: "runtime-cursor-error-1",
				occurredAt: "2026-08-28T12:00:00Z",
				type: "error",
				payload: {
					code: "UPSTREAM_ERROR",
					message: "Provider returned bearer secret-value",
					retryable: false,
				},
			}).success,
		).toBe(false);
		expect(
			RuntimeEventV1Schema.safeParse({
				schemaVersion: 1,
				adapterEventKey: "event-error-1",
				executionId: "execution-1",
				cursor: "runtime-cursor-error-1",
				occurredAt: "2026-08-28T12:00:00Z",
				type: "error",
				payload: {
					code: "RUNTIME_EXECUTION_FAILED",
					message: "Runtime execution failed",
					retryable: false,
				},
			}).success,
		).toBe(true);
		expect(
			RuntimeDriverLookupV1Schema.safeParse({
				state: "found",
				record: {
					schemaVersion: 1,
					agentId: "agent-1",
					conversationId: "conversation-1",
					sessionGeneration: 1,
					kind: "submit-turn",
					operationId: "operation-1",
					nativeSessionRef: "native-1",
					result: {
						outcome: "rejected",
						code: "UPSTREAM_REJECTED",
						message: "Provider returned bearer secret-value",
						retryable: false,
					},
				},
			}).success,
		).toBe(false);
		expect(
			RuntimeDriverOperationRecordV1Schema.safeParse({
				schemaVersion: 1,
				agentId: "agent-1",
				conversationId: "conversation-1",
				sessionGeneration: 1,
				kind: "submit-turn",
				operationId: "operation-1",
				nativeSessionRef: "native-1",
				result: {
					outcome: "rejected",
					code: "RUNTIME_TURN_NOT_ACTIVE",
					message: "Runtime turn is no longer active",
					retryable: false,
				},
			}).success,
		).toBe(true);
		expect(
			RuntimeSupplementRequestV1Schema.safeParse({
				...requestContext,
				hostSessionRef: "host-session-1",
				messageId: "message-1",
				input: { text: "synthetic-supplement", attachments: [] },
			}).success,
		).toBe(false);
		expect(
			RuntimeSubmitTurnRequestV1Schema.safeParse({
				...requestContext,
				nativeSessionId: "vendor-session-1",
				input: { text: "synthetic-conformance-input", attachments: [] },
			}).success,
		).toBe(false);
		expect(
			RuntimeSubmitTurnRequestV1Schema.safeParse({
				...requestContext,
				deliveryFence: 0,
				input: { text: "synthetic-conformance-input", attachments: [] },
			}).success,
		).toBe(false);
		expect(
			RuntimeSubmitTurnRequestV1Schema.safeParse({
				...requestContext,
				input: { attachments: [] },
			}).success,
		).toBe(false);
		expect(
			RuntimeEventV1Schema.safeParse({
				schemaVersion: 1,
				adapterEventKey: "adapter-event-5",
				executionId: "execution-1",
				cursor: "runtime-cursor-5",
				type: "text",
				occurredAt: "2026-08-28T12:00:00Z",
				payload: { delta: "synthetic-output", rawProtocolEvent: {} },
			}).success,
		).toBe(false);
		expect(
			ExecutionGrantV1Schema.safeParse({
				...signedGrant,
				format: "legacy-envelope",
			}).success,
		).toBe(false);
	});
});

describe("RuntimeHost V2 model selection schemas", () => {
	const selection = {
		schemaVersion: 1,
		modelOptionId: "model-option-primary",
		reasoningLevel: "high",
	} as const;

	it("keeps one required selection outside RuntimeInputV1 through Host and Driver", () => {
		const request = RuntimeSubmitTurnRequestV2Schema.parse({
			...requestContext,
			schemaVersion: 2,
			input: { text: "synthetic-conformance-input", attachments: [] },
			selection,
		});
		expect(request.selection).toEqual(selection);
		expect(request.input).not.toHaveProperty("selection");
		expect(
			RuntimeDriverSubmitTurnCommandV2Schema.parse({
				schemaVersion: 2,
				kind: "submit-turn",
				operationId: request.executionId,
				agentId: request.agentId,
				conversationId: request.conversationId,
				executionId: request.executionId,
				turnId: request.turnId,
				sessionGeneration: request.sessionGeneration,
				input: request.input,
				selection: request.selection,
			}),
		).toMatchObject({ selection });
	});

	it.each([
		undefined,
		{},
		{ schemaVersion: 1, modelOptionId: "", reasoningLevel: "high" },
		{
			schemaVersion: 1,
			modelOptionId: "model-option-primary",
			reasoningLevel: "",
		},
		{
			schemaVersion: 1,
			modelOptionId: "model-option-primary",
			reasoningLevel: "high",
			credential: "provider-secret",
		},
	])("rejects omitted, malformed, or expanded selection %j", (candidate) => {
		expect(
			RuntimeSubmitTurnRequestV2Schema.safeParse({
				...requestContext,
				schemaVersion: 2,
				input: { text: "synthetic-conformance-input", attachments: [] },
				...(candidate === undefined ? {} : { selection: candidate }),
			}).success,
		).toBe(false);
	});
});

// #3017：受理不明阻塞的原生会话以稳定脱敏、不可重试的 rejected 拒绝新 Turn；
// #3314：附件读取在原生副作用前被平台明确拒绝时同样以固定成员拒绝。
// 只有 submit V2 及以上的结果联合包含这些成员，V1 结果保持不变。
describe.each([
	{
		code: "RUNTIME_SESSION_BLOCKED",
		message: "Runtime session is blocked by an unconfirmed turn",
	},
	{
		code: "RUNTIME_FILE_INPUT_REJECTED",
		message: "Runtime file input was rejected",
	},
] as const)("RuntimeHost $code rejection", ({ code, message }) => {
	const blocked = {
		outcome: "rejected",
		code,
		message,
		retryable: false,
	} as const;
	const response = {
		hostSessionRef: "host-session-1",
		operationId: "operation-1",
		result: blocked,
	} as const;

	it("accepts the pinned result through V2 to V5 responses and the V2 Driver record", () => {
		expect(RuntimeOperationResultV2Schema.parse(blocked)).toEqual(blocked);
		for (const [schema, schemaVersion] of [
			[RuntimeOperationResponseV2Schema, 2],
			[RuntimeOperationResponseV3Schema, 3],
			[RuntimeOperationResponseV4Schema, 4],
			[RuntimeOperationResponseV5Schema, 5],
		] as const) {
			expect(schema.parse({ ...response, schemaVersion })).toEqual({
				...response,
				schemaVersion,
			});
		}
		expect(
			RuntimeDriverSubmitTurnOperationRecordV2Schema.safeParse({
				schemaVersion: 2,
				agentId: "agent-1",
				conversationId: "conversation-1",
				sessionGeneration: 1,
				kind: "submit-turn",
				operationId: "operation-1",
				nativeSessionRef: "native-1",
				result: blocked,
			}).success,
		).toBe(true);
	});

	it.each([
		{ ...blocked, message: "Codex thread thread-secret is blocked" },
		{ ...blocked, message: "" },
		{ ...blocked, retryable: true },
		{ outcome: blocked.outcome, code: blocked.code, message: blocked.message },
		{ ...blocked, detail: "native-session-1" },
		{ ...blocked, outcome: "unknown" },
	])("rejects drifted session blocked result %j", (candidate) => {
		expect(RuntimeOperationResultV2Schema.safeParse(candidate).success).toBe(
			false,
		);
	});

	it("keeps the submit V1 result closed", () => {
		expect(RuntimeOperationResultV1Schema.safeParse(blocked).success).toBe(
			false,
		);
		expect(
			RuntimeOperationResponseV1Schema.safeParse({
				...response,
				schemaVersion: 1,
			}).success,
		).toBe(false);
		expect(
			RuntimeDriverOperationRecordV1Schema.safeParse({
				schemaVersion: 1,
				agentId: "agent-1",
				conversationId: "conversation-1",
				sessionGeneration: 1,
				kind: "submit-turn",
				operationId: "operation-1",
				nativeSessionRef: "native-1",
				result: blocked,
			}).success,
		).toBe(false);
	});
});

// #3373：Driver 在原生提交点之前声明本次 Turn 未提交：稳定脱敏、可重试、带固定阶段，
// 只有 submit V2 及以上的结果联合包含该成员，V1 结果保持不变。
describe("RuntimeHost RUNTIME_TURN_NOT_SUBMITTED result", () => {
	const notSubmitted = {
		outcome: "rejected",
		code: "RUNTIME_TURN_NOT_SUBMITTED",
		message: "Runtime turn was not submitted",
		reason: "file_input_unavailable",
		retryable: true,
	} as const;
	const response = {
		hostSessionRef: "host-session-1",
		operationId: "operation-1",
		result: notSubmitted,
	} as const;

	it("accepts both pinned reasons through V2 to V5 responses", () => {
		for (const reason of [
			"file_input_unavailable",
			"session_preparation_failed",
		] as const) {
			expect(
				RuntimeOperationResultV2Schema.parse({ ...notSubmitted, reason }),
			).toEqual({ ...notSubmitted, reason });
		}
		for (const [schema, schemaVersion] of [
			[RuntimeOperationResponseV2Schema, 2],
			[RuntimeOperationResponseV3Schema, 3],
			[RuntimeOperationResponseV4Schema, 4],
			[RuntimeOperationResponseV5Schema, 5],
		] as const) {
			expect(schema.parse({ ...response, schemaVersion })).toEqual({
				...response,
				schemaVersion,
			});
		}
	});

	it.each([
		{ ...notSubmitted, message: "Codex app-server is unreachable" },
		{ ...notSubmitted, retryable: false },
		{ ...notSubmitted, reason: "exchange_timeout" },
		{
			outcome: notSubmitted.outcome,
			code: notSubmitted.code,
			message: notSubmitted.message,
			retryable: notSubmitted.retryable,
		},
		{ ...notSubmitted, detail: "RUNTIME_FILE_EXCHANGE_UNAVAILABLE" },
		{ ...notSubmitted, outcome: "unknown" },
	])("rejects drifted not-submitted result %j", (candidate) => {
		expect(RuntimeOperationResultV2Schema.safeParse(candidate).success).toBe(
			false,
		);
	});

	it("keeps the submit V1 result closed", () => {
		expect(RuntimeOperationResultV1Schema.safeParse(notSubmitted).success).toBe(
			false,
		);
		expect(
			RuntimeOperationResponseV1Schema.safeParse({
				...response,
				schemaVersion: 1,
			}).success,
		).toBe(false);
	});
});
