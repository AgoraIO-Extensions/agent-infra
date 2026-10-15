import { z } from "zod";

import { OpaqueIdV1Schema, RequestIdV1Schema } from "../index.ts";
import {
	RuntimeExecutionGrantV2Schema,
	RuntimeOperationBindingV2Schema,
	RuntimePrincipalV1Schema,
} from "./grant-v2.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Authenticated Worker → RuntimeHost native command or Skill invocation. */
export const RuntimeNativeCapabilityRequestV3Schema = z.strictObject({
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
	capabilityId: digest,
	capabilityKind: z.enum(["command", "skill"]),
	directoryRevision: digest,
	capabilitySourceVersion: z.string().min(1).max(512),
	parameters: z.string().max(16 * 1024),
	parametersDigest: digest,
	grant: RuntimeExecutionGrantV2Schema,
});

export type RuntimeNativeCapabilityRequestV3 = z.infer<
	typeof RuntimeNativeCapabilityRequestV3Schema
>;
