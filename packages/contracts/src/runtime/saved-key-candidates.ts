import { z } from "zod";
import {
	OpaqueIdV1Schema,
	RequestIdV1Schema,
	SchemaVersionV1Schema,
} from "../index.ts";

export const RuntimeSavedKeyCandidatesRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	requestId: RequestIdV1Schema,
	traceId: OpaqueIdV1Schema,
	actorId: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	configurationRevision: z.number().int().positive().safe(),
	keyVersion: z.number().int().positive().safe().nullable(),
	/**
	 * 保存时真实验证（ADR-0029）：用已保存的默认 Key 对这些新增的（模型，档位）组合各发一次请求。
	 * 缺省时只读取候选。
	 */
	verify: z
		.array(
			z.strictObject({
				endpointId: OpaqueIdV1Schema,
				modelId: z.string().min(1).max(256),
				reasoningLevel: OpaqueIdV1Schema,
			}),
		)
		.min(1)
		.max(384)
		.optional(),
});

export const RuntimeSavedKeyCandidateV1Schema = z.strictObject({
	endpointId: OpaqueIdV1Schema,
	modelId: z.string().min(1).max(256),
	reasoningLevels: z.array(OpaqueIdV1Schema).min(1).max(64),
});

export const RuntimeSavedKeyCandidatesResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	agentId: OpaqueIdV1Schema,
	configurationRevision: z.number().int().positive().safe(),
	keyVersion: z.number().int().positive().safe(),
	candidates: z.array(RuntimeSavedKeyCandidateV1Schema).max(32768),
	/** 仅在请求带 `verify` 时返回。 */
	verification: z
		.enum(["verified", "key_invalid", "incompatible", "unavailable"])
		.optional(),
});

export type RuntimeSavedKeyCandidatesRequestV1 = z.infer<
	typeof RuntimeSavedKeyCandidatesRequestV1Schema
>;
export type RuntimeSavedKeyCandidatesResponseV1 = z.infer<
	typeof RuntimeSavedKeyCandidatesResponseV1Schema
>;
