import { z } from "zod";
import { OpaqueIdV1Schema } from "../index.ts";

/**
 * Engineering Spec §18.5.1 (Host 来源写入): the Worker confirms the Host instance and start on
 * the protected Host route bound to the Sandbox's Pod UID. The Host answers only for its own
 * Pod, Agent, Conversation, Host Session Ref and Session generation; the Worker writes the
 * answer into the committed observation only if the Platform's fence and Pod still match.
 */
export const runtimeHostSourceReadPathV1 =
	"/internal/runtime/v1/host-source/read";

const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const podUid = z
	.string()
	.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const generation = z.number().int().safe().positive();

export const RuntimeHostSourceReadRequestV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	podUid,
	agentId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	hostSessionRef: OpaqueIdV1Schema,
	sessionGeneration: generation,
});
export type RuntimeHostSourceReadRequestV1 = z.infer<
	typeof RuntimeHostSourceReadRequestV1Schema
>;

/** Host-produced opaque references; neither is a capability. */
export const RuntimeHostSourceV1Schema = z.strictObject({
	instanceRef: reference,
	startRef: reference,
});

export const RuntimeHostSourceReadResponseV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	podUid,
	agentId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	hostSessionRef: OpaqueIdV1Schema,
	sessionGeneration: generation,
	host: RuntimeHostSourceV1Schema,
});
export type RuntimeHostSourceReadResponseV1 = z.infer<
	typeof RuntimeHostSourceReadResponseV1Schema
>;
