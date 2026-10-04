import {
	type RuntimeBusinessRequestV4,
	type RuntimePinnedExecutionKeyScopeV4,
	RuntimePinnedExecutionKeyScopeV4Schema,
	type RuntimeSelectionV1,
	RuntimeSelectionV1Schema,
	RuntimeSubmitTurnRequestV4Schema,
	RuntimeSupplementRequestV4Schema,
	validateRuntimePinnedExecutionKeyScopeV4,
} from "@agent-infra/contracts/runtime";
import { parseTaskAuthorizationBoundaryV1 } from "@agent-infra/platform-core";
import {
	executionKeyProjection,
	executionPrincipalProjection,
	safeCounter,
	type Transaction,
} from "./conversation-dispatch-common.js";
import {
	bindingMatches,
	lockConversation,
	lockExecution,
	lockOutbox,
	readGenerationIsolation,
	readMessage,
	readStop,
} from "./conversation-dispatch-sql.js";
import { exactPayload, operation } from "./conversation-dispatch-validation.js";

export interface AcceptedExecutionKeyProjectionV4 {
	readonly scope: RuntimePinnedExecutionKeyScopeV4;
	readonly trustedHostSessionRef: string | null;
	readonly authorizationRecordId: string;
	readonly selection: RuntimeSelectionV1;
}

/** The original Store transaction owns all reads; the request only locates the operation. */
export async function readAcceptedExecutionKeyInTransactionV4(
	transaction: Transaction,
	value: RuntimeBusinessRequestV4,
): Promise<AcceptedExecutionKeyProjectionV4 | null> {
	const submit = "selection" in value;
	const request = submit
		? RuntimeSubmitTurnRequestV4Schema.parse(value)
		: RuntimeSupplementRequestV4Schema.parse(value);
	if (
		request.operation.kind !== (submit ? "execution" : "message") ||
		(submit && request.operation.id !== request.executionId)
	)
		return null;
	const candidates = await transaction<{ id: string }[]>`
		select id from platform.outbox_items
		where scope_type = 'conversation' and scope_id = ${request.conversationId}
			and payload->>'executionId' = ${request.executionId}
			and (
				(${submit} and operation in ('conversation.turn.submit.v1', 'conversation.turn.regenerate.v1')
					and id in ('conversation:turn:' || ${request.executionId}, 'conversation:regenerate:' || ${request.executionId}))
				or (not ${submit} and operation = 'conversation.turn.supplement.v1'
					and id = 'conversation:supplement:' || ${request.operation.id}
					and payload->>'messageId' = ${request.operation.id})
			)
	`;
	if (candidates.length !== 1 || !candidates[0]) return null;
	// Reuse the original dispatch lock order and row projections.
	const outbox = await lockOutbox(
		transaction,
		candidates[0].id,
		request.conversationId,
	);
	if (!outbox) return null;
	const conversation = await lockConversation(
		transaction,
		request.conversationId,
	);
	const execution = await lockExecution(
		transaction,
		request.conversationId,
		request.executionId,
	);
	if (!conversation || !execution) return null;
	const parsedOperation = operation(outbox.operation);
	if (!parsedOperation) return null;
	const payload = exactPayload(outbox.payload, parsedOperation);
	if (
		!payload ||
		!bindingMatches(outbox, payload, conversation, execution) ||
		payload.metadataRecovery !== undefined ||
		(!submit && conversation.status !== "active") ||
		!["submitted", "processing", "unknown"].includes(execution.status) ||
		execution.runtime_submit_protocol !== "v4" ||
		outbox.status !== "processing" ||
		outbox.lease_owner === null ||
		outbox.lease_expires_at === null ||
		safeCounter(outbox.delivery_fence, 1) !== request.operation.deliveryFence ||
		safeCounter(execution.delivery_fence, 1) !==
			request.operation.executionDeliveryFence ||
		payload.turnId !== execution.turn_id ||
		(!submit && payload.messageId !== request.operation.id)
	)
		return null;
	const message = payload.messageId
		? await readMessage(transaction, conversation.id, payload.messageId)
		: undefined;
	if (
		!message ||
		message.actor_id !== execution.actor_id ||
		message.role !== "user" ||
		message.status !== "submitted" ||
		(outbox.operation !== "conversation.turn.regenerate.v1" &&
			message.execution_id !== execution.execution_id)
	)
		return null;
	if (
		(await readStop(transaction, execution.execution_id))?.status ===
			"submitted" ||
		(await readGenerationIsolation(
			transaction,
			conversation.id,
			request.sessionGeneration,
		))
	)
		return null;
	const [authorization] = await transaction<
		{
			id: string;
			boundary: unknown;
			revoked_at: Date | null;
		}[]
	>`
		select id, boundary, revoked_at from platform.task_authorization_records
		where execution_id = ${execution.execution_id}
	`;
	if (!authorization || authorization.revoked_at !== null) return null;
	const boundary = parseTaskAuthorizationBoundaryV1(authorization.boundary);
	const principal = executionPrincipalProjection(execution);
	if (
		boundary.principal.kind !== principal.kind ||
		boundary.principal.id !== principal.id ||
		boundary.agentId !== execution.agent_id ||
		boundary.channelId !== execution.channel_id ||
		boundary.agentAuthorizationRevision !== execution.authorization_revision
	)
		return null;
	const key = executionKeyProjection(execution);
	if (!key.executionSource || !key.relayKeyBinding) return null;
	const scope = RuntimePinnedExecutionKeyScopeV4Schema.parse({
		principal,
		executionSource: key.executionSource,
		channelId: execution.channel_id,
		agentId: execution.agent_id,
		conversationId: execution.conversation_id,
		executionId: execution.execution_id,
		turnId: execution.turn_id,
		sessionGeneration: safeCounter(execution.session_generation, 1),
		hostSessionRef: execution.original_submit_host_session_ref,
		keyBinding: {
			purpose: key.relayKeyBinding.purpose,
			subjectId: key.relayKeyBinding.subjectId,
			ciphertextRef: key.relayKeyBinding.keyId,
			version: key.relayKeyBinding.keyVersion,
		},
	});
	try {
		validateRuntimePinnedExecutionKeyScopeV4(
			scope,
			request,
			conversation.host_session_ref,
		);
	} catch {
		return null;
	}
	const selection = RuntimeSelectionV1Schema.parse({
		schemaVersion: 1,
		modelOptionId: execution.model_option_id,
		reasoningLevel: execution.reasoning_level,
	});
	const [clock] = await transaction<{ checked_at: Date }[]>`
		select clock_timestamp() as checked_at
	`;
	if (!clock || outbox.lease_expires_at.getTime() <= clock.checked_at.getTime())
		return null;
	return {
		scope,
		trustedHostSessionRef: conversation.host_session_ref,
		authorizationRecordId: authorization.id,
		selection,
	};
}
