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
});

export type RuntimeSavedKeyCandidatesRequestV1 = z.infer<
	typeof RuntimeSavedKeyCandidatesRequestV1Schema
>;
export type RuntimeSavedKeyCandidatesResponseV1 = z.infer<
	typeof RuntimeSavedKeyCandidatesResponseV1Schema
>;
