import { z } from "zod";
import { OpaqueIdV1Schema, RequestIdV1Schema } from "../index.ts";
import {
	RuntimeExecutionGrantV2Schema,
	RuntimeOperationBindingV2Schema,
	RuntimePrincipalV1Schema,
} from "./grant-v2.ts";

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
	hostSessionRef: OpaqueIdV1Schema,
	operation: RuntimeOperationBindingV2Schema,
	grant: RuntimeExecutionGrantV2Schema,
};

const binding = z.strictObject({
	actionId: OpaqueIdV1Schema,
	confirmationId: OpaqueIdV1Schema,
	operationRef: OpaqueIdV1Schema,
	attemptRef: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	sessionGeneration: z.number().int().positive().safe(),
	capabilityVersion: z.number().int().positive().safe(),
	pageRevision: z.number().int().positive().safe(),
	resourceFence: z.number().int().positive().safe(),
	workloadRevision: z.number().int().positive().safe(),
	imageDigest: z.string().regex(/^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/u),
});

export const RuntimeBrowserSideEffectConfirmationRequestV3Schema =
	z.strictObject({
		...context,
		command: z.enum(["confirm", "reject", "cancel"]),
		binding,
	});

export const RuntimeBrowserSideEffectConfirmationResponseV3Schema =
	z.strictObject({
		schemaVersion: z.literal(3),
		hostSessionRef: OpaqueIdV1Schema,
		executionId: OpaqueIdV1Schema,
		actionId: OpaqueIdV1Schema,
		operationRef: OpaqueIdV1Schema,
		attemptRef: OpaqueIdV1Schema,
		outcome: z.literal("accepted"),
		phase: z.enum(["completed", "failed", "unknown"]),
		failureCode: z.string().min(1).max(256).optional(),
	});

export type RuntimeBrowserSideEffectConfirmationRequestV3 = z.infer<
	typeof RuntimeBrowserSideEffectConfirmationRequestV3Schema
>;
export type RuntimeBrowserSideEffectConfirmationResponseV3 = z.infer<
	typeof RuntimeBrowserSideEffectConfirmationResponseV3Schema
>;
