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
export const RuntimeRelayKeyDeliveryV1Schema = z.strictObject({
	relayKey: z
		.string()
		.min(16)
		.max(8192)
		.regex(/^[\x20-\x7e]+$/),
});

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
	keyDelivery: RuntimeRelayKeyDeliveryV1Schema,
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
	request: RuntimeBusinessRequestV4,
	claims: RuntimeBusinessGrantClaimsV4,
): Promise<void> {
	const command = "selection" in request ? "turn.submit" : "turn.supplement";
	const operationKind = "selection" in request ? "execution" : "message";
	const expectedPurpose =
		claims.executionSource === "web" || claims.executionSource === "wecom"
			? "personal"
			: "agent-default";
	const expectedSubject =
		request.keyBinding.purpose === "personal"
			? request.principal.kind === "user"
				? request.principal.id
				: null
			: request.agentId;
	const requestedAttachments = new Set(request.input.attachments);
	const claimedAttachments = new Set(
		claims.attachments.map((entry) => entry.attachmentId),
	);
	if (
		request.executionSource !== claims.executionSource ||
		request.keyBinding.purpose !== expectedPurpose ||
		expectedSubject === null ||
		request.keyBinding.subjectId !== expectedSubject ||
		claims.allowedCommands[0] !== command ||
		request.operation.kind !== operationKind ||
		(operationKind === "execution" &&
			(request.operation.id !== request.executionId ||
				request.operation.deliveryFence !==
					request.operation.executionDeliveryFence)) ||
		requestedAttachments.size !== request.input.attachments.length ||
		claimedAttachments.size !== claims.attachments.length ||
		claimedAttachments.size !== requestedAttachments.size ||
		claims.attachments.some(
			(entry) => !requestedAttachments.has(entry.attachmentId),
		) ||
		claims.requestDigest !== (await runtimeRequestDigestV4(request)) ||
		claims.traceId !== request.traceId ||
		claims.principal.kind !== request.principal.kind ||
		claims.principal.id !== request.principal.id ||
		claims.agentId !== request.agentId ||
		claims.channelId !== request.channelId ||
		claims.conversationId !== request.conversationId ||
		claims.executionId !== request.executionId ||
		claims.turnId !== request.turnId ||
		claims.sessionGeneration !== request.sessionGeneration ||
		claims.hostSessionRef !== request.hostSessionRef ||
		claims.operation.kind !== request.operation.kind ||
		claims.operation.id !== request.operation.id ||
		claims.operation.deliveryFence !== request.operation.deliveryFence ||
		claims.operation.executionDeliveryFence !==
			request.operation.executionDeliveryFence
	) {
		throw new TypeError("RuntimeHostV4 binding is invalid");
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
	const { grant: _grant, keyDelivery: _keyDelivery, ...payload } = request;
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
