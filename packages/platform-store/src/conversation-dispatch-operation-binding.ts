import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type RuntimeNativeCapabilityRequestV4,
	type RuntimeNativeCapabilityRequestV5,
	type RuntimeSubmitTurnRequestV4,
	runtimeOperationDigestInputV4,
	runtimeOperationDigestInputV5,
} from "@agent-infra/contracts/runtime";
import {
	type ConversationDispatchClaimV1,
	parseStoredTaskAuthorizationBoundaryV1,
	validateNativeCapabilityReplayPlanV6,
} from "@agent-infra/platform-core";
import {
	type DispatchState,
	executionKeyProjection,
	executionPrincipalProjection,
	type OutboxRow,
	requireSafeCounter,
	safeCounter,
	type Transaction,
	validText,
} from "./conversation-dispatch-common.js";
import {
	readInitialTurnInput,
	readMessage,
} from "./conversation-dispatch-sql.js";
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
) {
	const key = executionKeyProjection(state.execution);
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
	and id in (${`conversation:turn:${claim.executionId}`}, ${`conversation:regenerate:${claim.executionId}`}, ${`conversation:native-capability:${claim.executionId}`})
	and operation in ('conversation.turn.submit.v1', 'conversation.turn.regenerate.v1', 'conversation.native-capability.invoke.v1', 'conversation.native-capability.invoke.v2')
`;
	const [origin] = origins;

	if (
		origins.length === 1 &&
		origin?.operation === "conversation.native-capability.invoke.v2"
	) {
		const payload = exactPayload(origin.payload, origin.operation);
		const native = payload?.nativeCapabilityV6;
		const principal = executionPrincipalProjection(state.execution);
		const pinDigest =
			native && /^[a-f0-9]{64}$/.test(native.operationDigest)
				? Buffer.from(native.operationDigest, "hex").toString("base64url")
				: null;
		if (
			!native ||
			!pinDigest ||
			native.requestId !== origin.request_id ||
			native.traceId !== origin.trace_id ||
			!key.executionSource ||
			!key.relayKeyBinding ||
			native.conversationId !== base.conversationId ||
			native.executionId !== base.executionId ||
			native.turnId !== base.turnId ||
			native.sessionGeneration !== base.sessionGeneration ||
			native.agentId !== base.agentId ||
			native.actorId !== state.execution.actor_id ||
			native.channelId !== state.execution.channel_id ||
			!isDeepStrictEqual(native.principal, principal) ||
			native.authorizationRevision !== state.execution.authorization_revision ||
			native.hostSessionRef !== state.conversation.host_session_ref ||
			native.modelConfigurationRevision !==
				safeCounter(state.execution.model_configuration_revision, 1) ||
			native.modelOptionId !== state.execution.model_option_id ||
			native.reasoningLevel !== state.execution.reasoning_level ||
			native.executionSource !== key.executionSource ||
			!isDeepStrictEqual(native.keyBinding, {
				purpose: key.relayKeyBinding.purpose,
				subjectId: key.relayKeyBinding.subjectId,
				ciphertextRef: key.relayKeyBinding.keyId,
				version: key.relayKeyBinding.keyVersion,
			}) ||
			(claim.operation === origin.operation
				? origin.id !== state.outbox.id ||
					!isDeepStrictEqual(native, claim.nativeCapabilityV6)
				: claim.operation !== "conversation.turn.stop.v1") ||
			(protocol !== null &&
				(protocol !== "v4" ||
					digest !== pinDigest ||
					originalRef !== native.hostSessionRef)) ||
			(protocol === null && (digest !== null || originalRef !== null))
		)
			return null;
		const [authorization] = await transaction<
			{ boundary: unknown }[]
		>`select boundary from platform.task_authorization_records where execution_id = ${claim.executionId}`;
		if (!authorization) return null;
		const boundary = parseStoredTaskAuthorizationBoundaryV1(
			authorization.boundary,
		);
		if (!isDeepStrictEqual(boundary, native.taskBoundary)) return null;
		const { requestId, traceId, idempotencyKey, ...binding } = native;
		try {
			validateNativeCapabilityReplayPlanV6(
				{
					...binding,
					outbox: {
						id: origin.id,
						operation: "conversation.native-capability.invoke.v2",
						payload: native,
					},
				},
				{
					invocation: {
						schemaVersion: 3,
						conversationId: base.conversationId,
						capabilityId: native.capabilityId,
						directoryRevision: native.directoryRevision,
						parameters: native.parameters,
						selection: {
							schemaVersion: 1,
							modelOptionId: native.modelOptionId,
							reasoningLevel: native.reasoningLevel,
						},
						idempotencyKey,
						requestId,
						traceId,
					},
					authority: {
						...base,
						actorId: state.execution.actor_id,
						principal,
						channelId: state.execution.channel_id,
						executionSource: key.executionSource,
						authorizationRevision: state.execution.authorization_revision,
						hostSessionRef: native.hostSessionRef,
					},
					taskAuthority: {
						schemaVersion: 1,
						actorId: state.execution.actor_id,
						agentId: base.agentId,
						channelId: state.execution.channel_id,
						authorizationRevision: state.execution.authorization_revision,
						supportsSupplementaryInstruction: false,
						taskBoundary: boundary,
					},
					requestDigest: native.requestDigest,
				},
			);
		} catch {
			return null;
		}
		// Host stores the same SHA-256 bytes as base64url; the V6 Key receipt uses hex.
		return {
			runtimeSubmitProtocol: "v4" as const,
			originalOperationDigest: pinDigest,
			originalSubmitHostSessionRef: native.hostSessionRef,
		};
	}

	if (
		origins.length === 1 &&
		origin?.operation === "conversation.native-capability.invoke.v1"
	) {
		const payload = exactPayload(origin.payload, origin.operation);
		const native = payload?.nativeCapability;
		if (
			origin.id !== `conversation:native-capability:${claim.executionId}` ||
			!validText(origin.request_id) ||
			!validText(origin.trace_id) ||
			!payload ||
			!native ||
			payload.conversationId !== base.conversationId ||
			payload.executionId !== base.executionId ||
			payload.turnId !== base.turnId ||
			payload.sessionGeneration !== base.sessionGeneration ||
			native.agentId !== base.agentId ||
			native.actorId !== state.execution.actor_id ||
			native.channelId !== state.execution.channel_id ||
			(native.capabilityKind !== "skill" &&
				(state.execution.model_configuration_revision !== null ||
					state.execution.model_option_id !== null ||
					state.execution.reasoning_level !== null)) ||
			new Set([
				state.execution.model_configuration_revision === null,
				state.execution.model_option_id === null,
				state.execution.reasoning_level === null,
			]).size !== 1 ||
			(state.execution.model_configuration_revision !== null &&
				(safeCounter(state.execution.model_configuration_revision, 1) ===
					undefined ||
					!validText(state.execution.model_option_id) ||
					!validText(state.execution.reasoning_level))) ||
			(claim.operation === origin.operation
				? origin.id !== state.outbox.id ||
					!isDeepStrictEqual(native, claim.nativeCapability)
				: claim.operation !== "conversation.turn.stop.v1") ||
			(protocol === null && (digest !== null || originalRef !== null)) ||
			// V2 attachments have no V2/V4 wire shape: dispatch them only through
			// the existing-accepted V4 business Grant + Native V5 protocol.
			(native.attachments !== undefined &&
				(native.capabilityKind !== "skill" ||
					!(key.executionSource && key.relayKeyBinding)))
		)
			return null;
		const identity = {
			...base,
			kind: "native-capability",
			capabilityId: native.capabilityId,
			capabilityKind: native.capabilityKind,
			directoryRevision: native.directoryRevision,
			parametersDigest: native.parametersDigest,
			capabilitySourceVersion: native.capabilitySourceVersion,
		};
		let expectedDigest: string;
		let hostSessionRef: string | null = null;
		if (key.executionSource && key.relayKeyBinding) {
			if (protocol !== null && protocol !== "v4") return null;
			if (protocol === null && state.execution.status !== "submitted")
				return null;
			hostSessionRef =
				protocol === null ? state.conversation.host_session_ref : originalRef;
			if (!validText(hostSessionRef)) return null;
			const boundaries = await transaction<{ boundary: unknown }[]>`
				select boundary from platform.task_authorization_records where execution_id = ${claim.executionId}
			`;
			if (boundaries.length !== 1) return null;
			const boundary = parseStoredTaskAuthorizationBoundaryV1(
				boundaries[0]?.boundary,
			);
			const principal = executionPrincipalProjection(state.execution);
			if (
				!isDeepStrictEqual(boundary.principal, principal) ||
				boundary.agentId !== base.agentId ||
				boundary.channelId !== state.execution.channel_id ||
				boundary.agentAuthorizationRevision !==
					state.execution.authorization_revision
			)
				return null;
			const request:
				| RuntimeNativeCapabilityRequestV4
				| RuntimeNativeCapabilityRequestV5 =
				native.attachments !== undefined
					? {
							schemaVersion: 5,
							requestId: origin.request_id,
							traceId: origin.trace_id,
							...base,
							principal,
							channelId: state.execution.channel_id,
							hostSessionRef,
							operation: {
								kind: "execution",
								id: base.executionId,
								deliveryFence: Math.max(claim.executionDeliveryFence, 1),
								executionDeliveryFence: Math.max(
									claim.executionDeliveryFence,
									1,
								),
							},
							executionSource: key.executionSource,
							keyBinding: {
								purpose: key.relayKeyBinding.purpose,
								subjectId: key.relayKeyBinding.subjectId,
								ciphertextRef: key.relayKeyBinding.keyId,
								version: key.relayKeyBinding.keyVersion,
							},
							capabilityId: native.capabilityId,
							capabilityKind: "skill",
							directoryRevision: native.directoryRevision,
							parameters: native.parameters,
							parametersDigest: native.parametersDigest,
							capabilitySourceVersion: native.capabilitySourceVersion,
							attachments: native.attachments.map((attachment) => ({
								attachmentId: attachment.fileId,
								sha256: attachment.sha256,
								byteLength: attachment.byteLength,
								mediaType: attachment.mediaType,
							})),
							// Shape-only digest projection; this marker is never signed or sent.
							grant: {
								schemaVersion: 4,
								format: "runtime-execution-jws",
								token: "unsigned.unsigned.unsigned",
							},
						}
					: {
							schemaVersion: 4,
							requestId: origin.request_id,
							traceId: origin.trace_id,
							...base,
							principal,
							channelId: state.execution.channel_id,
							hostSessionRef,
							operation: {
								kind: "execution",
								id: base.executionId,
								deliveryFence: Math.max(claim.executionDeliveryFence, 1),
								executionDeliveryFence: Math.max(
									claim.executionDeliveryFence,
									1,
								),
							},
							executionSource: key.executionSource,
							keyBinding: {
								purpose: key.relayKeyBinding.purpose,
								subjectId: key.relayKeyBinding.subjectId,
								ciphertextRef: key.relayKeyBinding.keyId,
								version: key.relayKeyBinding.keyVersion,
							},
							capabilityId: native.capabilityId,
							capabilityKind: native.capabilityKind,
							directoryRevision: native.directoryRevision,
							parameters: native.parameters,
							parametersDigest: native.parametersDigest,
							capabilitySourceVersion: native.capabilitySourceVersion,
							// Shape-only digest projection; this marker is never signed or sent.
							grant: {
								schemaVersion: 4,
								format: "runtime-execution-jws",
								token: "unsigned.unsigned.unsigned",
							},
						};
			expectedDigest = operationDigest(
				native.attachments !== undefined
					? runtimeOperationDigestInputV5(
							request as RuntimeNativeCapabilityRequestV5,
						)
					: runtimeOperationDigestInputV4(
							request as RuntimeNativeCapabilityRequestV4,
						),
			);
		} else {
			if ((protocol !== null && protocol !== "v2") || originalRef !== null)
				return null;
			expectedDigest = operationDigest(identity);
		}
		if (protocol !== null && digest !== expectedDigest) return null;
		return {
			runtimeSubmitProtocol: key.executionSource
				? ("v4" as const)
				: ("v2" as const),
			originalOperationDigest: expectedDigest,
			originalSubmitHostSessionRef: hostSessionRef,
		};
	}
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
			state.execution.status !== "submitted" &&
			state.execution.status !== "waiting")
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
	// #3374：与认领共用初始 Turn 输入的读取，包含合并窗口内并入的消息；重新生成只读源消息。
	const input =
		originOperation === "conversation.turn.submit.v1"
			? await readInitialTurnInput(
					transaction,
					claim.conversationId,
					state.execution.execution_id,
					message,
				)
			: {
					text: message.text,
					attachments: (
						await transaction<{ file_id: string }[]>`
		select file_id from platform.files
		where conversation_id = ${claim.conversationId}
			and record->>'messageId' = ${originalPayload.messageId}
			and record->>'kind' = 'attachment'
			and record->>'status' = 'available'
		order by file_id
	`
					).map((file) => file.file_id),
				};
	const original = {
		...base,
		kind: "submit-turn",
		// 与 Worker 实际发送的 Runtime 输入同形（RuntimeInputV1）：只含附件的消息不带空正文。
		// 否则 V4 摘要投影无法通过契约校验，V2 摘要也与 Host 记录的请求摘要不一致（#3374）。
		input:
			input.text === "" && input.attachments.length > 0
				? { attachments: input.attachments }
				: { text: input.text, attachments: input.attachments },
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
	const boundary = parseStoredTaskAuthorizationBoundaryV1(
		boundaries[0]?.boundary,
	);
	const principal = executionPrincipalProjection(state.execution);
	if (
		boundary.principal.kind !== principal.kind ||
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
			// fence 不进入原操作摘要（runtimeOperationDigestInputV4 会去掉），这里只需满足 V4 形状。
			// 提交从未被认领过的 Execution 上，stop 等非提交认领看到的 fence 仍是 0（#2674）。
			deliveryFence: Math.max(claim.executionDeliveryFence, 1),
			executionDeliveryFence: Math.max(claim.executionDeliveryFence, 1),
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
