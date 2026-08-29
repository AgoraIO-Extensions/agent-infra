import { z } from "zod";

import { OpaqueIdV1Schema, SchemaVersionV1Schema } from "../index.ts";
import {
	RuntimeInputV1Schema,
	RuntimeOperationResultV1Schema,
} from "./host.ts";

const binding = {
	agentId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	turnId: OpaqueIdV1Schema,
	sessionGeneration: z.number().int().positive(),
};

export const RuntimeDriverCommandV1Schema = z.discriminatedUnion("kind", [
	z.strictObject({
		...binding,
		schemaVersion: SchemaVersionV1Schema,
		kind: z.literal("submit-turn"),
		operationId: OpaqueIdV1Schema,
		nativeSessionRef: OpaqueIdV1Schema.optional(),
		input: RuntimeInputV1Schema,
	}),
	z.strictObject({
		...binding,
		schemaVersion: SchemaVersionV1Schema,
		kind: z.literal("supplement"),
		operationId: OpaqueIdV1Schema,
		nativeSessionRef: OpaqueIdV1Schema,
		input: RuntimeInputV1Schema,
	}),
	z.strictObject({
		...binding,
		schemaVersion: SchemaVersionV1Schema,
		kind: z.literal("stop"),
		operationId: OpaqueIdV1Schema,
		nativeSessionRef: OpaqueIdV1Schema,
	}),
	z.strictObject({
		...binding,
		schemaVersion: SchemaVersionV1Schema,
		kind: z.literal("generation-cancel"),
		operationId: OpaqueIdV1Schema,
		nativeSessionRef: OpaqueIdV1Schema,
	}),
]);

export const RuntimeDriverOperationRecordV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	operationId: OpaqueIdV1Schema,
	nativeSessionRef: OpaqueIdV1Schema,
	result: RuntimeOperationResultV1Schema,
});

export const RuntimeDriverLookupV1Schema = z.discriminatedUnion("state", [
	z.strictObject({
		state: z.literal("found"),
		record: RuntimeDriverOperationRecordV1Schema,
	}),
	z.strictObject({ state: z.literal("missing") }),
	z.strictObject({ state: z.literal("unknown") }),
]);

export type RuntimeDriverCommandV1 = z.infer<
	typeof RuntimeDriverCommandV1Schema
>;
export type RuntimeDriverOperationRecordV1 = z.infer<
	typeof RuntimeDriverOperationRecordV1Schema
>;
export type RuntimeDriverLookupV1 = z.infer<typeof RuntimeDriverLookupV1Schema>;
