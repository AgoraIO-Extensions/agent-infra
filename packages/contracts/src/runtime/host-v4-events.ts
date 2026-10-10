import { z } from "zod";

import {
	OpaqueCursorV1Schema,
	OpaqueIdV1Schema,
	RequestIdV1Schema,
} from "../index.ts";
import { RuntimeEventSchema } from "./events-v2.ts";
import {
	RuntimeExecutionGrantV2Schema,
	RuntimeOperationBindingV2Schema,
	RuntimePrincipalV1Schema,
	VerifiedRuntimeExecutionGrantV2Schema,
	validateVerifiedRuntimeExecutionGrantClaimsV2,
} from "./grant-v2.ts";
import {
	RuntimeExecutionSourceV1Schema,
	RuntimePinnedExecutionKeyScopeV4Schema,
	RuntimeRelayKeyBindingV1Schema,
} from "./host-v4.ts";
import { canonicalRuntimeRequestSigningPayload } from "./request-signing.ts";

// Event requests retain V2 Grant semantics and never carry the private Key field.
const eventContext = {
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
	hostSessionRef: OpaqueIdV1Schema,
	operation: RuntimeOperationBindingV2Schema,
	grant: RuntimeExecutionGrantV2Schema,
	keyBinding: RuntimeRelayKeyBindingV1Schema,
	consumer: z.literal("platform_worker_persistence"),
};

export const RuntimeEventReadRequestV4Schema = z.strictObject({
	...eventContext,
	afterCursor: OpaqueCursorV1Schema.nullable(),
});

export const RuntimeEventAckRequestV4Schema = z.strictObject({
	...eventContext,
	confirmedCursor: OpaqueCursorV1Schema,
});

export const RuntimeEventReplayResponseV4Schema = z.strictObject({
	schemaVersion: z.literal(4),
	hostSessionRef: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	events: z.array(RuntimeEventSchema),
});

/**
 * Serialized event bytes one V4 replay page may carry: eight full 128 KiB event
 * frames. The Worker bounds a replay response by it plus its envelope.
 */
export const maximumRuntimeEventReplayPageBytesV4 = 8 * 131_072;

export const RuntimeEventAckResponseV4Schema = z.strictObject({
	schemaVersion: z.literal(4),
	executionId: OpaqueIdV1Schema,
	confirmedCursor: OpaqueCursorV1Schema,
});

export type RuntimeEventReadRequestV4 = z.infer<
	typeof RuntimeEventReadRequestV4Schema
>;
export type RuntimeEventAckRequestV4 = z.infer<
	typeof RuntimeEventAckRequestV4Schema
>;
export type RuntimeEventReplayResponseV4 = z.infer<
	typeof RuntimeEventReplayResponseV4Schema
>;
export type RuntimeEventAckResponseV4 = z.infer<
	typeof RuntimeEventAckResponseV4Schema
>;

type EventRequestV4 = RuntimeEventReadRequestV4 | RuntimeEventAckRequestV4;

export async function runtimeEventRequestDigestV4(
	request: EventRequestV4,
): Promise<string> {
	const parsed = z
		.union([RuntimeEventReadRequestV4Schema, RuntimeEventAckRequestV4Schema])
		.parse(request);
	const payload = new TextEncoder().encode(
		canonicalRuntimeRequestSigningPayload({ ...parsed }),
	);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", payload);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

// The caller must cryptographically verify the Grant and supply the trusted
// original accepted Execution and current Host journal Session Ref.
export async function validateRuntimeEventAccessV4(
	request: unknown,
	verification: unknown,
	pinnedExecution: unknown,
	trustedHostSessionRef: unknown,
	context: {
		expectedIssuer: string;
		expectedWorkerId: string;
		now: number;
		trustedOperation: unknown;
	},
): Promise<EventRequestV4> {
	try {
		const parsed = z
			.union([RuntimeEventReadRequestV4Schema, RuntimeEventAckRequestV4Schema])
			.parse(request);
		const verified = VerifiedRuntimeExecutionGrantV2Schema.parse(verification);
		const claims = validateVerifiedRuntimeExecutionGrantClaimsV2(
			verified.claims,
			context,
		);
		const original =
			RuntimePinnedExecutionKeyScopeV4Schema.parse(pinnedExecution);
		const trustedSession = OpaqueIdV1Schema.parse(trustedHostSessionRef);
		const trustedOperation = RuntimeOperationBindingV2Schema.parse(
			context.trustedOperation,
		);
		const command = "afterCursor" in parsed ? "events.persist" : "events.ack";
		const cursorMatches =
			command === "events.persist"
				? claims.eventAccess?.command === "events.persist" &&
					claims.eventAccess.afterCursor ===
						("afterCursor" in parsed ? parsed.afterCursor : undefined)
				: claims.eventAccess?.command === "events.ack" &&
					claims.eventAccess.confirmedCursor ===
						("confirmedCursor" in parsed ? parsed.confirmedCursor : undefined);
		if (
			verified.token !== parsed.grant.token ||
			claims.allowedCommands[0] !== command ||
			!cursorMatches ||
			claims.requestDigest !== (await runtimeEventRequestDigestV4(parsed)) ||
			parsed.hostSessionRef !== trustedSession ||
			(original.hostSessionRef !== null &&
				original.hostSessionRef !== trustedSession) ||
			parsed.principal.kind !== original.principal.kind ||
			parsed.principal.id !== original.principal.id ||
			parsed.executionSource !== original.executionSource ||
			parsed.channelId !== original.channelId ||
			parsed.agentId !== original.agentId ||
			parsed.conversationId !== original.conversationId ||
			parsed.executionId !== original.executionId ||
			parsed.turnId !== original.turnId ||
			parsed.sessionGeneration !== original.sessionGeneration ||
			parsed.keyBinding.purpose !== original.keyBinding.purpose ||
			parsed.keyBinding.subjectId !== original.keyBinding.subjectId ||
			parsed.keyBinding.ciphertextRef !== original.keyBinding.ciphertextRef ||
			parsed.keyBinding.version !== original.keyBinding.version ||
			claims.traceId !== parsed.traceId ||
			claims.principal.kind !== parsed.principal.kind ||
			claims.principal.id !== parsed.principal.id ||
			claims.channelId !== parsed.channelId ||
			claims.agentId !== parsed.agentId ||
			claims.conversationId !== parsed.conversationId ||
			claims.executionId !== parsed.executionId ||
			claims.turnId !== parsed.turnId ||
			claims.sessionGeneration !== parsed.sessionGeneration ||
			claims.hostSessionRef !== parsed.hostSessionRef ||
			claims.operation.kind !== parsed.operation.kind ||
			claims.operation.id !== parsed.operation.id ||
			claims.operation.deliveryFence !== parsed.operation.deliveryFence ||
			claims.operation.executionDeliveryFence !==
				parsed.operation.executionDeliveryFence ||
			trustedOperation.kind !== parsed.operation.kind ||
			trustedOperation.id !== parsed.operation.id ||
			trustedOperation.deliveryFence !== parsed.operation.deliveryFence ||
			trustedOperation.executionDeliveryFence !==
				parsed.operation.executionDeliveryFence
		) {
			throw new Error();
		}
		return parsed;
	} catch {
		throw new TypeError("RuntimeHostV4 event access is invalid");
	}
}

export function validateRuntimeLiveEventV4(
	event: unknown,
	executionId: string,
) {
	try {
		const parsed = RuntimeEventSchema.parse(event);
		if (parsed.executionId !== OpaqueIdV1Schema.parse(executionId))
			throw new Error();
		return parsed;
	} catch {
		throw new TypeError("RuntimeHostV4 event is invalid");
	}
}

export function validateRuntimeReplayResponseV4(
	response: unknown,
	request: RuntimeEventReadRequestV4,
): RuntimeEventReplayResponseV4 {
	try {
		const parsed = RuntimeEventReplayResponseV4Schema.parse(response);
		if (
			parsed.hostSessionRef !== request.hostSessionRef ||
			parsed.executionId !== request.executionId ||
			parsed.events.some((event) => event.executionId !== request.executionId)
		) {
			throw new Error();
		}
		return parsed;
	} catch {
		throw new TypeError("RuntimeHostV4 replay is invalid");
	}
}
