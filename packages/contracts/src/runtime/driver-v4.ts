import { z } from "zod";

import { OpaqueIdV1Schema } from "../index.ts";
import { RuntimePrincipalV1Schema } from "./grant-v2.ts";
import {
	RuntimeExecutionSourceV1Schema,
	RuntimeRelayKeyBindingV1Schema,
} from "./host-v4.ts";

export const RuntimeKeyedHandleScopeV4Schema = z.strictObject({
	principal: RuntimePrincipalV1Schema,
	executionSource: RuntimeExecutionSourceV1Schema,
	channelId: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	sessionGeneration: z.number().int().positive().safe(),
	hostSessionRef: OpaqueIdV1Schema,
	modelOptionId: OpaqueIdV1Schema,
	reasoningLevel: OpaqueIdV1Schema,
	keyBinding: RuntimeRelayKeyBindingV1Schema,
});

export type RuntimeKeyedHandleScopeV4 = z.infer<
	typeof RuntimeKeyedHandleScopeV4Schema
>;

export type RuntimeKeyedHandleTransitionV4 = "start" | "reuse" | "rebuild";

// Call only after the Host verifies the current Execution Grant and operation fence.
export function validateRuntimeKeyedHandleTransitionV4(
	previous: RuntimeKeyedHandleScopeV4 | null,
	next: RuntimeKeyedHandleScopeV4,
	retirement?: {
		readonly stopped: boolean;
		readonly drained: boolean;
		readonly sessionContinued: boolean;
	},
): RuntimeKeyedHandleTransitionV4 {
	const current = RuntimeKeyedHandleScopeV4Schema.parse(next);
	if (previous === null) return "start";
	const former = RuntimeKeyedHandleScopeV4Schema.parse(previous);
	const sameSession =
		former.principal.kind === current.principal.kind &&
		former.principal.id === current.principal.id &&
		former.executionSource === current.executionSource &&
		former.channelId === current.channelId &&
		former.agentId === current.agentId &&
		former.conversationId === current.conversationId &&
		former.sessionGeneration === current.sessionGeneration &&
		former.hostSessionRef === current.hostSessionRef;
	const sameSelectionAndKey =
		former.modelOptionId === current.modelOptionId &&
		former.reasoningLevel === current.reasoningLevel &&
		former.keyBinding.purpose === current.keyBinding.purpose &&
		former.keyBinding.subjectId === current.keyBinding.subjectId &&
		former.keyBinding.ciphertextRef === current.keyBinding.ciphertextRef &&
		former.keyBinding.version === current.keyBinding.version;
	if (
		!sameSession ||
		(former.executionId === current.executionId && !sameSelectionAndKey)
	) {
		throw new TypeError("Runtime keyed handle transition is unproven");
	}
	if (former.executionId === current.executionId) {
		if (
			retirement?.stopped ||
			retirement?.drained ||
			retirement?.sessionContinued === false
		) {
			throw new TypeError("Runtime keyed handle transition is unproven");
		}
		return "reuse";
	}
	if (
		retirement?.stopped !== true ||
		retirement.drained !== true ||
		retirement.sessionContinued !== true
	) {
		throw new TypeError("Runtime keyed handle transition is unproven");
	}
	return "rebuild";
}
