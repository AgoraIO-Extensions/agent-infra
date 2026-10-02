import { createHash } from "node:crypto";
import {
	type RuntimeSubmitTurnRequestV4,
	runtimeOperationDigestInputV4,
} from "@agent-infra/contracts/runtime";
import {
	type ConversationDispatchClaimV1,
	parseTaskAuthorizationBoundaryV1,
} from "@agent-infra/platform-core";
import {
	type DispatchState,
	executionKeyProjection,
	type OutboxRow,
	requireSafeCounter,
	safeCounter,
	type Transaction,
	validText,
} from "./conversation-dispatch-common.js";
import { readMessage } from "./conversation-dispatch-sql.js";
import {
	exactPayload,
	isTurn,
	operation,
} from "./conversation-dispatch-validation.js";

function operationDigest(value: unknown): string {
	function canonical(input: unknown): unknown {
		if (Array.isArray(input)) return input.map(canonical);
		if (!input || typeof input !== "object") return input;
		return Object.fromEntries(
			Object.entries(input)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, entry]) => [key, canonical(entry)]),
		);
	}
	return createHash("sha256")
		.update(JSON.stringify(canonical(value)))
		.digest("base64url");
}

/** Read only original accepted facts; occupied V4 work must already have a pin. */
export async function originalOperationBinding(
	transaction: Transaction,
	state: DispatchState,
	claim: ConversationDispatchClaimV1,
): Promise<{
	runtimeSubmitProtocol: "v2" | "v4";
	originalOperationDigest: string;
	originalSubmitHostSessionRef: string | null;
} | null> {
	const key = executionKeyProjection(state.execution);
	if (
		key.executionSource !== undefined &&
		(key.executionSource !== "web" ||
			state.execution.channel_id !== "web" ||
			state.conversation.channel_id !== "web")
	)
		return null;
	const protocol = state.execution.runtime_submit_protocol;
	const digest = state.execution.original_operation_digest;
	const originalRef = state.execution.original_submit_host_session_ref;
	const base = {
		agentId: state.execution.agent_id,
		conversationId: state.execution.conversation_id,
		executionId: state.execution.execution_id,
		turnId: state.execution.turn_id,
		sessionGeneration: requireSafeCounter(
			state.execution.session_generation,
			1,
		),
	};
	const origins = await transaction<OutboxRow[]>`
	select * from platform.outbox_items where scope_type = 'conversation'
	and scope_id = ${claim.conversationId}
	and id in (${`conversation:turn:${claim.executionId}`}, ${`conversation:regenerate:${claim.executionId}`})
	and operation in ('conversation.turn.submit.v1', 'conversation.turn.regenerate.v1')
`;
	const [origin] = origins;
	if (
		origins.length !== 1 ||
		!origin ||
		!validText(origin.request_id) ||
		!validText(origin.trace_id) ||
		(origin.operation === "conversation.turn.submit.v1"
			? origin.id !== `conversation:turn:${claim.executionId}`
			: origin.id !== `conversation:regenerate:${claim.executionId}`) ||
		(isTurn(claim.operation) && origin.id !== state.outbox.id)
	)
		return null;
	const originOperation = operation(origin.operation);
	if (!originOperation || !isTurn(originOperation)) return null;
	const originalPayload = exactPayload(origin.payload, originOperation);
	if (
		!originalPayload?.messageId ||
		originalPayload.executionId !== claim.executionId ||
		originalPayload.conversationId !== claim.conversationId ||
		originalPayload.turnId !== claim.turnId ||
		originalPayload.sessionGeneration !== claim.sessionGeneration ||
		originalPayload.modelConfigurationRevision !==
			(state.execution.model_configuration_revision === null
				? null
				: safeCounter(state.execution.model_configuration_revision, 1)) ||
		originalPayload.modelOptionId !== state.execution.model_option_id ||
		originalPayload.reasoningLevel !== state.execution.reasoning_level
	)
		return null;
	// Keep origin uniqueness and accepted IDs/selection checks on every read.
	// A persisted pin is authoritative; do not rebuild it from mutable messages/files.
	if (protocol !== null) {
		if (
			(protocol !== "v2" && protocol !== "v4") ||
			!digest ||
			!/^[A-Za-z0-9_-]{43}$/.test(digest) ||
			(originalRef !== null && !validText(originalRef)) ||
			(protocol === "v4"
				? !key.executionSource
				: key.executionSource !== undefined || originalRef !== null)
		)
			return null;
		return {
			runtimeSubmitProtocol: protocol,
			originalOperationDigest: digest,
			originalSubmitHostSessionRef: originalRef,
		};
	}
	if (
		digest !== null ||
		originalRef !== null ||
		(key.executionSource !== undefined &&
			state.execution.status !== "submitted")
	)
		return null;
	const message = await readMessage(
		transaction,
		claim.conversationId,
		originalPayload.messageId,
	);
	if (
		!message ||
		message.actor_id !== state.execution.actor_id ||
		message.role !== "user" ||
		(originOperation === "conversation.turn.submit.v1" &&
			message.execution_id !== state.execution.execution_id)
	)
		return null;
	const inputFiles = await transaction<{ file_id: string }[]>`
		select file_id from platform.files
		where conversation_id = ${claim.conversationId}
			and record->>'messageId' = ${originalPayload.messageId}
			and record->>'kind' = 'attachment'
			and record->>'status' = 'available'
		order by file_id
	`;
	const original = {
		...base,
		kind: "submit-turn",
		input: {
			text: message.text,
			attachments: inputFiles.map((file) => file.file_id),
		},
		...(state.execution.model_option_id && state.execution.reasoning_level
			? {
					selection: {
						schemaVersion: 1 as const,
						modelOptionId: state.execution.model_option_id,
						reasoningLevel: state.execution.reasoning_level,
					},
				}
			: {}),
	};
	if (!key.executionSource || !key.relayKeyBinding) {
		return {
			runtimeSubmitProtocol: "v2" as const,
			originalOperationDigest: operationDigest(original),
			originalSubmitHostSessionRef: null,
		};
	}
	const boundaries = await transaction<{ boundary: unknown }[]>`
		select boundary from platform.task_authorization_records
		where execution_id = ${claim.executionId}
	`;
	if (boundaries.length !== 1) return null;
	const boundary = parseTaskAuthorizationBoundaryV1(boundaries[0]?.boundary);
	if (
		boundary.principal.kind !== "user" ||
		boundary.principal.id !== state.execution.actor_id ||
		boundary.agentId !== state.execution.agent_id ||
		boundary.channelId !== state.execution.channel_id ||
		boundary.agentAuthorizationRevision !==
			state.execution.authorization_revision ||
		!original.selection
	)
		return null;
	const request: RuntimeSubmitTurnRequestV4 = {
		schemaVersion: 4,
		requestId: origin.request_id,
		traceId: origin.trace_id,
		principal: boundary.principal,
		channelId: state.execution.channel_id,
		...base,
		hostSessionRef: state.conversation.host_session_ref,
		operation: {
			kind: "execution",
			id: claim.executionId,
			deliveryFence: claim.executionDeliveryFence,
			executionDeliveryFence: claim.executionDeliveryFence,
		},
		executionSource: key.executionSource,
		keyBinding: {
			purpose: key.relayKeyBinding.purpose,
			subjectId: key.relayKeyBinding.subjectId,
			ciphertextRef: key.relayKeyBinding.keyId,
			version: key.relayKeyBinding.keyVersion,
		},
		input: original.input,
		selection: original.selection,
		// Shape-only marker for the public digest projection, which excludes Grant.
		// It is never verified, signed, returned or sent to a Runtime.
		grant: {
			schemaVersion: 4,
			format: "runtime-execution-jws",
			token: "unsigned.unsigned.unsigned",
		},
	};
	return {
		runtimeSubmitProtocol: "v4" as const,
		originalOperationDigest: operationDigest(
			runtimeOperationDigestInputV4(request),
		),
		originalSubmitHostSessionRef: request.hostSessionRef,
	};
}
