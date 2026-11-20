import { z } from "zod";
import { OpaqueIdV1Schema } from "../common.ts";
import { canonicalRuntimeRequestSigningPayload } from "./request-signing.ts";

export const sessionInstanceReadPathV1 =
	"/internal/runtime/v1/session-instance/read";
const positive = z.number().int().positive().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const compact = z
	.string()
	.max(16_384)
	.regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
export const SessionInstanceScopeV1Schema = z.discriminatedUnion("phase", [
	z.strictObject({
		phase: z.literal("reserve"),
		reserveRef: OpaqueIdV1Schema,
		reserveDeliveryFence: positive,
	}),
	z.strictObject({
		phase: z.literal("claimed"),
		claimRef: OpaqueIdV1Schema,
		allocationRef: OpaqueIdV1Schema,
	}),
]);
const binding = {
	workerId: OpaqueIdV1Schema,
	namespace: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	sessionId: OpaqueIdV1Schema,
	sandboxId: OpaqueIdV1Schema,
	podUid: OpaqueIdV1Schema,
	generation: positive,
	resourceFence: positive,
	startupRef: OpaqueIdV1Schema,
	bindingDigest: digest,
	profileDigest: digest,
};
export const SessionInstanceReadRequestV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	requestId: OpaqueIdV1Schema,
	traceId: OpaqueIdV1Schema,
	nonce: OpaqueIdV1Schema,
	...binding,
	scope: SessionInstanceScopeV1Schema,
	authorization: z.string().min(1).max(16_384),
});
export type SessionInstanceReadRequestV1 = z.infer<
	typeof SessionInstanceReadRequestV1Schema
>;
export const SessionInstanceReadClaimsV1Schema = z.strictObject({
	issuer: OpaqueIdV1Schema,
	audience: z.literal("runtime_host_session_instance"),
	purpose: z.literal("session-instance-read-v1"),
	workerId: OpaqueIdV1Schema,
	issuedAt: positive,
	expiresAt: positive,
	requestDigest: digest,
});
export type SessionInstanceReadClaimsV1 = z.infer<
	typeof SessionInstanceReadClaimsV1Schema
>;
export const SessionInstanceChecksV1Schema = z.strictObject({
	hostIdentityConsumed: z.literal(true),
	runnerIdentityConsumed: z.literal(true),
	deliveryFilesRemoved: z.literal(true),
	executorReady: z.literal(true),
	emptyBusinessState: z.literal(true),
});
export const SessionInstanceEvidenceV1Schema =
	SessionInstanceReadRequestV1Schema.omit({ authorization: true }).extend({
		requestDigest: digest,
		hostKeyId: OpaqueIdV1Schema,
		runnerEpoch: OpaqueIdV1Schema,
		observedAt: positive,
		expiresAt: positive,
		checks: SessionInstanceChecksV1Schema,
		signature: compact,
	});
export type SessionInstanceEvidenceV1 = z.infer<
	typeof SessionInstanceEvidenceV1Schema
>;
export const SessionInstanceEvidenceClaimsV1Schema =
	SessionInstanceEvidenceV1Schema.omit({ signature: true }).extend({
		purpose: z.literal("session-instance-evidence-v1"),
		audience: OpaqueIdV1Schema,
	});
export function sessionInstanceRequestSigningPayloadV1(
	value: SessionInstanceReadRequestV1,
) {
	const { authorization: _authorization, ...body } =
		SessionInstanceReadRequestV1Schema.parse(value);
	const canonical = JSON.parse(
		canonicalRuntimeRequestSigningPayload({ ...body, grant: undefined }),
	);
	return JSON.stringify([1, "POST", sessionInstanceReadPathV1, canonical]);
}
