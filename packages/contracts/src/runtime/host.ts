import { z } from "zod";

import {
	OpaqueCursorV1Schema,
	OpaqueIdV1Schema,
	RequestIdV1Schema,
	SchemaVersionV1Schema,
} from "../index.ts";
import {
	RuntimeCapabilitiesV1Schema,
	RuntimeEventV1Schema,
	RuntimeStatusV1Schema,
} from "./events.ts";
import { ExecutionGrantV1Schema } from "./grant.ts";

const positiveFence = z.number().int().positive();
const requestContext = {
	schemaVersion: SchemaVersionV1Schema,
	requestId: RequestIdV1Schema,
	traceId: OpaqueIdV1Schema,
	actorId: OpaqueIdV1Schema,
	channelId: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	turnId: OpaqueIdV1Schema,
	sessionGeneration: z.number().int().positive(),
	deliveryFence: positiveFence,
	grant: ExecutionGrantV1Schema,
};

export const RuntimeInputV1Schema = z.union([
	z.strictObject({
		text: z.string().min(1),
		attachments: z.array(OpaqueIdV1Schema),
	}),
	z.strictObject({ attachments: z.array(OpaqueIdV1Schema).min(1) }),
]);

export const RuntimeSubmitTurnRequestV1Schema = z.strictObject({
	...requestContext,
	hostSessionRef: OpaqueIdV1Schema.optional(),
	input: RuntimeInputV1Schema,
});

export const RuntimeSelectionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	modelOptionId: OpaqueIdV1Schema,
	reasoningLevel: OpaqueIdV1Schema,
});

export const RuntimeSubmitTurnRequestV2Schema = z.strictObject({
	...requestContext,
	schemaVersion: z.literal(2),
	hostSessionRef: OpaqueIdV1Schema.optional(),
	input: RuntimeInputV1Schema,
	selection: RuntimeSelectionV1Schema,
});

export const RuntimeSupplementRequestV1Schema = z.strictObject({
	...requestContext,
	hostSessionRef: OpaqueIdV1Schema,
	messageId: OpaqueIdV1Schema,
	executionDeliveryFence: positiveFence,
	input: RuntimeInputV1Schema,
});

export const RuntimeStopRequestV1Schema = z.strictObject({
	...requestContext,
	hostSessionRef: OpaqueIdV1Schema,
	stopRequestId: OpaqueIdV1Schema,
	executionDeliveryFence: positiveFence,
});

export const RuntimeStatusRequestV1Schema = z.strictObject({
	...requestContext,
	hostSessionRef: OpaqueIdV1Schema,
});

export const RuntimeStatusRequestV2Schema = z.strictObject({
	...requestContext,
	schemaVersion: z.literal(2),
	hostSessionRef: OpaqueIdV1Schema,
	recovery: z.strictObject({
		schemaVersion: SchemaVersionV1Schema,
		input: RuntimeInputV1Schema,
		selection: RuntimeSelectionV1Schema.optional(),
	}),
});

export const RuntimeCapabilitiesRequestV1Schema = z.strictObject({
	...requestContext,
	hostSessionRef: OpaqueIdV1Schema.optional(),
});

/** Read-only public model choices for an already-bound Runtime Host Session. */
const { grant: _runtimeGrant, ...dispatchRequestContext } = requestContext;
export const RuntimeModelDirectoryDispatchRequestV1Schema = z.strictObject({
	...dispatchRequestContext,
	hostSessionRef: OpaqueIdV1Schema,
});

/** Worker-to-Host model-directory request after the Worker has signed a Grant. */
export const RuntimeModelDirectoryRequestV1Schema = z.strictObject({
	...requestContext,
	hostSessionRef: OpaqueIdV1Schema,
});

export const RuntimeModelDirectoryOptionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	modelOptionId: OpaqueIdV1Schema,
	modelId: z.string().min(1).max(256),
	displayName: z.string().min(1).max(256),
	reasoningLevels: z.array(OpaqueIdV1Schema).max(64),
});

export const RuntimeModelDirectoryResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	hostSessionRef: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	options: z.array(RuntimeModelDirectoryOptionV1Schema).max(64),
	current: z.strictObject({
		modelOptionId: OpaqueIdV1Schema,
		reasoningLevel: OpaqueIdV1Schema,
	}),
});

export const RuntimeReplayRequestV1Schema = z.strictObject({
	...requestContext,
	hostSessionRef: OpaqueIdV1Schema,
	afterCursor: OpaqueCursorV1Schema.optional(),
});

export const RuntimeGenerationCancelRequestV1Schema = z.strictObject({
	...requestContext,
	hostSessionRef: OpaqueIdV1Schema,
	tombstoneId: OpaqueIdV1Schema,
});

export const RuntimeOperationResultV1Schema = z.discriminatedUnion("outcome", [
	z.strictObject({
		outcome: z.literal("accepted"),
		status: RuntimeStatusV1Schema,
	}),
	z.strictObject({ outcome: z.literal("busy") }),
	z.strictObject({
		outcome: z.literal("rejected"),
		code: z.literal("RUNTIME_TURN_NOT_ACTIVE"),
		message: z.literal("Runtime turn is no longer active"),
		retryable: z.literal(false),
	}),
	z.strictObject({
		outcome: z.literal("unknown"),
		code: z.literal("RUNTIME_ACCEPTANCE_UNKNOWN"),
		message: z.literal("Runtime command acceptance could not be confirmed"),
	}),
]);

/**
 * #3373：Driver 声明未提交时的失败阶段。附件读取失败但不是平台明确拒绝时为
 * `file_input_unavailable`；物化、原生进程启动或会话恢复、提交前 Grant 复核等其他提交
 * 准备失败为 `session_preparation_failed`。
 */
export const RuntimeTurnNotSubmittedReasonV1Schema = z.enum([
	"file_input_unavailable",
	"session_preparation_failed",
]);

export const RuntimeOperationResultV2Schema = z.union([
	z.strictObject({
		outcome: z.literal("accepted"),
		status: RuntimeStatusV1Schema,
	}),
	z.strictObject({ outcome: z.literal("busy") }),
	z.strictObject({
		outcome: z.literal("rejected"),
		code: z.literal("RUNTIME_TURN_NOT_ACTIVE"),
		message: z.literal("Runtime turn is no longer active"),
		retryable: z.literal(false),
	}),
	z.strictObject({
		outcome: z.literal("rejected"),
		code: z.literal("RUNTIME_MODEL_SELECTION_UNSUPPORTED"),
		message: z.literal("Runtime model selection is unsupported"),
		retryable: z.literal(false),
	}),
	// 原生会话已被受理不明的 Turn 阻塞：稳定脱敏、不可重试，仅 submit V2 及以上可返回。
	z.strictObject({
		outcome: z.literal("rejected"),
		code: z.literal("RUNTIME_SESSION_BLOCKED"),
		message: z.literal("Runtime session is blocked by an unconfirmed turn"),
		retryable: z.literal(false),
	}),
	// #3314：附件读取在任何原生副作用之前被平台明确拒绝：稳定脱敏、不可重试，仅 submit V2 及以上可返回。
	z.strictObject({
		outcome: z.literal("rejected"),
		code: z.literal("RUNTIME_FILE_INPUT_REJECTED"),
		message: z.literal("Runtime file input was rejected"),
		retryable: z.literal(false),
	}),
	// #3373：Driver 在原生提交点之前声明本次 Turn 未提交，且没有该操作的 Driver 记录：稳定脱敏、
	// 可重试（同一 Execution 以更高 fence 与新 Grant 重新投递），仅 submit V2 及以上可返回。
	z.strictObject({
		outcome: z.literal("rejected"),
		code: z.literal("RUNTIME_TURN_NOT_SUBMITTED"),
		message: z.literal("Runtime turn was not submitted"),
		reason: RuntimeTurnNotSubmittedReasonV1Schema,
		retryable: z.literal(true),
	}),
	z.strictObject({
		outcome: z.literal("unknown"),
		code: z.literal("RUNTIME_ACCEPTANCE_UNKNOWN"),
		message: z.literal("Runtime command acceptance could not be confirmed"),
	}),
]);

export const RuntimeOperationResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	hostSessionRef: OpaqueIdV1Schema,
	operationId: OpaqueIdV1Schema,
	result: RuntimeOperationResultV1Schema,
});

export const RuntimeOperationResponseV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	hostSessionRef: OpaqueIdV1Schema,
	operationId: OpaqueIdV1Schema,
	result: RuntimeOperationResultV2Schema,
});

export const RuntimeStatusResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	hostSessionRef: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	status: RuntimeStatusV1Schema,
});

export const RuntimeStatusResponseV2Schema = z.discriminatedUnion("outcome", [
	z.strictObject({
		schemaVersion: z.literal(2),
		hostSessionRef: OpaqueIdV1Schema,
		executionId: OpaqueIdV1Schema,
		outcome: z.literal("found"),
		status: RuntimeStatusV1Schema,
	}),
	z.strictObject({
		schemaVersion: z.literal(2),
		hostSessionRef: OpaqueIdV1Schema,
		executionId: OpaqueIdV1Schema,
		outcome: z.literal("not_found"),
	}),
]);

export const RuntimeCapabilitiesResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	capabilities: RuntimeCapabilitiesV1Schema,
});

const runtimeSkillName = z.string().min(1).max(128);
const runtimeSkillRelativePath = z
	.string()
	.min(1)
	.max(512)
	.regex(/^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.?(?:\/|$)).+$/);
const runtimeSkillGenerationId = z.string().regex(/^[a-f0-9]{64}$/);

function isCanonicalBase64(value: string): boolean {
	if (value.length % 4 !== 0) return false;
	let padding = 0;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code === 61) {
			padding += 1;
			if (padding > 2 || index < value.length - 2) return false;
			continue;
		}
		if (padding > 0) return false;
		const alphabet =
			(code >= 0x30 && code <= 0x39) ||
			(code >= 0x41 && code <= 0x5a) ||
			(code >= 0x61 && code <= 0x7a) ||
			code === 0x2b ||
			code === 0x2f;
		if (!alphabet) return false;
	}
	return true;
}

/** Request for the deployment-owned, read-only mounted Skill directory. */
export const RuntimeSkillDirectoryRequestV1Schema = z.strictObject({
	...requestContext,
	hostSessionRef: OpaqueIdV1Schema,
});

export const RuntimeSkillDirectoryEntryV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	name: runtimeSkillName,
	version: z.string().min(1).max(128),
	manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
	packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
	readOnly: z.literal(true),
});

export const RuntimeSkillDirectoryResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	hostSessionRef: OpaqueIdV1Schema,
	generationId: runtimeSkillGenerationId,
	skills: z.array(RuntimeSkillDirectoryEntryV1Schema).max(150),
});

/** Request for one bounded resource from the mounted Skill directory. */
export const RuntimeSkillResourceReadRequestV1Schema = z.strictObject({
	...RuntimeSkillDirectoryRequestV1Schema.shape,
	generationId: runtimeSkillGenerationId,
	skillName: runtimeSkillName,
	relativePath: runtimeSkillRelativePath,
});

export const RuntimeSkillResourceReadResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	hostSessionRef: OpaqueIdV1Schema,
	generationId: runtimeSkillGenerationId,
	skillName: runtimeSkillName,
	relativePath: runtimeSkillRelativePath,
	sizeBytes: z.number().int().nonnegative().max(1_048_576),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	bytesBase64: z
		.string()
		.max(1_398_104)
		.refine(isCanonicalBase64, "Invalid base64 resource bytes"),
});

export const RuntimeReplayResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	events: z.array(RuntimeEventV1Schema),
});

export type RuntimeInputV1 = z.infer<typeof RuntimeInputV1Schema>;
export type RuntimeSelectionV1 = z.infer<typeof RuntimeSelectionV1Schema>;
export type RuntimeSubmitTurnRequestV1 = z.infer<
	typeof RuntimeSubmitTurnRequestV1Schema
>;
export type RuntimeSubmitTurnRequestV2 = z.infer<
	typeof RuntimeSubmitTurnRequestV2Schema
>;
export type RuntimeSupplementRequestV1 = z.infer<
	typeof RuntimeSupplementRequestV1Schema
>;
export type RuntimeStopRequestV1 = z.infer<typeof RuntimeStopRequestV1Schema>;
export type RuntimeStatusRequestV1 = z.infer<
	typeof RuntimeStatusRequestV1Schema
>;
export type RuntimeStatusRequestV2 = z.infer<
	typeof RuntimeStatusRequestV2Schema
>;
export type RuntimeCapabilitiesRequestV1 = z.infer<
	typeof RuntimeCapabilitiesRequestV1Schema
>;
export type RuntimeModelDirectoryRequestV1 = z.infer<
	typeof RuntimeModelDirectoryRequestV1Schema
>;
export type RuntimeModelDirectoryDispatchRequestV1 = z.infer<
	typeof RuntimeModelDirectoryDispatchRequestV1Schema
>;
export type RuntimeModelDirectoryOptionV1 = z.infer<
	typeof RuntimeModelDirectoryOptionV1Schema
>;
export type RuntimeModelDirectoryResponseV1 = z.infer<
	typeof RuntimeModelDirectoryResponseV1Schema
>;
export type RuntimeReplayRequestV1 = z.infer<
	typeof RuntimeReplayRequestV1Schema
>;
export type RuntimeGenerationCancelRequestV1 = z.infer<
	typeof RuntimeGenerationCancelRequestV1Schema
>;
export type RuntimeOperationResultV1 = z.infer<
	typeof RuntimeOperationResultV1Schema
>;
export type RuntimeOperationResultV2 = z.infer<
	typeof RuntimeOperationResultV2Schema
>;
export type RuntimeOperationResponseV1 = z.infer<
	typeof RuntimeOperationResponseV1Schema
>;
export type RuntimeOperationResponseV2 = z.infer<
	typeof RuntimeOperationResponseV2Schema
>;
export type RuntimeStatusResponseV1 = z.infer<
	typeof RuntimeStatusResponseV1Schema
>;
export type RuntimeStatusResponseV2 = z.infer<
	typeof RuntimeStatusResponseV2Schema
>;
export type RuntimeCapabilitiesResponseV1 = z.infer<
	typeof RuntimeCapabilitiesResponseV1Schema
>;
export type RuntimeSkillDirectoryRequestV1 = z.infer<
	typeof RuntimeSkillDirectoryRequestV1Schema
>;
export type RuntimeSkillDirectoryEntryV1 = z.infer<
	typeof RuntimeSkillDirectoryEntryV1Schema
>;
export type RuntimeSkillDirectoryResponseV1 = z.infer<
	typeof RuntimeSkillDirectoryResponseV1Schema
>;
export type RuntimeSkillResourceReadRequestV1 = z.infer<
	typeof RuntimeSkillResourceReadRequestV1Schema
>;
export type RuntimeSkillResourceReadResponseV1 = z.infer<
	typeof RuntimeSkillResourceReadResponseV1Schema
>;
export type RuntimeReplayResponseV1 = z.infer<
	typeof RuntimeReplayResponseV1Schema
>;
