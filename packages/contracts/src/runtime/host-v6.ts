import { z } from "zod";

import { OpaqueIdV1Schema, RequestIdV1Schema } from "../index.ts";
import {
	RuntimeOperationBindingV2Schema,
	RuntimePrincipalV1Schema,
} from "./grant-v2.ts";
import {
	RuntimeOperationResultV2Schema,
	RuntimeSelectionV1Schema,
} from "./host.ts";
import {
	RuntimeBusinessGrantClaimsV4Schema,
	RuntimeExecutionGrantV4Schema,
	RuntimeExecutionSourceV1Schema,
	RuntimePrivateRelayKeyFieldV1Schema,
	RuntimeRelayKeyBindingV1Schema,
} from "./host-v4.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export const RuntimeBusinessGrantClaimsV6Schema =
	RuntimeBusinessGrantClaimsV4Schema.omit({
		schemaVersion: true,
		allowedCommands: true,
		eventAccess: true,
	}).extend({
		schemaVersion: z.literal(6),
		allowedCommands: z.array(z.literal("native-capability.invoke")).length(1),
		attachments: z.array(z.never()).length(0),
	});
export type RuntimeBusinessGrantClaimsV6 = z.infer<
	typeof RuntimeBusinessGrantClaimsV6Schema
>;

export const RuntimeExecutionGrantV6Schema = z.strictObject({
	schemaVersion: z.literal(6),
	format: z.literal("runtime-execution-jws"),
	token: RuntimeExecutionGrantV4Schema.shape.token,
});
export type RuntimeExecutionGrantV6 = z.infer<
	typeof RuntimeExecutionGrantV6Schema
>;

export const VerifiedRuntimeExecutionGrantV6Schema = z.strictObject({
	token: RuntimeExecutionGrantV6Schema.shape.token,
	claims: RuntimeBusinessGrantClaimsV6Schema,
});

const context = {
	schemaVersion: z.literal(6),
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
	hostSessionRef: OpaqueIdV1Schema,
	operation: RuntimeOperationBindingV2Schema,
	grant: RuntimeExecutionGrantV6Schema,
	keyBinding: RuntimeRelayKeyBindingV1Schema,
};

/** Frozen state-changing command admission; V4/V5 remain separate contracts. */
export const RuntimeNativeCapabilityRequestV6Schema = z.strictObject({
	...context,
	capabilityId: digest,
	capabilityKind: z.literal("command"),
	directoryRevision: digest,
	parameters: z.string().max(16 * 1024),
	parametersDigest: digest,
	capabilitySourceVersion: z.string().min(1).max(512),
	selection: RuntimeSelectionV1Schema,
	configVersion: identifier,
});
export type RuntimeNativeCapabilityRequestV6 = z.infer<
	typeof RuntimeNativeCapabilityRequestV6Schema
>;

export const RuntimeNativeCapabilityTransportV6Schema = z
	.strictObject({
		businessRequest: RuntimeNativeCapabilityRequestV6Schema,
		privateKeyField: RuntimePrivateRelayKeyFieldV1Schema,
	})
	.superRefine(({ businessRequest, privateKeyField }, ctx) => {
		const keyContext = privateKeyField.context;
		const fields = [
			"requestId",
			"traceId",
			"channelId",
			"agentId",
			"conversationId",
			"executionId",
			"turnId",
			"sessionGeneration",
			"hostSessionRef",
			"principal",
			"executionSource",
			"operation",
			"keyBinding",
		] as const;
		for (const field of fields) {
			if (
				JSON.stringify(keyContext[field]) !==
				JSON.stringify(businessRequest[field])
			) {
				ctx.addIssue({
					code: "custom",
					path: ["privateKeyField", "context", field],
					message: "Must match businessRequest",
				});
			}
		}
	});
export type RuntimeNativeCapabilityTransportV6 = z.infer<
	typeof RuntimeNativeCapabilityTransportV6Schema
>;

export const RuntimeOperationResponseV6Schema = z.strictObject({
	schemaVersion: z.literal(6),
	hostSessionRef: OpaqueIdV1Schema,
	operationId: OpaqueIdV1Schema,
	result: RuntimeOperationResultV2Schema,
});
export type RuntimeOperationResponseV6 = z.infer<
	typeof RuntimeOperationResponseV6Schema
>;

const recoveryBinding = {
	mode: z.literal("existing-accepted-only"),
	acceptedHostSessionRef: OpaqueIdV1Schema,
	acceptedOperationDigest: digest,
};

export const RuntimeRestoreExecutionKeyRequestV6Schema = z.strictObject({
	schemaVersion: z.literal(6),
	...recoveryBinding,
	grant: RuntimeExecutionGrantV6Schema,
	originalRequest: RuntimeNativeCapabilityRequestV6Schema,
});
export type RuntimeRestoreExecutionKeyRequestV6 = z.infer<
	typeof RuntimeRestoreExecutionKeyRequestV6Schema
>;

export const RuntimeRestoreExecutionKeyGrantClaimsV6Schema =
	RuntimeBusinessGrantClaimsV4Schema.omit({
		schemaVersion: true,
		allowedCommands: true,
		eventAccess: true,
	}).extend({
		schemaVersion: z.literal(6),
		mode: z.literal("existing-accepted-only"),
		acceptedHostSessionRef: OpaqueIdV1Schema,
		acceptedOperationDigest: digest,
		allowedCommands: z.array(z.literal("execution.key.restore")).length(1),
		attachments: z.array(z.never()).length(0),
	});
export type RuntimeRestoreExecutionKeyGrantClaimsV6 = z.infer<
	typeof RuntimeRestoreExecutionKeyGrantClaimsV6Schema
>;

export const RuntimeRestoreExecutionKeyTransportV6Schema = z.strictObject({
	recoveryRequest: RuntimeRestoreExecutionKeyRequestV6Schema,
	privateKeyField: RuntimePrivateRelayKeyFieldV1Schema,
});
export type RuntimeRestoreExecutionKeyTransportV6 = z.infer<
	typeof RuntimeRestoreExecutionKeyTransportV6Schema
>;

export const RuntimeRestoreExecutionKeyResponseV6Schema = z.strictObject({
	schemaVersion: z.literal(6),
	hostSessionRef: OpaqueIdV1Schema,
	operationId: OpaqueIdV1Schema,
	result: z.literal("restored"),
});
export type RuntimeRestoreExecutionKeyResponseV6 = z.infer<
	typeof RuntimeRestoreExecutionKeyResponseV6Schema
>;

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, entry]) => [key, canonical(entry)]),
		);
	}
	return value;
}

/** Signed V6 input excludes the Grant token but includes every frozen fact. */
export function runtimeRequestSigningPayloadV6(
	input: RuntimeNativeCapabilityRequestV6,
): string {
	const request = RuntimeNativeCapabilityRequestV6Schema.parse(input);
	const { grant: _grant, ...payload } = request;
	return JSON.stringify(canonical(payload));
}

export async function runtimeRequestDigestV6(
	input: RuntimeNativeCapabilityRequestV6,
): Promise<string> {
	const digestBytes = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(runtimeRequestSigningPayloadV6(input)),
	);
	return Array.from(new Uint8Array(digestBytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Signature verification and current business authorization remain consumer-owned. */
export function validateVerifiedRuntimeExecutionGrantClaimsV6(
	input: unknown,
	context: { expectedIssuer: string; expectedWorkerId: string; now: number },
) {
	const claims = RuntimeBusinessGrantClaimsV6Schema.parse(input);
	if (
		claims.issuer !== context.expectedIssuer ||
		claims.workerId !== context.expectedWorkerId ||
		!Number.isSafeInteger(context.now) ||
		claims.issuedAt > context.now ||
		claims.expiresAt <= context.now ||
		claims.expiresAt <= claims.issuedAt ||
		claims.expiresAt - claims.issuedAt > 30_000 ||
		claims.operation.kind !== "execution" ||
		claims.operation.id !== claims.executionId ||
		claims.operation.deliveryFence !== claims.operation.executionDeliveryFence
	)
		throw new TypeError("Runtime V6 grant claims are invalid");
	return claims;
}

export async function validateRuntimeBusinessBindingV6(
	input: unknown,
	verification: unknown,
): Promise<void> {
	try {
		const request = RuntimeNativeCapabilityRequestV6Schema.parse(input);
		const claims = RuntimeBusinessGrantClaimsV6Schema.parse(verification);
		const purpose =
			request.executionSource === "web" || request.executionSource === "wecom"
				? "personal"
				: "agent-default";
		const subject =
			purpose === "personal"
				? request.principal.kind === "user"
					? request.principal.id
					: null
				: request.agentId;
		const claimed = {
			principal: claims.principal,
			executionSource: claims.executionSource,
			channelId: claims.channelId,
			agentId: claims.agentId,
			conversationId: claims.conversationId,
			executionId: claims.executionId,
			turnId: claims.turnId,
			sessionGeneration: claims.sessionGeneration,
			hostSessionRef: claims.hostSessionRef,
			traceId: claims.traceId,
			operation: claims.operation,
			keyBinding: claims.relayKeyBinding,
		};
		const requested = Object.fromEntries(
			Object.keys(claimed).map((key) => [
				key,
				request[key as keyof typeof claimed],
			]),
		);
		const parametersHash = await globalThis.crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(request.parameters),
		);
		const parametersDigest = Array.from(
			new Uint8Array(parametersHash),
			(byte) => byte.toString(16).padStart(2, "0"),
		).join("");
		if (
			JSON.stringify(canonical(claimed)) !==
				JSON.stringify(canonical(requested)) ||
			request.keyBinding.purpose !== purpose ||
			subject === null ||
			request.keyBinding.subjectId !== subject ||
			request.operation.kind !== "execution" ||
			request.operation.id !== request.executionId ||
			request.operation.deliveryFence !==
				request.operation.executionDeliveryFence ||
			request.parametersDigest !== parametersDigest ||
			claims.requestDigest !== (await runtimeRequestDigestV6(request))
		)
			throw new Error();
	} catch {
		throw new TypeError("Runtime V6 business binding is invalid");
	}
}

/** Stable accepted-operation identity; grant renewal and fence takeover do not reselect input. */
export function runtimeOperationDigestInputV6(
	input: RuntimeNativeCapabilityRequestV6,
) {
	const request = RuntimeNativeCapabilityRequestV6Schema.parse(input);
	const {
		grant: _grant,
		requestId: _requestId,
		traceId: _traceId,
		operation,
		parameters: _parameters,
		...frozen
	} = request;
	return { ...frozen, operation: { kind: operation.kind, id: operation.id } };
}

export async function runtimeOperationDigestV6(
	input: RuntimeNativeCapabilityRequestV6,
) {
	const bytes = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			JSON.stringify(canonical(runtimeOperationDigestInputV6(input))),
		),
	);
	return Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
