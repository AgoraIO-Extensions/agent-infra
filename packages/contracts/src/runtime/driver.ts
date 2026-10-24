import { z } from "zod";

import { OpaqueIdV1Schema, SchemaVersionV1Schema } from "../index.ts";
import {
	RuntimeInputV1Schema,
	RuntimeOperationResultV1Schema,
	RuntimeOperationResultV2Schema,
	RuntimeSelectionV1Schema,
} from "./host.ts";
import { RuntimeRelayKeyBindingV1Schema } from "./host-v4.ts";

const binding = {
	agentId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	turnId: OpaqueIdV1Schema,
	sessionGeneration: z.number().int().positive(),
};

const nativeSkillInput = z.strictObject({
	capabilityId: z.string().regex(/^[a-f0-9]{64}$/),
	directoryRevision: z.string().regex(/^[a-f0-9]{64}$/),
	name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
	version: z.string().min(1).max(512),
	packageDigest: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	manifestDigest: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
});

const nativeCommandInput = z.strictObject({
	capabilityId: z.string().regex(/^[a-f0-9]{64}$/),
	directoryRevision: z.string().regex(/^[a-f0-9]{64}$/),
	capabilityName: z.string().min(1).max(256),
	capabilitySourceVersion: z.string().min(1).max(128),
	parameters: z.string().max(16 * 1024),
	parametersDigest: z.string().regex(/^[a-f0-9]{64}$/),
});

export const RuntimeDriverNativeCommandV1Schema = z.strictObject({
	...binding,
	schemaVersion: SchemaVersionV1Schema,
	kind: z.literal("native-command"),
	operationId: OpaqueIdV1Schema,
	nativeSessionRef: OpaqueIdV1Schema,
	...nativeCommandInput.shape,
});

/**
 * Stateful native commands (for example Codex context compaction) carry the
 * model selection and relay-key binding that were frozen by the Platform
 * execution Grant.  The native RPC itself cannot change either value.
 */
export const RuntimeDriverNativeCommandV2Schema = z.strictObject({
	...binding,
	schemaVersion: z.literal(2),
	kind: z.literal("native-command"),
	operationId: OpaqueIdV1Schema,
	nativeSessionRef: OpaqueIdV1Schema,
	...nativeCommandInput.shape,
	effect: z.literal("state_changing"),
	selection: RuntimeSelectionV1Schema,
	keyBinding: RuntimeRelayKeyBindingV1Schema,
	authorizationRecordId: OpaqueIdV1Schema,
});

const operationBinding = {
	agentId: binding.agentId,
	conversationId: binding.conversationId,
	sessionGeneration: binding.sessionGeneration,
	kind: z.enum([
		"submit-turn",
		"native-command",
		"supplement",
		"stop",
		"generation-cancel",
	]),
	operationId: OpaqueIdV1Schema,
};

export const RuntimeDriverCommandV1Schema = z.discriminatedUnion("kind", [
	z.strictObject({
		...binding,
		schemaVersion: SchemaVersionV1Schema,
		kind: z.literal("submit-turn"),
		operationId: OpaqueIdV1Schema,
		nativeSessionRef: OpaqueIdV1Schema.optional(),
		input: RuntimeInputV1Schema,
		nativeSkill: nativeSkillInput.optional(),
	}),
	RuntimeDriverNativeCommandV1Schema,
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
	...operationBinding,
	nativeSessionRef: OpaqueIdV1Schema,
	result: RuntimeOperationResultV1Schema,
});

export const RuntimeDriverNativeCommandOperationRecordV2Schema = z.strictObject(
	{
		schemaVersion: z.literal(2),
		...operationBinding,
		kind: z.literal("native-command"),
		nativeSessionRef: OpaqueIdV1Schema,
		result: RuntimeOperationResultV2Schema,
		effect: z.literal("state_changing"),
		selection: RuntimeSelectionV1Schema,
		keyBinding: RuntimeRelayKeyBindingV1Schema,
		authorizationRecordId: OpaqueIdV1Schema,
	},
);

export const RuntimeDriverLookupV1Schema = z.discriminatedUnion("state", [
	z.strictObject({
		state: z.literal("found"),
		record: RuntimeDriverOperationRecordV1Schema,
	}),
	z.strictObject({ state: z.literal("missing") }),
	z.strictObject({ state: z.literal("unknown") }),
]);

export const RuntimeDriverSubmitTurnCommandV2Schema = z.strictObject({
	...binding,
	schemaVersion: z.literal(2),
	kind: z.literal("submit-turn"),
	operationId: OpaqueIdV1Schema,
	nativeSessionRef: OpaqueIdV1Schema.optional(),
	input: RuntimeInputV1Schema,
	selection: RuntimeSelectionV1Schema,
	nativeSkill: nativeSkillInput.optional(),
});

export const RuntimeDriverSubmitTurnOperationRecordV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	agentId: operationBinding.agentId,
	conversationId: operationBinding.conversationId,
	sessionGeneration: operationBinding.sessionGeneration,
	kind: z.literal("submit-turn"),
	operationId: operationBinding.operationId,
	nativeSessionRef: OpaqueIdV1Schema,
	result: RuntimeOperationResultV2Schema,
});

/** Version 2 is a discriminated family: submit-turn and stateful native commands. */
export const RuntimeDriverCommandV2Schema = z.discriminatedUnion("kind", [
	RuntimeDriverNativeCommandV2Schema,
	RuntimeDriverSubmitTurnCommandV2Schema,
]);

export const RuntimeDriverOperationRecordV2Schema = z.discriminatedUnion(
	"kind",
	[
		RuntimeDriverNativeCommandOperationRecordV2Schema,
		RuntimeDriverSubmitTurnOperationRecordV2Schema,
	],
);

export const RuntimeDriverSubmitTurnLookupV2Schema = z.discriminatedUnion(
	"state",
	[
		z.strictObject({
			state: z.literal("found"),
			record: RuntimeDriverSubmitTurnOperationRecordV2Schema,
		}),
		z.strictObject({ state: z.literal("missing") }),
		z.strictObject({ state: z.literal("unknown") }),
	],
);

export const RuntimeDriverLookupV2Schema = z.discriminatedUnion("state", [
	z.strictObject({
		state: z.literal("found"),
		record: RuntimeDriverOperationRecordV2Schema,
	}),
	z.strictObject({ state: z.literal("missing") }),
	z.strictObject({ state: z.literal("unknown") }),
]);

export type RuntimeDriverCommandV1 = z.infer<
	typeof RuntimeDriverCommandV1Schema
>;
export type RuntimeDriverNativeCommandV1 = z.infer<
	typeof RuntimeDriverNativeCommandV1Schema
>;
export type RuntimeDriverNativeCommandV2 = z.infer<
	typeof RuntimeDriverNativeCommandV2Schema
>;
export type RuntimeDriverOperationRecordV1 = z.infer<
	typeof RuntimeDriverOperationRecordV1Schema
>;
export type RuntimeDriverNativeCommandOperationRecordV2 = z.infer<
	typeof RuntimeDriverNativeCommandOperationRecordV2Schema
>;
export type RuntimeDriverLookupV1 = z.infer<typeof RuntimeDriverLookupV1Schema>;
export type RuntimeDriverSubmitTurnCommandV2 = z.infer<
	typeof RuntimeDriverSubmitTurnCommandV2Schema
>;
export type RuntimeDriverCommandV2 = z.infer<
	typeof RuntimeDriverCommandV2Schema
>;
export type RuntimeDriverOperationRecordV2 = z.infer<
	typeof RuntimeDriverOperationRecordV2Schema
>;
export type RuntimeDriverSubmitTurnOperationRecordV2 = z.infer<
	typeof RuntimeDriverSubmitTurnOperationRecordV2Schema
>;
export type RuntimeDriverSubmitTurnLookupV2 = z.infer<
	typeof RuntimeDriverSubmitTurnLookupV2Schema
>;
export type RuntimeDriverLookupV2 = z.infer<typeof RuntimeDriverLookupV2Schema>;
