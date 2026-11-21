import { z } from "zod";

import { OpaqueIdV1Schema, SchemaVersionV1Schema } from "../index.ts";
import { RuntimePrincipalV1Schema } from "./grant-v2.ts";

/**
 * #4358 I3: wire for the read-only original admission check (engineering Spec
 * §9.3.2). The proof is its own purpose and audience, signed under its own JWS
 * `typ`, so it can never be read as a Grant or another Runtime read.
 */
export const RuntimeOriginalAdmissionCheckMaximumLifetimeMsV1 = 30_000;

const positiveSafeInteger = z.number().int().positive().safe();
const nonNegativeSafeInteger = z.number().int().nonnegative().safe();
const boundedIdentity = z
	.string()
	.min(1)
	.max(256)
	.refine((value) => !value.includes("\0"));
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const RuntimeOriginalAdmissionChallengeV1Schema = z
	.string()
	.regex(/^[A-Za-z0-9_-]{43}$/);
export const RuntimeOriginalAdmissionPodUidV1Schema = z
	.string()
	.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** The original accepted reference, resolved server-side from persisted records. */
export const RuntimeOriginalAdmissionScopeV1Schema = z.strictObject({
	principal: RuntimePrincipalV1Schema,
	agentId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	originalOperationId: OpaqueIdV1Schema,
	authorizationRecordId: OpaqueIdV1Schema,
	sessionGeneration: positiveSafeInteger,
	executionDeliveryFence: nonNegativeSafeInteger,
	podUid: RuntimeOriginalAdmissionPodUidV1Schema,
});
export type RuntimeOriginalAdmissionScopeV1 = z.infer<
	typeof RuntimeOriginalAdmissionScopeV1Schema
>;

/** The committed Platform facts the Worker read for this one check. */
export const RuntimeOriginalAdmissionPlatformV1Schema = z.strictObject({
	sessionGeneration: positiveSafeInteger,
	resourceFence: nonNegativeSafeInteger,
});

function validateLifetime(
	value: { issuedAt: number; expiresAt: number },
	context: z.RefinementCtx,
) {
	if (
		value.issuedAt >= value.expiresAt ||
		value.expiresAt - value.issuedAt >
			RuntimeOriginalAdmissionCheckMaximumLifetimeMsV1
	)
		context.addIssue({
			code: "custom",
			path: ["expiresAt"],
			message: "Original admission check lifetime is invalid",
		});
}

const bindingShape = {
	schemaVersion: SchemaVersionV1Schema,
	checkId: OpaqueIdV1Schema,
	challenge: RuntimeOriginalAdmissionChallengeV1Schema,
	issuedAt: nonNegativeSafeInteger,
	expiresAt: positiveSafeInteger,
	scope: RuntimeOriginalAdmissionScopeV1Schema,
	platform: RuntimeOriginalAdmissionPlatformV1Schema,
};

export const RuntimeOriginalAdmissionCheckBindingV1Schema = z
	.strictObject(bindingShape)
	.superRefine(validateLifetime);
export type RuntimeOriginalAdmissionCheckBindingV1 = z.infer<
	typeof RuntimeOriginalAdmissionCheckBindingV1Schema
>;

export const RuntimeOriginalAdmissionCheckProofClaimsV1Schema = z
	.strictObject({
		...bindingShape,
		purpose: z.literal("original_admission_check"),
		audience: z.literal("runtime_host.original_admission_check"),
		issuer: boundedIdentity,
		workerId: boundedIdentity,
		keyVersion: boundedIdentity,
		requestDigest: digest,
	})
	.superRefine(validateLifetime);
export type RuntimeOriginalAdmissionCheckProofClaimsV1 = z.infer<
	typeof RuntimeOriginalAdmissionCheckProofClaimsV1Schema
>;

export const RuntimeOriginalAdmissionCheckProofV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	format: z.literal("original-admission-check-jws"),
	token: z.string().min(1).max(16384),
});
export type RuntimeOriginalAdmissionCheckProofV1 = z.infer<
	typeof RuntimeOriginalAdmissionCheckProofV1Schema
>;

export const RuntimeOriginalAdmissionCheckRequestV1Schema = z
	.strictObject({
		...bindingShape,
		proof: RuntimeOriginalAdmissionCheckProofV1Schema,
	})
	.superRefine(validateLifetime);
export type RuntimeOriginalAdmissionCheckRequestV1 = z.infer<
	typeof RuntimeOriginalAdmissionCheckRequestV1Schema
>;

export const RuntimeOriginalAdmissionDecisionV1Schema = z.enum([
	"admissible",
	"denied",
	"unproven",
]);
export const RuntimeOriginalAdmissionReasonV1Schema = z.enum([
	"stale_generation",
	"stale_fence",
	"expired",
	"revoked",
	"scope_mismatch",
	"original_binding_unavailable",
	"unknown",
]);
export type RuntimeOriginalAdmissionReasonV1 = z.infer<
	typeof RuntimeOriginalAdmissionReasonV1Schema
>;

export const RuntimeOriginalAdmissionCheckResponseV1Schema = z
	.strictObject({
		schemaVersion: SchemaVersionV1Schema,
		checkId: OpaqueIdV1Schema,
		challenge: RuntimeOriginalAdmissionChallengeV1Schema,
		decision: RuntimeOriginalAdmissionDecisionV1Schema,
		reason: RuntimeOriginalAdmissionReasonV1Schema.optional(),
		checkedSurface: z.literal("original_call_admission_predicate"),
		original: z.strictObject({
			sessionGeneration: positiveSafeInteger,
			executionDeliveryFence: nonNegativeSafeInteger,
		}),
		current: z.strictObject({
			platformSessionGeneration: positiveSafeInteger,
			platformResourceFence: nonNegativeSafeInteger,
			hostBarrier: z.enum(["none", "active", "confirmed", "unavailable"]),
			hostExecutionFence: nonNegativeSafeInteger.nullable(),
		}),
		checkedAt: nonNegativeSafeInteger,
		clockId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
		dispatchAttempted: z.literal(false),
	})
	.superRefine((value, context) => {
		const stale =
			value.reason === "stale_generation" || value.reason === "stale_fence";
		if (
			(value.decision === "admissible") !== (value.reason === undefined) ||
			(stale && value.decision !== "denied")
		)
			context.addIssue({
				code: "custom",
				path: ["reason"],
				message: "Original admission decision and reason are inconsistent",
			});
	});
export type RuntimeOriginalAdmissionCheckResponseV1 = z.infer<
	typeof RuntimeOriginalAdmissionCheckResponseV1Schema
>;

/** Fixed canonical field order of the request binding; the proof is excluded. */
export function runtimeOriginalAdmissionCheckBindingPayloadV1(
	value: RuntimeOriginalAdmissionCheckBindingV1,
): string {
	const binding = RuntimeOriginalAdmissionCheckBindingV1Schema.parse(value);
	const { scope, platform } = binding;
	return JSON.stringify({
		schemaVersion: binding.schemaVersion,
		checkId: binding.checkId,
		challenge: binding.challenge,
		issuedAt: binding.issuedAt,
		expiresAt: binding.expiresAt,
		scope: {
			principal: { kind: scope.principal.kind, id: scope.principal.id },
			agentId: scope.agentId,
			conversationId: scope.conversationId,
			executionId: scope.executionId,
			originalOperationId: scope.originalOperationId,
			authorizationRecordId: scope.authorizationRecordId,
			sessionGeneration: scope.sessionGeneration,
			executionDeliveryFence: scope.executionDeliveryFence,
			podUid: scope.podUid,
		},
		platform: {
			sessionGeneration: platform.sessionGeneration,
			resourceFence: platform.resourceFence,
		},
	});
}

/** Fixed canonical field order of the complete signed proof claims. */
export function runtimeOriginalAdmissionCheckProofPayloadV1(
	value: RuntimeOriginalAdmissionCheckProofClaimsV1,
): string {
	const claims = RuntimeOriginalAdmissionCheckProofClaimsV1Schema.parse(value);
	const {
		purpose,
		audience,
		issuer,
		workerId,
		keyVersion,
		requestDigest,
		...binding
	} = claims;
	return JSON.stringify({
		...JSON.parse(runtimeOriginalAdmissionCheckBindingPayloadV1(binding)),
		purpose,
		audience,
		issuer,
		workerId,
		keyVersion,
		requestDigest,
	});
}

export const RuntimeOriginalAdmissionCheckV1SchemaDefinitions = {
	RuntimeOriginalAdmissionCheckRequestV1:
		RuntimeOriginalAdmissionCheckRequestV1Schema,
	RuntimeOriginalAdmissionCheckResponseV1:
		RuntimeOriginalAdmissionCheckResponseV1Schema,
	RuntimeOriginalAdmissionCheckProofClaimsV1:
		RuntimeOriginalAdmissionCheckProofClaimsV1Schema,
};
