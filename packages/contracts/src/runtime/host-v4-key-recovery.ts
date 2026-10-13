import { z } from "zod";

import { OpaqueIdV1Schema } from "../index.ts";
import {
	RuntimeBusinessGrantClaimsV4Schema,
	RuntimeExecutionGrantV4Schema,
	RuntimePrivateRelayKeyFieldV1Schema,
	RuntimeSubmitTurnRequestV4Schema,
	runtimeRequestDigestV4,
	runtimeRequestSigningPayloadV4,
	validateRuntimeBusinessBindingV4,
	validateRuntimePrivateRelayKeyFieldV1,
	validateVerifiedRuntimeExecutionGrantClaimsV4,
} from "./host-v4.ts";

/**
 * A recovery request names an already accepted operation.  The target session
 * and operation digest are separate from the original submit envelope because
 * the first submit may have been sent with a null Host session reference.
 */
const recoveryBinding = {
	mode: z.literal("existing-accepted-only"),
	acceptedHostSessionRef: OpaqueIdV1Schema,
	acceptedOperationDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
};

export const RuntimeRestoreExecutionKeyRequestV4Schema = z.strictObject({
	schemaVersion: z.literal(4),
	...recoveryBinding,
	grant: RuntimeExecutionGrantV4Schema,
	originalRequest: RuntimeSubmitTurnRequestV4Schema,
});
export type RuntimeRestoreExecutionKeyRequestV4 = z.infer<
	typeof RuntimeRestoreExecutionKeyRequestV4Schema
>;

export const RuntimeRestoreExecutionKeyGrantClaimsV4Schema =
	RuntimeBusinessGrantClaimsV4Schema.omit({ eventAccess: true }).extend({
		...recoveryBinding,
		allowedCommands: z.array(z.literal("execution.key.restore")).length(1),
		attachments: z.array(z.never()).length(0),
	});
export type RuntimeRestoreExecutionKeyGrantClaimsV4 = z.infer<
	typeof RuntimeRestoreExecutionKeyGrantClaimsV4Schema
>;

export const RuntimeRestoreExecutionKeyTransportV4Schema = z.strictObject({
	recoveryRequest: RuntimeRestoreExecutionKeyRequestV4Schema,
	privateKeyField: RuntimePrivateRelayKeyFieldV1Schema,
});
export type RuntimeRestoreExecutionKeyTransportV4 = z.infer<
	typeof RuntimeRestoreExecutionKeyTransportV4Schema
>;

export const RuntimeRestoreExecutionKeyResponseV4Schema = z.strictObject({
	schemaVersion: z.literal(4),
	hostSessionRef: OpaqueIdV1Schema,
	operationId: OpaqueIdV1Schema,
	result: z.literal("restored"),
});
export type RuntimeRestoreExecutionKeyResponseV4 = z.infer<
	typeof RuntimeRestoreExecutionKeyResponseV4Schema
>;

function bindingClaims(claims: RuntimeRestoreExecutionKeyGrantClaimsV4) {
	const {
		mode: _mode,
		acceptedHostSessionRef: _ref,
		acceptedOperationDigest: _digest,
		...common
	} = claims;
	return { ...common, allowedCommands: ["turn.submit"] as const };
}

export function validateVerifiedRuntimeRestoreExecutionKeyGrantClaimsV4(
	input: unknown,
	context: { expectedIssuer: string; expectedWorkerId: string; now: number },
): RuntimeRestoreExecutionKeyGrantClaimsV4 {
	const claims = RuntimeRestoreExecutionKeyGrantClaimsV4Schema.parse(input);
	validateVerifiedRuntimeExecutionGrantClaimsV4(bindingClaims(claims), context);
	if (
		claims.operation.kind !== "execution" ||
		claims.operation.id !== claims.executionId
	) {
		throw new TypeError("RuntimeHostV4 Key recovery Grant is invalid");
	}
	return claims;
}

export function runtimeRestoreExecutionKeySigningPayloadV4(input: unknown) {
	const request = RuntimeRestoreExecutionKeyRequestV4Schema.parse(input);
	return JSON.stringify({
		schemaVersion: request.schemaVersion,
		mode: request.mode,
		acceptedHostSessionRef: request.acceptedHostSessionRef,
		acceptedOperationDigest: request.acceptedOperationDigest,
		// The token is authenticated separately and never enters the signed
		// recovery intent payload.
		originalRequest: JSON.parse(
			runtimeRequestSigningPayloadV4(request.originalRequest),
		),
	});
}

export async function runtimeRestoreExecutionKeyRequestDigestV4(
	input: unknown,
) {
	const bytes = new TextEncoder().encode(
		runtimeRestoreExecutionKeySigningPayloadV4(input),
	);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Validate the signed recovery intent and the original submit binding. */
export async function validateRuntimeRestoreExecutionKeyBindingV4(
	input: unknown,
	verifiedClaims: unknown,
): Promise<void> {
	const request = RuntimeRestoreExecutionKeyRequestV4Schema.parse(input);
	const claims =
		RuntimeRestoreExecutionKeyGrantClaimsV4Schema.parse(verifiedClaims);
	if (
		claims.mode !== request.mode ||
		claims.acceptedHostSessionRef !== request.acceptedHostSessionRef ||
		claims.acceptedOperationDigest !== request.acceptedOperationDigest ||
		claims.requestDigest !==
			(await runtimeRestoreExecutionKeyRequestDigestV4(request)) ||
		claims.hostSessionRef !== request.originalRequest.hostSessionRef
	)
		throw new TypeError("RuntimeHostV4 Key recovery binding is invalid");
	await validateRuntimeBusinessBindingV4(request.originalRequest, {
		...bindingClaims(claims),
		requestDigest: await runtimeRequestDigestV4(request.originalRequest),
		attachments: request.originalRequest.input.attachments.map(
			(attachmentId) => ({ attachmentId, operations: ["read"] as const }),
		),
	});
}

/**
 * The private Key uses the recovery Grant digest, while the rest of its
 * context remains bound to the original accepted submit request.
 */
export function validateRuntimeRestoreExecutionKeyPrivateFieldV4(
	field: unknown,
	accepted: {
		readonly request: RuntimeRestoreExecutionKeyRequestV4;
		readonly claims: RuntimeRestoreExecutionKeyGrantClaimsV4;
	},
) {
	return validateRuntimePrivateRelayKeyFieldV1(field, {
		request: accepted.request.originalRequest,
		grantId: accepted.claims.grantId,
		requestDigest: accepted.claims.requestDigest,
	});
}
