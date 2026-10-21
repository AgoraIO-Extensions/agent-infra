import { z } from "zod";

import { OpaqueIdV1Schema, RequestIdV1Schema } from "../index.ts";
import {
	RuntimeOperationBindingV2Schema,
	RuntimePrincipalV1Schema,
} from "./grant-v2.ts";
import { RuntimeOperationResultV2Schema } from "./host.ts";
import {
	RuntimeBusinessGrantClaimsV4Schema,
	RuntimeExecutionGrantV4Schema,
	RuntimeExecutionSourceV1Schema,
	RuntimePrivateRelayKeyFieldV1Schema,
	RuntimeRelayKeyBindingV1Schema,
	validateVerifiedRuntimeExecutionGrantClaimsV4,
} from "./host-v4.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const base64UrlDigest = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const maximumTextAttachments = 4;
const maximumTextAttachmentBytes = 4096;

/**
 * A read-only text input resolved by Core from FileAuthority.
 *
 * The browser names only the file id in Invocation V2. Core resolves the
 * descriptor and verifies ownership, availability and the single-use binding in
 * the admission transaction before it is written into the Worker -> Host wire.
 * The digest, byte length and media type here are therefore server-resolved
 * facts, never caller-supplied authority.
 */
export const RuntimeReadOnlyTextAttachmentV5Schema = z.strictObject({
	attachmentId: OpaqueIdV1Schema,
	sha256: digest,
	byteLength: z.number().int().nonnegative().max(maximumTextAttachmentBytes),
	mediaType: z.literal("text/plain"),
});
export type RuntimeReadOnlyTextAttachmentV5 = z.infer<
	typeof RuntimeReadOnlyTextAttachmentV5Schema
>;

const orderedTextAttachments = z
	.array(RuntimeReadOnlyTextAttachmentV5Schema)
	.min(1)
	.max(maximumTextAttachments)
	.refine(
		(attachments) =>
			new Set(attachments.map((entry) => entry.attachmentId)).size ===
			attachments.length,
		{ message: "Attachment identifiers must be unique" },
	);

const context = {
	schemaVersion: z.literal(5),
	requestId: RequestIdV1Schema,
	traceId: OpaqueIdV1Schema,
	principal: RuntimePrincipalV1Schema,
	executionSource: RuntimeExecutionSourceV1Schema,
	channelId: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	turnId: OpaqueIdV1Schema,
	sessionGeneration: z.number().int().positive().safe(),
	hostSessionRef: OpaqueIdV1Schema.nullable(),
	operation: RuntimeOperationBindingV2Schema,
	keyBinding: RuntimeRelayKeyBindingV1Schema,
};

/**
 * Authenticated Worker -> RuntimeHost native Skill invocation over V5.
 *
 * V5 reuses the V4 business Grant token and claims. The only new business
 * input is the ordered read-only text attachment set. V5 is Skill-only:
 * commands never accept attachments, and V4 stays exact.
 */
export const RuntimeNativeCapabilityRequestV5Schema = z.strictObject({
	...context,
	hostSessionRef: OpaqueIdV1Schema,
	grant: RuntimeExecutionGrantV4Schema,
	capabilityKind: z.literal("skill"),
	capabilityId: digest,
	directoryRevision: digest,
	parameters: z.string().max(16 * 1024),
	parametersDigest: digest,
	capabilitySourceVersion: z.string().min(1).max(512),
	attachments: orderedTextAttachments,
});
export type RuntimeNativeCapabilityRequestV5 = z.infer<
	typeof RuntimeNativeCapabilityRequestV5Schema
>;

export const RuntimeNativeCapabilityTransportV5Schema = z.strictObject({
	businessRequest: RuntimeNativeCapabilityRequestV5Schema,
	privateKeyField: RuntimePrivateRelayKeyFieldV1Schema,
});
export type RuntimeNativeCapabilityTransportV5 = z.infer<
	typeof RuntimeNativeCapabilityTransportV5Schema
>;

export const RuntimeOperationResponseV5Schema = z.strictObject({
	schemaVersion: z.literal(5),
	hostSessionRef: OpaqueIdV1Schema,
	operationId: OpaqueIdV1Schema,
	result: RuntimeOperationResultV2Schema,
});
export type RuntimeOperationResponseV5 = z.infer<
	typeof RuntimeOperationResponseV5Schema
>;

/** Restore V5 is only for an already accepted Native V5 Skill execution. */
const recoveryBinding = {
	mode: z.literal("existing-accepted-only"),
	acceptedHostSessionRef: OpaqueIdV1Schema,
	acceptedOperationDigest: base64UrlDigest,
	acceptedAttachmentIds: z
		.array(OpaqueIdV1Schema)
		.min(1)
		.max(maximumTextAttachments)
		.refine((ids) => new Set(ids).size === ids.length, {
			message: "Attachment identifiers must be unique",
		}),
};

export const RuntimeExecutionGrantV5Schema = z.strictObject({
	schemaVersion: z.literal(5),
	format: z.literal("runtime-execution-jws"),
	token: RuntimeExecutionGrantV4Schema.shape.token,
});
export type RuntimeExecutionGrantV5 = z.infer<
	typeof RuntimeExecutionGrantV5Schema
>;

export const RuntimeRestoreExecutionKeyRequestV5Schema = z.strictObject({
	schemaVersion: z.literal(5),
	...recoveryBinding,
	grant: RuntimeExecutionGrantV5Schema,
	// The original persisted Native V5 request, including its attachment
	// sequence. A V4 request or an empty-attachment request cannot be restored.
	originalRequest: RuntimeNativeCapabilityRequestV5Schema,
});
export type RuntimeRestoreExecutionKeyRequestV5 = z.infer<
	typeof RuntimeRestoreExecutionKeyRequestV5Schema
>;

// A restore Grant only restores the private Key context. It never grants
// attachment access and never rematerializes a file.
export const RuntimeRestoreExecutionKeyGrantClaimsV5Schema =
	RuntimeBusinessGrantClaimsV4Schema.omit({ eventAccess: true }).extend({
		...recoveryBinding,
		schemaVersion: z.literal(5),
		allowedCommands: z.array(z.literal("execution.key.restore")).length(1),
		attachments: z.array(z.never()).length(0),
	});
export type RuntimeRestoreExecutionKeyGrantClaimsV5 = z.infer<
	typeof RuntimeRestoreExecutionKeyGrantClaimsV5Schema
>;

export const RuntimeRestoreExecutionKeyTransportV5Schema = z.strictObject({
	recoveryRequest: RuntimeRestoreExecutionKeyRequestV5Schema,
	privateKeyField: RuntimePrivateRelayKeyFieldV1Schema,
});
export type RuntimeRestoreExecutionKeyTransportV5 = z.infer<
	typeof RuntimeRestoreExecutionKeyTransportV5Schema
>;

export const RuntimeRestoreExecutionKeyResponseV5Schema = z.strictObject({
	schemaVersion: z.literal(5),
	hostSessionRef: OpaqueIdV1Schema,
	operationId: OpaqueIdV1Schema,
	result: z.literal("restored"),
});
export type RuntimeRestoreExecutionKeyResponseV5 = z.infer<
	typeof RuntimeRestoreExecutionKeyResponseV5Schema
>;

export type RuntimePrivateRelayKeyAcceptanceV5 = {
	readonly request: RuntimeNativeCapabilityRequestV5;
	readonly grantId: string;
	readonly requestDigest: string;
};

function parseNativeRequestV5(
	input: unknown,
): RuntimeNativeCapabilityRequestV5 {
	try {
		return RuntimeNativeCapabilityRequestV5Schema.parse(input);
	} catch {
		throw new TypeError("RuntimeHostV5 request is invalid");
	}
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, entry]) => [key, canonical(entry)]),
		);
	}
	return value;
}

async function sha256Hex(value: string): Promise<string> {
	const digestBytes = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digestBytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/**
 * The signed V5 payload covers every normalized business field and the complete
 * ordered attachment sequence. The Grant token, the independently delivered
 * private Key value and any Key digest are excluded, while the Key purpose,
 * reference and version stay bound through `keyBinding`.
 */
export function runtimeRequestSigningPayloadV5(
	input: RuntimeNativeCapabilityRequestV5,
): string {
	const request = parseNativeRequestV5(input);
	const { grant: _grant, ...payload } = request;
	return JSON.stringify(canonical(payload));
}

export async function runtimeRequestDigestV5(
	input: RuntimeNativeCapabilityRequestV5,
): Promise<string> {
	return sha256Hex(runtimeRequestSigningPayloadV5(input));
}

/**
 * Returns the immutable input used for a V5 operation identity.
 * Recovery stores must reconstruct this object from the accepted Execution;
 * request fences are deliberately excluded because takeover advances them.
 */
export function runtimeOperationDigestInputV5(
	input: RuntimeNativeCapabilityRequestV5,
) {
	const request = parseNativeRequestV5(input);
	const {
		deliveryFence: _deliveryFence,
		executionDeliveryFence: _executionDeliveryFence,
		...operation
	} = request.operation;
	return {
		kind: "native-capability",
		principal: request.principal,
		channelId: request.channelId,
		agentId: request.agentId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		hostSessionRef: request.hostSessionRef,
		operation,
		executionSource: request.executionSource,
		keyBinding: request.keyBinding,
		capabilityId: request.capabilityId,
		capabilityKind: request.capabilityKind,
		directoryRevision: request.directoryRevision,
		parametersDigest: request.parametersDigest,
		capabilitySourceVersion: request.capabilitySourceVersion,
		attachments: request.attachments,
	};
}

/**
 * Validates the V5 business request against the reused V4 business Grant
 * claims. The Grant must list exactly the ordered attachment set of the
 * request with read-only operations.
 */
export async function validateRuntimeBusinessBindingV5(
	request: unknown,
	claims: unknown,
): Promise<void> {
	let parsedRequest: RuntimeNativeCapabilityRequestV5;
	let parsedClaims: z.infer<typeof RuntimeBusinessGrantClaimsV4Schema>;
	try {
		parsedRequest = RuntimeNativeCapabilityRequestV5Schema.parse(request);
		parsedClaims = RuntimeBusinessGrantClaimsV4Schema.parse(claims);
	} catch {
		throw new TypeError("RuntimeHostV5 binding is invalid");
	}
	const expectedPurpose =
		parsedClaims.executionSource === "web" ||
		parsedClaims.executionSource === "wecom"
			? "personal"
			: "agent-default";
	const expectedSubject =
		parsedRequest.keyBinding.purpose === "personal"
			? parsedRequest.principal.kind === "user"
				? parsedRequest.principal.id
				: null
			: parsedRequest.agentId;
	const attachmentIds = parsedRequest.attachments.map(
		(entry) => entry.attachmentId,
	);
	const claimedIds = parsedClaims.attachments.map(
		(entry) => entry.attachmentId,
	);
	if (
		parsedRequest.executionSource !== parsedClaims.executionSource ||
		parsedRequest.keyBinding.purpose !== expectedPurpose ||
		expectedSubject === null ||
		parsedRequest.keyBinding.subjectId !== expectedSubject ||
		parsedClaims.relayKeyBinding.purpose !== parsedRequest.keyBinding.purpose ||
		parsedClaims.relayKeyBinding.subjectId !==
			parsedRequest.keyBinding.subjectId ||
		parsedClaims.relayKeyBinding.ciphertextRef !==
			parsedRequest.keyBinding.ciphertextRef ||
		parsedClaims.relayKeyBinding.version !== parsedRequest.keyBinding.version ||
		parsedClaims.allowedCommands[0] !== "native-capability.invoke" ||
		parsedRequest.operation.kind !== "execution" ||
		parsedRequest.operation.id !== parsedRequest.executionId ||
		parsedRequest.operation.deliveryFence !==
			parsedRequest.operation.executionDeliveryFence ||
		parsedClaims.operation.kind !== parsedRequest.operation.kind ||
		parsedClaims.operation.id !== parsedRequest.operation.id ||
		parsedClaims.operation.deliveryFence !==
			parsedRequest.operation.deliveryFence ||
		parsedClaims.operation.executionDeliveryFence !==
			parsedRequest.operation.executionDeliveryFence ||
		claimedIds.length !== attachmentIds.length ||
		new Set(claimedIds).size !== claimedIds.length ||
		claimedIds.some((id, index) => id !== attachmentIds[index]) ||
		parsedClaims.attachments.some(
			(entry) =>
				entry.operations.length !== 1 || entry.operations[0] !== "read",
		) ||
		parsedRequest.parametersDigest !==
			(await sha256Hex(parsedRequest.parameters)) ||
		parsedClaims.requestDigest !==
			(await runtimeRequestDigestV5(parsedRequest)) ||
		parsedClaims.traceId !== parsedRequest.traceId ||
		parsedClaims.principal.kind !== parsedRequest.principal.kind ||
		parsedClaims.principal.id !== parsedRequest.principal.id ||
		parsedClaims.agentId !== parsedRequest.agentId ||
		parsedClaims.channelId !== parsedRequest.channelId ||
		parsedClaims.conversationId !== parsedRequest.conversationId ||
		parsedClaims.executionId !== parsedRequest.executionId ||
		parsedClaims.turnId !== parsedRequest.turnId ||
		parsedClaims.sessionGeneration !== parsedRequest.sessionGeneration ||
		parsedClaims.hostSessionRef !== parsedRequest.hostSessionRef
	) {
		throw new TypeError("RuntimeHostV5 binding is invalid");
	}
}

/**
 * The private Key field is a separate transport envelope. Its context must
 * match the accepted V5 business request and the Grant digest exactly.
 */
export function validateRuntimePrivateRelayKeyFieldV5(
	field: unknown,
	accepted: RuntimePrivateRelayKeyAcceptanceV5,
): z.infer<typeof RuntimePrivateRelayKeyFieldV1Schema> {
	try {
		const acceptedRequest = parseNativeRequestV5(accepted.request);
		const expectedGrantId = OpaqueIdV1Schema.parse(accepted.grantId);
		const expectedRequestDigest = digest.parse(accepted.requestDigest);
		const parsed = RuntimePrivateRelayKeyFieldV1Schema.parse(field);
		if (
			parsed.context.requestId !== acceptedRequest.requestId ||
			parsed.context.grantId !== expectedGrantId ||
			parsed.context.requestDigest !== expectedRequestDigest ||
			parsed.context.traceId !== acceptedRequest.traceId ||
			parsed.context.principal.kind !== acceptedRequest.principal.kind ||
			parsed.context.principal.id !== acceptedRequest.principal.id ||
			parsed.context.executionSource !== acceptedRequest.executionSource ||
			parsed.context.channelId !== acceptedRequest.channelId ||
			parsed.context.agentId !== acceptedRequest.agentId ||
			parsed.context.conversationId !== acceptedRequest.conversationId ||
			parsed.context.executionId !== acceptedRequest.executionId ||
			parsed.context.turnId !== acceptedRequest.turnId ||
			parsed.context.sessionGeneration !== acceptedRequest.sessionGeneration ||
			parsed.context.hostSessionRef !== acceptedRequest.hostSessionRef ||
			parsed.context.operation.kind !== acceptedRequest.operation.kind ||
			parsed.context.operation.id !== acceptedRequest.operation.id ||
			parsed.context.operation.deliveryFence !==
				acceptedRequest.operation.deliveryFence ||
			parsed.context.operation.executionDeliveryFence !==
				acceptedRequest.operation.executionDeliveryFence ||
			parsed.context.keyBinding.purpose !==
				acceptedRequest.keyBinding.purpose ||
			parsed.context.keyBinding.subjectId !==
				acceptedRequest.keyBinding.subjectId ||
			parsed.context.keyBinding.ciphertextRef !==
				acceptedRequest.keyBinding.ciphertextRef ||
			parsed.context.keyBinding.version !== acceptedRequest.keyBinding.version
		) {
			throw new Error();
		}
		return parsed;
	} catch {
		throw new TypeError("RuntimeHostV5 private Key field is invalid");
	}
}

function restoreBindingClaims(claims: RuntimeRestoreExecutionKeyGrantClaimsV5) {
	const {
		mode: _mode,
		acceptedHostSessionRef: _hostSessionRef,
		acceptedOperationDigest: _operationDigest,
		acceptedAttachmentIds: _attachmentIds,
		...common
	} = claims;
	return {
		...common,
		schemaVersion: 4 as const,
		allowedCommands: ["native-capability.invoke"] as const,
	};
}

export function validateVerifiedRuntimeRestoreExecutionKeyGrantClaimsV5(
	input: unknown,
	context: { expectedIssuer: string; expectedWorkerId: string; now: number },
): RuntimeRestoreExecutionKeyGrantClaimsV5 {
	const claims = RuntimeRestoreExecutionKeyGrantClaimsV5Schema.parse(input);
	validateVerifiedRuntimeExecutionGrantClaimsV4(
		restoreBindingClaims(claims),
		context,
	);
	if (
		claims.operation.kind !== "execution" ||
		claims.operation.id !== claims.executionId
	) {
		throw new TypeError("RuntimeHostV5 Key recovery Grant is invalid");
	}
	return claims;
}

export function runtimeRestoreExecutionKeySigningPayloadV5(input: unknown) {
	const request = RuntimeRestoreExecutionKeyRequestV5Schema.parse(input);
	return JSON.stringify({
		schemaVersion: request.schemaVersion,
		mode: request.mode,
		acceptedHostSessionRef: request.acceptedHostSessionRef,
		acceptedOperationDigest: request.acceptedOperationDigest,
		acceptedAttachmentIds: request.acceptedAttachmentIds,
		// The token is authenticated separately and never enters the signed
		// recovery intent payload.
		originalRequest: JSON.parse(
			runtimeRequestSigningPayloadV5(request.originalRequest),
		),
	});
}

export async function runtimeRestoreExecutionKeyRequestDigestV5(
	input: unknown,
): Promise<string> {
	return sha256Hex(runtimeRestoreExecutionKeySigningPayloadV5(input));
}

/**
 * Validates the signed recovery intent against the original Native V5 request.
 * Generation, fences and the frozen Key reference/version are bound twice:
 * once by the recovery claims and once by the original business binding.
 */
export async function validateRuntimeRestoreExecutionKeyBindingV5(
	input: unknown,
	verifiedClaims: unknown,
): Promise<void> {
	const request = RuntimeRestoreExecutionKeyRequestV5Schema.parse(input);
	const claims =
		RuntimeRestoreExecutionKeyGrantClaimsV5Schema.parse(verifiedClaims);
	const attachmentIds = request.originalRequest.attachments.map(
		(entry) => entry.attachmentId,
	);
	if (
		claims.mode !== request.mode ||
		claims.acceptedHostSessionRef !== request.acceptedHostSessionRef ||
		claims.acceptedOperationDigest !== request.acceptedOperationDigest ||
		claims.acceptedAttachmentIds.length !== attachmentIds.length ||
		claims.acceptedAttachmentIds.some(
			(id, index) => id !== attachmentIds[index],
		) ||
		claims.attachments.length !== 0 ||
		claims.requestDigest !==
			(await runtimeRestoreExecutionKeyRequestDigestV5(request)) ||
		claims.hostSessionRef !== request.originalRequest.hostSessionRef
	) {
		throw new TypeError("RuntimeHostV5 Key recovery binding is invalid");
	}
	await validateRuntimeBusinessBindingV5(request.originalRequest, {
		...restoreBindingClaims(claims),
		requestDigest: await runtimeRequestDigestV5(request.originalRequest),
		attachments: request.originalRequest.attachments.map((entry) => ({
			attachmentId: entry.attachmentId,
			operations: ["read"] as const,
		})),
	});
}

/**
 * The private Key uses the recovery Grant digest, while the rest of its
 * context remains bound to the original accepted V5 request.
 */
export function validateRuntimeRestoreExecutionKeyPrivateFieldV5(
	field: unknown,
	accepted: {
		readonly request: RuntimeRestoreExecutionKeyRequestV5;
		readonly claims: RuntimeRestoreExecutionKeyGrantClaimsV5;
	},
) {
	return validateRuntimePrivateRelayKeyFieldV5(field, {
		request: accepted.request.originalRequest,
		grantId: accepted.claims.grantId,
		requestDigest: accepted.claims.requestDigest,
	});
}
