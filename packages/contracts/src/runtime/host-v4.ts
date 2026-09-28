import { z } from "zod";

import { OpaqueIdV1Schema, RequestIdV1Schema } from "../index.ts";
import {
	RuntimeBusinessGrantClaimsV2Schema,
	RuntimeExecutionGrantV2Schema,
	RuntimeOperationBindingV2Schema,
	RuntimePrincipalV1Schema,
} from "./grant-v2.ts";
import { RuntimeInputV1Schema, RuntimeSelectionV1Schema } from "./host.ts";

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

export const RuntimePrivateRelayKeyFieldV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	executionId: OpaqueIdV1Schema,
	keyBinding: RuntimeRelayKeyBindingV1Schema,
	keyDelivery: RuntimeRelayKeyDeliveryV1Schema,
});

export type RuntimePrivateRelayKeyFieldV1 = z.infer<
	typeof RuntimePrivateRelayKeyFieldV1Schema
>;

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

export type RuntimeSubmitTurnRequestV4 = z.infer<
	typeof RuntimeSubmitTurnRequestV4Schema
>;
export type RuntimeSupplementRequestV4 = z.infer<
	typeof RuntimeSupplementRequestV4Schema
>;

type RuntimeBusinessRequestV4 =
	| RuntimeSubmitTurnRequestV4
	| RuntimeSupplementRequestV4;

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
	accepted: Pick<RuntimeBusinessRequestV4, "executionId" | "keyBinding">,
): RuntimePrivateRelayKeyFieldV1 {
	try {
		const acceptedExecutionId = OpaqueIdV1Schema.parse(accepted.executionId);
		const acceptedKeyBinding = RuntimeRelayKeyBindingV1Schema.parse(
			accepted.keyBinding,
		);
		const parsed = RuntimePrivateRelayKeyFieldV1Schema.parse(field);
		if (
			parsed.executionId !== acceptedExecutionId ||
			parsed.keyBinding.purpose !== acceptedKeyBinding.purpose ||
			parsed.keyBinding.subjectId !== acceptedKeyBinding.subjectId ||
			parsed.keyBinding.ciphertextRef !== acceptedKeyBinding.ciphertextRef ||
			parsed.keyBinding.version !== acceptedKeyBinding.version
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
