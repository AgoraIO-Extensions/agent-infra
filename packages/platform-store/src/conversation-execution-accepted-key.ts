import { isDeepStrictEqual } from "node:util";

import {
	type RuntimeBusinessRequestV4,
	RuntimeNativeCapabilityRequestV4Schema,
	type RuntimeNativeCapabilityRequestV5,
	RuntimeNativeCapabilityRequestV5Schema,
	type RuntimeNativeCapabilityRequestV6,
	RuntimeNativeCapabilityRequestV6Schema,
	type RuntimePinnedExecutionKeyScopeV4,
	RuntimePinnedExecutionKeyScopeV4Schema,
	type RuntimeSelectionV1,
	RuntimeSelectionV1Schema,
	RuntimeSubmitTurnRequestV4Schema,
	RuntimeSupplementRequestV4Schema,
	runtimeOperationDigestInputV6,
	runtimeOperationDigestV6,
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
	readonly selection?: RuntimeSelectionV1;
	/** The stop was accepted after the submit claim, before key delivery. */
	readonly stopPending?: true;
}

/** The original Store transaction owns all reads; the request only locates the operation. */
export async function readAcceptedExecutionKeyInTransactionV4(
	transaction: Transaction,
	value: RuntimeBusinessRequestV4 | RuntimeNativeCapabilityRequestV5,
): Promise<AcceptedExecutionKeyProjectionV4 | null> {
	const submit = "selection" in value;
	const native = "capabilityId" in value;
	const version5 = native && "attachments" in value;
	const request = submit
		? RuntimeSubmitTurnRequestV4Schema.parse(value)
		: native
			? version5
				? RuntimeNativeCapabilityRequestV5Schema.parse(value)
				: RuntimeNativeCapabilityRequestV4Schema.parse(value)
			: RuntimeSupplementRequestV4Schema.parse(value);
	if (
		request.operation.kind !== (submit || native ? "execution" : "message") ||
		((submit || native) && request.operation.id !== request.executionId)
	)
		return null;
	const candidates = await transaction<{ id: string }[]>`
		select id from platform.outbox_items
		where scope_type = 'conversation' and scope_id = ${request.conversationId}
			and payload->>'executionId' = ${request.executionId}
			and (
				(${submit} and operation in ('conversation.turn.submit.v1', 'conversation.turn.regenerate.v1')
					and id in ('conversation:turn:' || ${request.executionId}, 'conversation:regenerate:' || ${request.executionId}))
			or (${native} and operation = 'conversation.native-capability.invoke.v1'
				and id = 'conversation:native-capability:' || ${request.executionId})
			or (not ${submit} and not ${native} and operation = 'conversation.turn.supplement.v1'
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
	const stopPending =
		(await readStop(transaction, request.executionId))?.status === "submitted";
	if (
		!payload ||
		!bindingMatches(outbox, payload, conversation, execution) ||
		payload.metadataRecovery !== undefined ||
		(!submit && !native && conversation.status !== "active") ||
		!["submitted", "processing", "unknown"].includes(execution.status) ||
		execution.runtime_submit_protocol !== "v4" ||
		outbox.status !== "processing" ||
		outbox.lease_owner === null ||
		outbox.lease_expires_at === null ||
		safeCounter(outbox.delivery_fence, 1) !== request.operation.deliveryFence ||
		safeCounter(execution.delivery_fence, 1) !==
			request.operation.executionDeliveryFence ||
		payload.turnId !== execution.turn_id ||
		(!submit && !native && payload.messageId !== request.operation.id)
	)
		return null;
	const message =
		!native && payload.messageId
			? await readMessage(transaction, conversation.id, payload.messageId)
			: undefined;
	if (
		!native &&
		(!message ||
			message.actor_id !== execution.actor_id ||
			message.role !== "user" ||
			message.status !== "submitted" ||
			(outbox.operation !== "conversation.turn.regenerate.v1" &&
				message.execution_id !== execution.execution_id))
	)
		return null;
	if (
		(!submit && stopPending) ||
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
		// V5 reuses the V4 pinned Key scope. Validate the projection because the
		// pinned-scope helper only parses the V4 native request shape; the ordered
		// attachments stay bound separately by the Host restore validator.
		const keyRequest = version5
			? (({ attachments: _attachments, ...rest }) => ({
					...rest,
					schemaVersion: 4 as const,
				}))(request as RuntimeNativeCapabilityRequestV5)
			: request;
		validateRuntimePinnedExecutionKeyScopeV4(
			scope,
			keyRequest,
			submit ? scope.hostSessionRef : conversation.host_session_ref,
		);
	} catch {
		return null;
	}
	const selection =
		submit || !native
			? RuntimeSelectionV1Schema.parse({
					schemaVersion: 1,
					modelOptionId: execution.model_option_id,
					reasoningLevel: execution.reasoning_level,
				})
			: undefined;
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
		...(stopPending && submit ? { stopPending: true as const } : {}),
	};
}

export type AcceptedExecutionKeyProjectionV6 = Readonly<{
	readonly schemaVersion: 6;
	readonly binding: ReturnType<typeof runtimeOperationDigestInputV6>;
	readonly operationDigest: string;
	readonly deliveryFence: number;
	readonly executionDeliveryFence: number;
	readonly authorizationRecordId: string;
	readonly stopPending: boolean;
	readonly dispatchState: "ready" | "unknown" | "accepted" | "terminal";
}>;

/** Read the accepted V6 native command from the V2 outbox/Execution claim. */
export async function readAcceptedExecutionKeyInTransactionV6(
	transaction: Transaction,
	value: RuntimeNativeCapabilityRequestV6,
): Promise<AcceptedExecutionKeyProjectionV6 | null> {
	const request = RuntimeNativeCapabilityRequestV6Schema.parse(value);
	const [candidate] = await transaction<{ id: string }[]>`
		select id from platform.outbox_items
		where scope_type = 'conversation'
			and scope_id = ${request.conversationId}
			and id = ${`conversation:native-capability:${request.executionId}`}
			and operation = 'conversation.native-capability.invoke.v2'
			and payload->>'executionId' = ${request.executionId}
	`;
	if (!candidate) return null;
	const outbox = await lockOutbox(
		transaction,
		candidate.id,
		request.conversationId,
	);
	const conversation = await lockConversation(
		transaction,
		request.conversationId,
	);
	const execution = await lockExecution(
		transaction,
		request.conversationId,
		request.executionId,
	);
	if (!outbox || !conversation || !execution) return null;
	const parsedOperation = operation(outbox.operation);
	if (parsedOperation !== "conversation.native-capability.invoke.v2")
		return null;
	const payload = exactPayload(outbox.payload, parsedOperation);
	const binding = payload?.nativeCapabilityV6;
	if (
		!payload ||
		!binding ||
		!bindingMatches(outbox, payload, conversation, execution) ||
		payload.executionId !== request.executionId ||
		payload.conversationId !== request.conversationId ||
		binding.operation.id !== request.operation.id ||
		binding.operation.kind !== "execution" ||
		binding.directoryRevision !== request.directoryRevision ||
		binding.capabilityId !== request.capabilityId ||
		binding.parameters !== request.parameters ||
		binding.parametersDigest !== request.parametersDigest ||
		binding.capabilitySourceVersion !== request.capabilitySourceVersion ||
		binding.hostSessionRef !== request.hostSessionRef ||
		outbox.status !== "processing" ||
		outbox.lease_owner === null ||
		outbox.lease_expires_at === null ||
		!["submitted", "processing", "unknown"].includes(execution.status) ||
		safeCounter(outbox.delivery_fence, 1) !== request.operation.deliveryFence ||
		safeCounter(execution.delivery_fence, 1) !==
			request.operation.executionDeliveryFence
	)
		return null;
	const principal = executionPrincipalProjection(execution);
	if (
		!isDeepStrictEqual(principal, request.principal) ||
		execution.agent_id !== request.agentId ||
		execution.actor_id !== request.principal.id ||
		execution.channel_id !== request.channelId ||
		execution.session_generation !== request.sessionGeneration ||
		conversation.host_session_ref !== request.hostSessionRef
	)
		return null;
	const key = executionKeyProjection(execution);
	if (
		!key.executionSource ||
		!key.relayKeyBinding ||
		key.executionSource !== request.executionSource ||
		key.relayKeyBinding.purpose !== request.keyBinding.purpose ||
		key.relayKeyBinding.subjectId !== request.keyBinding.subjectId ||
		key.relayKeyBinding.keyId !== request.keyBinding.ciphertextRef ||
		key.relayKeyBinding.keyVersion !== request.keyBinding.version
	)
		return null;
	const [authorization] = await transaction<
		{ id: string; boundary: unknown; revoked_at: Date | null }[]
	>`
		select id, boundary, revoked_at
		from platform.task_authorization_records
		where execution_id = ${execution.execution_id}
	`;
	if (!authorization || authorization.revoked_at !== null) return null;
	const boundary = parseTaskAuthorizationBoundaryV1(authorization.boundary);
	if (
		!isDeepStrictEqual(boundary.principal, principal) ||
		boundary.agentId !== execution.agent_id ||
		boundary.channelId !== execution.channel_id ||
		boundary.agentAuthorizationRevision !== execution.authorization_revision
	)
		return null;
	const operationDigest = await runtimeOperationDigestV6(request);
	if (operationDigest !== binding.operationDigest) return null;
	const [clock] = await transaction<{ checked_at: Date }[]>`
		select clock_timestamp() as checked_at
	`;
	if (!clock || outbox.lease_expires_at.getTime() <= clock.checked_at.getTime())
		return null;
	const stopPending =
		(await readStop(transaction, request.executionId))?.status === "submitted";
	return {
		schemaVersion: 6,
		binding: runtimeOperationDigestInputV6(request),
		operationDigest,
		deliveryFence: safeCounter(outbox.delivery_fence, 1) ?? 1,
		executionDeliveryFence: safeCounter(execution.delivery_fence, 1) ?? 1,
		authorizationRecordId: authorization.id,
		stopPending,
		dispatchState: "ready",
	};
}
