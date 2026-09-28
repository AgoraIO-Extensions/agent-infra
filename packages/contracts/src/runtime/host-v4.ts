import { z } from "zod";

import { OpaqueIdV1Schema, RequestIdV1Schema } from "../index.ts";
import {
	RuntimeBusinessGrantClaimsV2Schema,
	RuntimeExecutionGrantV2Schema,
	RuntimeOperationBindingV2Schema,
	RuntimePrincipalV1Schema,
} from "./grant-v2.ts";
import {
	RuntimeInputV1Schema,
	RuntimeOperationResultV2Schema,
	RuntimeSelectionV1Schema,
} from "./host.ts";

const keyReference = {
	subjectId: OpaqueIdV1Schema,
	ciphertextRef: OpaqueIdV1Schema,
	version: z.number().int().positive().safe(),
};

export const RuntimeRelayKeyBindingV1Schema = z.discriminatedUnion("purpose", [
	z.strictObject({ purpose: z.literal("personal"), ...keyReference }),
	z.strictObject({ purpose: z.literal("agent-default"), ...keyReference }),
]);
export type RuntimeRelayKeyBindingV1 = z.infer<
	typeof RuntimeRelayKeyBindingV1Schema
>;

export const RuntimeExecutionSourceV1Schema = z.enum([
	"web",
	"wecom",
	"platform-api",
	"eval",
]);
export type RuntimeExecutionSourceV1 = z.infer<
	typeof RuntimeExecutionSourceV1Schema
>;

// The source is fixed by task acceptance and signed as part of the V4 Grant.
// A request field alone must not select the Relay Key purpose.
export const RuntimeBusinessGrantClaimsV4Schema =
	RuntimeBusinessGrantClaimsV2Schema.extend({
		schemaVersion: z.literal(4),
		executionSource: RuntimeExecutionSourceV1Schema,
		relayKeyBinding: RuntimeRelayKeyBindingV1Schema,
	});
export type RuntimeBusinessGrantClaimsV4 = z.infer<
	typeof RuntimeBusinessGrantClaimsV4Schema
>;

export const RuntimeExecutionGrantV4Schema = z.strictObject({
	schemaVersion: z.literal(4),
	format: z.literal("runtime-execution-jws"),
	token: RuntimeExecutionGrantV2Schema.shape.token,
});

export const VerifiedRuntimeExecutionGrantV4Schema = z.strictObject({
	token: RuntimeExecutionGrantV4Schema.shape.token,
	claims: RuntimeBusinessGrantClaimsV4Schema,
});

export const RuntimeExecutionGrantMaximumLifetimeMsV4 = 30_000;

// Cryptographic JWS verification remains a RuntimeHost responsibility. This
// helper validates the claims after signature verification and before the
// request binding or Driver side-effect checks.
export function validateVerifiedRuntimeExecutionGrantClaimsV4(
	input: unknown,
	context: { expectedIssuer: string; expectedWorkerId: string; now: number },
): RuntimeBusinessGrantClaimsV4 {
	const claims = RuntimeBusinessGrantClaimsV4Schema.parse(input);
	const command = claims.allowedCommands[0];
	if (
		claims.issuer !== context.expectedIssuer ||
		claims.workerId !== context.expectedWorkerId ||
		!Number.isSafeInteger(context.now) ||
		claims.issuedAt > context.now ||
		claims.expiresAt <= context.now ||
		claims.expiresAt <= claims.issuedAt ||
		claims.expiresAt - claims.issuedAt >
			RuntimeExecutionGrantMaximumLifetimeMsV4 ||
		(command !== "turn.submit" && command !== "turn.supplement") ||
		claims.eventAccess !== undefined ||
		(claims.operation.kind === "execution" &&
			claims.operation.deliveryFence !==
				claims.operation.executionDeliveryFence)
	) {
		throw new Error("Runtime Execution Grant V4 claims are inconsistent");
	}
	return claims;
}

// This field is confined to the authenticated, confidential Worker-Host transport.
// It is deliberately not part of a business request or Grant claims. The
// surrounding private transport must bind it to the same accepted Execution
// and key reference before the Host can expose it to a Driver.
export const RuntimeRelayKeyDeliveryV1Schema = z.strictObject({
	relayKey: z
		.string()
		.min(16)
		.max(8192)
		.regex(/^[\x21-\x7e]+$/),
});

export const RuntimePrivateRelayKeyContextV1Schema = z.strictObject({
	requestId: RequestIdV1Schema,
	grantId: OpaqueIdV1Schema,
	requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
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
});

export const RuntimePrivateRelayKeyFieldV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	context: RuntimePrivateRelayKeyContextV1Schema,
	keyDelivery: RuntimeRelayKeyDeliveryV1Schema,
});

export type RuntimePrivateRelayKeyFieldV1 = z.infer<
	typeof RuntimePrivateRelayKeyFieldV1Schema
>;

export type RuntimePrivateRelayKeyAcceptanceV1 = {
	readonly request: RuntimeBusinessRequestV4;
	readonly grantId: string;
	readonly requestDigest: string;
};

const context = {
	schemaVersion: z.literal(4),
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
	grant: RuntimeExecutionGrantV4Schema,
	keyBinding: RuntimeRelayKeyBindingV1Schema,
};

export const RuntimeSubmitTurnRequestV4Schema = z.strictObject({
	...context,
	input: RuntimeInputV1Schema,
	selection: RuntimeSelectionV1Schema,
});

export const RuntimeSupplementRequestV4Schema = z.strictObject({
	...context,
	hostSessionRef: OpaqueIdV1Schema,
	input: RuntimeInputV1Schema,
});

export const RuntimeSubmitTurnTransportV4Schema = z.strictObject({
	businessRequest: RuntimeSubmitTurnRequestV4Schema,
	privateKeyField: RuntimePrivateRelayKeyFieldV1Schema,
});

export const RuntimeSupplementTransportV4Schema = z.strictObject({
	businessRequest: RuntimeSupplementRequestV4Schema,
	privateKeyField: RuntimePrivateRelayKeyFieldV1Schema,
});

export const RuntimeOperationResponseV4Schema = z.strictObject({
	schemaVersion: z.literal(4),
	hostSessionRef: OpaqueIdV1Schema,
	operationId: OpaqueIdV1Schema,
	result: RuntimeOperationResultV2Schema,
});

export type RuntimeSubmitTurnRequestV4 = z.infer<
	typeof RuntimeSubmitTurnRequestV4Schema
>;
export type RuntimeSupplementRequestV4 = z.infer<
	typeof RuntimeSupplementRequestV4Schema
>;
export type RuntimeSubmitTurnTransportV4 = z.infer<
	typeof RuntimeSubmitTurnTransportV4Schema
>;
export type RuntimeSupplementTransportV4 = z.infer<
	typeof RuntimeSupplementTransportV4Schema
>;
export type RuntimeOperationResponseV4 = z.infer<
	typeof RuntimeOperationResponseV4Schema
>;

export type RuntimeBusinessRequestV4 =
	| RuntimeSubmitTurnRequestV4
	| RuntimeSupplementRequestV4;

export const RuntimePinnedExecutionKeyScopeV4Schema = z.object({
	principal: RuntimePrincipalV1Schema,
	executionSource: RuntimeExecutionSourceV1Schema,
	channelId: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	turnId: OpaqueIdV1Schema,
	sessionGeneration: z.number().int().positive().safe(),
	hostSessionRef: OpaqueIdV1Schema.nullable(),
	keyBinding: RuntimeRelayKeyBindingV1Schema,
});
export type RuntimePinnedExecutionKeyScopeV4 = z.infer<
	typeof RuntimePinnedExecutionKeyScopeV4Schema
>;

// Resolve durable same-operation replays before this pre-Driver check.
// The pinned scope comes from the original accepted Execution, never the new request.
export function validateRuntimePinnedExecutionKeyScopeV4(
	pinned: unknown,
	request: unknown,
	trustedHostSessionRef: unknown,
): void {
	try {
		const original = RuntimePinnedExecutionKeyScopeV4Schema.parse(pinned);
		const next = RuntimePinnedExecutionKeyScopeV4Schema.parse(request);
		const trustedSession = OpaqueIdV1Schema.nullable().parse(
			trustedHostSessionRef,
		);
		const submit =
			request !== null && typeof request === "object" && "selection" in request;
		if (submit) RuntimeSubmitTurnRequestV4Schema.parse(request);
		else RuntimeSupplementRequestV4Schema.parse(request);
		if (
			original.principal.kind !== next.principal.kind ||
			original.principal.id !== next.principal.id ||
			original.executionSource !== next.executionSource ||
			original.channelId !== next.channelId ||
			original.agentId !== next.agentId ||
			original.conversationId !== next.conversationId ||
			original.executionId !== next.executionId ||
			original.turnId !== next.turnId ||
			original.sessionGeneration !== next.sessionGeneration ||
			(submit
				? original.hostSessionRef !== next.hostSessionRef ||
					original.hostSessionRef !== trustedSession
				: next.hostSessionRef !== trustedSession ||
					(original.hostSessionRef !== null &&
						original.hostSessionRef !== next.hostSessionRef)) ||
			original.keyBinding.purpose !== next.keyBinding.purpose ||
			original.keyBinding.subjectId !== next.keyBinding.subjectId ||
			original.keyBinding.ciphertextRef !== next.keyBinding.ciphertextRef ||
			original.keyBinding.version !== next.keyBinding.version
		) {
			throw new Error();
		}
	} catch {
		throw new TypeError("RuntimeHostV4 pinned Execution Key is invalid");
	}
}

export async function validateRuntimeBusinessBindingV4(
	request: unknown,
	claims: unknown,
): Promise<void> {
	let parsedRequest: RuntimeBusinessRequestV4;
	let parsedClaims: RuntimeBusinessGrantClaimsV4;
	try {
		parsedRequest =
			request !== null && typeof request === "object" && "selection" in request
				? RuntimeSubmitTurnRequestV4Schema.parse(request)
				: RuntimeSupplementRequestV4Schema.parse(request);
		parsedClaims = RuntimeBusinessGrantClaimsV4Schema.parse(claims);
	} catch {
		throw new TypeError("RuntimeHostV4 binding is invalid");
	}
	const command =
		"selection" in parsedRequest ? "turn.submit" : "turn.supplement";
	const operationKind = "selection" in parsedRequest ? "execution" : "message";
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
	const requestedAttachments = new Set(parsedRequest.input.attachments);
	const claimedAttachments = new Set(
		parsedClaims.attachments.map((entry) => entry.attachmentId),
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
		parsedClaims.allowedCommands[0] !== command ||
		parsedRequest.operation.kind !== operationKind ||
		(operationKind === "execution" &&
			(parsedRequest.operation.id !== parsedRequest.executionId ||
				parsedRequest.operation.deliveryFence !==
					parsedRequest.operation.executionDeliveryFence)) ||
		requestedAttachments.size !== parsedRequest.input.attachments.length ||
		claimedAttachments.size !== parsedClaims.attachments.length ||
		claimedAttachments.size !== requestedAttachments.size ||
		parsedClaims.attachments.some(
			(entry) => !requestedAttachments.has(entry.attachmentId),
		) ||
		parsedClaims.requestDigest !==
			(await runtimeRequestDigestV4(parsedRequest)) ||
		parsedClaims.traceId !== parsedRequest.traceId ||
		parsedClaims.principal.kind !== parsedRequest.principal.kind ||
		parsedClaims.principal.id !== parsedRequest.principal.id ||
		parsedClaims.agentId !== parsedRequest.agentId ||
		parsedClaims.channelId !== parsedRequest.channelId ||
		parsedClaims.conversationId !== parsedRequest.conversationId ||
		parsedClaims.executionId !== parsedRequest.executionId ||
		parsedClaims.turnId !== parsedRequest.turnId ||
		parsedClaims.sessionGeneration !== parsedRequest.sessionGeneration ||
		parsedClaims.hostSessionRef !== parsedRequest.hostSessionRef ||
		parsedClaims.operation.kind !== parsedRequest.operation.kind ||
		parsedClaims.operation.id !== parsedRequest.operation.id ||
		parsedClaims.operation.deliveryFence !==
			parsedRequest.operation.deliveryFence ||
		parsedClaims.operation.executionDeliveryFence !==
			parsedRequest.operation.executionDeliveryFence
	) {
		throw new TypeError("RuntimeHostV4 binding is invalid");
	}
}

export function validateRuntimePrivateRelayKeyFieldV1(
	field: unknown,
	accepted: RuntimePrivateRelayKeyAcceptanceV1,
): RuntimePrivateRelayKeyFieldV1 {
	try {
		const acceptedRequest =
			"selection" in accepted.request
				? RuntimeSubmitTurnRequestV4Schema.parse(accepted.request)
				: RuntimeSupplementRequestV4Schema.parse(accepted.request);
		const expectedGrantId = OpaqueIdV1Schema.parse(accepted.grantId);
		const expectedRequestDigest = z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.parse(accepted.requestDigest);
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
		throw new TypeError("RuntimeHostV4 private Key field is invalid");
	}
}

export async function runtimeRequestDigestV4(
	request: RuntimeBusinessRequestV4,
): Promise<string> {
	const payload = new TextEncoder().encode(
		runtimeRequestSigningPayloadV4(request),
	);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", payload);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export function runtimeRequestSigningPayloadV4(
	input: RuntimeBusinessRequestV4,
): string {
	let request: RuntimeBusinessRequestV4;
	try {
		request =
			"selection" in input
				? RuntimeSubmitTurnRequestV4Schema.parse(input)
				: RuntimeSupplementRequestV4Schema.parse(input);
	} catch {
		throw new TypeError("RuntimeHostV4 request is invalid");
	}
	const { grant: _grant, ...payload } = request;
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
	return JSON.stringify(canonical(payload));
}
