import { z } from "zod";

import { OpaqueIdV1Schema, RequestIdV1Schema } from "../index.ts";
import {
	type RuntimeBusinessGrantClaimsV2,
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
	channelId: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	turnId: OpaqueIdV1Schema,
	sessionGeneration: z.number().int().positive().safe(),
	hostSessionRef: OpaqueIdV1Schema.nullable(),
	operation: RuntimeOperationBindingV2Schema,
	grant: RuntimeExecutionGrantV2Schema,
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

export function validateRuntimeBusinessBindingV4(
	request: RuntimeBusinessRequestV4,
	claims: RuntimeBusinessGrantClaimsV2,
	requestDigest: string,
): void {
	const command = "selection" in request ? "turn.submit" : "turn.supplement";
	const operationKind = "selection" in request ? "execution" : "message";
	const expectedSubject =
		request.keyBinding.purpose === "personal"
			? request.principal.kind === "user"
				? request.principal.id
				: null
			: request.agentId;
	if (
		expectedSubject === null ||
		request.keyBinding.subjectId !== expectedSubject ||
		claims.allowedCommands[0] !== command ||
		request.operation.kind !== operationKind ||
		claims.requestDigest !== requestDigest ||
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
