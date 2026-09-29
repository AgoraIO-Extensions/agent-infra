import { z } from "zod";

import {
	OpaqueCursorV1Schema,
	OpaqueIdV1Schema,
	RequestIdV1Schema,
} from "../index.ts";
import { RuntimeStatusV1Schema } from "./events.ts";
import {
	RuntimeExecutionGrantV2Schema,
	RuntimeOperationBindingV2Schema,
	RuntimePrincipalV1Schema,
} from "./grant-v2.ts";
import {
	RuntimeInputV1Schema,
	RuntimeOperationResultV2Schema,
	RuntimeSelectionV1Schema,
} from "./host.ts";

const context = {
	schemaVersion: z.literal(3),
	requestId: RequestIdV1Schema,
	traceId: OpaqueIdV1Schema,
	principal: RuntimePrincipalV1Schema,
	channelId: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	turnId: OpaqueIdV1Schema,
	sessionGeneration: z.number().int().positive().safe(),
	hostSessionRef: OpaqueIdV1Schema.nullable(),
	operation: RuntimeOperationBindingV2Schema,
	grant: RuntimeExecutionGrantV2Schema,
};

export const RuntimeSubmitTurnRequestV3Schema = z.strictObject({
	...context,
	input: RuntimeInputV1Schema,
	selection: RuntimeSelectionV1Schema.optional(),
});
export const RuntimeSupplementRequestV3Schema = z.strictObject({
	...context,
	hostSessionRef: OpaqueIdV1Schema,
	input: RuntimeInputV1Schema,
});
export const RuntimeStopRequestV3Schema = z.strictObject({
	...context,
	hostSessionRef: OpaqueIdV1Schema,
});
export const RuntimeStatusRequestV3Schema = z.strictObject({
	...context,
	originalOperationDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const RuntimeGenerationCancelRequestV3Schema = z.strictObject({
	...context,
	hostSessionRef: OpaqueIdV1Schema,
});
export const RuntimeAuthorizationRenewRequestV3Schema = z.strictObject({
	...context,
	hostSessionRef: OpaqueIdV1Schema,
});
export const RuntimeEventPersistRequestV3Schema = z.strictObject({
	...context,
	hostSessionRef: OpaqueIdV1Schema,
	consumer: z.literal("platform_worker_persistence"),
	afterCursor: OpaqueCursorV1Schema.nullable(),
});
export const RuntimeEventAckRequestV3Schema = z.strictObject({
	...context,
	hostSessionRef: OpaqueIdV1Schema,
	consumer: z.literal("platform_worker_persistence"),
	confirmedCursor: OpaqueCursorV1Schema,
});
export const RuntimeOperationResponseV3Schema = z.strictObject({
	schemaVersion: z.literal(3),
	hostSessionRef: OpaqueIdV1Schema,
	operationId: OpaqueIdV1Schema,
	result: RuntimeOperationResultV2Schema,
});
export const RuntimeStatusResponseV3Schema = z.discriminatedUnion("outcome", [
	z.strictObject({
		schemaVersion: z.literal(3),
		hostSessionRef: OpaqueIdV1Schema,
		executionId: OpaqueIdV1Schema,
		outcome: z.literal("recovery_failed"),
		code: z.literal("RUNTIME_SESSION_RECOVERY_FAILED"),
	}),
	z.strictObject({
		schemaVersion: z.literal(3),
		hostSessionRef: OpaqueIdV1Schema,
		executionId: OpaqueIdV1Schema,
		outcome: z.literal("found"),
		status: RuntimeStatusV1Schema,
	}),
	z.strictObject({
		schemaVersion: z.literal(3),
		hostSessionRef: OpaqueIdV1Schema.nullable(),
		executionId: OpaqueIdV1Schema,
		outcome: z.literal("not_found"),
	}),
]);
export const RuntimeAuthorizationRenewResponseV3Schema = z.strictObject({
	schemaVersion: z.literal(3),
	executionId: OpaqueIdV1Schema,
	expiresAt: z.number().int().positive().safe(),
});
export const RuntimeEventAckResponseV3Schema = z.strictObject({
	schemaVersion: z.literal(3),
	executionId: OpaqueIdV1Schema,
	confirmedCursor: OpaqueCursorV1Schema,
});

export type RuntimeSubmitTurnRequestV3 = z.infer<
	typeof RuntimeSubmitTurnRequestV3Schema
>;
export type RuntimeSupplementRequestV3 = z.infer<
	typeof RuntimeSupplementRequestV3Schema
>;
export type RuntimeStopRequestV3 = z.infer<typeof RuntimeStopRequestV3Schema>;
export type RuntimeStatusRequestV3 = z.infer<
	typeof RuntimeStatusRequestV3Schema
>;
export type RuntimeGenerationCancelRequestV3 = z.infer<
	typeof RuntimeGenerationCancelRequestV3Schema
>;
export type RuntimeAuthorizationRenewRequestV3 = z.infer<
	typeof RuntimeAuthorizationRenewRequestV3Schema
>;
export type RuntimeEventPersistRequestV3 = z.infer<
	typeof RuntimeEventPersistRequestV3Schema
>;
export type RuntimeEventAckRequestV3 = z.infer<
	typeof RuntimeEventAckRequestV3Schema
>;
export type RuntimeOperationResponseV3 = z.infer<
	typeof RuntimeOperationResponseV3Schema
>;
export type RuntimeStatusResponseV3 = z.infer<
	typeof RuntimeStatusResponseV3Schema
>;
export type RuntimeAuthorizationRenewResponseV3 = z.infer<
	typeof RuntimeAuthorizationRenewResponseV3Schema
>;
export type RuntimeEventAckResponseV3 = z.infer<
	typeof RuntimeEventAckResponseV3Schema
>;

// Request identity controls recovery admission; a different ID requires a fresh grant.
export function runtimeRequestSigningPayloadV3(request: {
	requestId: string;
	grant: unknown;
	[key: string]: unknown;
}): string {
	const { grant: _grant, ...payload } = request;
	function canonical(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(canonical);
		if (value !== null && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value)
					.filter(([, entry]) => entry !== undefined)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([key, entry]) => [key, canonical(entry)]),
			);
		}
		return value;
	}
	return JSON.stringify(canonical(payload));
}
