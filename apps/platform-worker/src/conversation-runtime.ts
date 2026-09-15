import type { KeyObject } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
	RuntimeBusinessCommandV2,
	RuntimeControlCommandV2,
	RuntimeControlReasonV2,
} from "@agent-infra/contracts/runtime";
import { resolveCurrentTaskUserV1 } from "@agent-infra/identity";
import {
	type ConversationDispatchAuthorizationPortV1,
	type ConversationDispatchClaimV1,
	type ConversationRuntimeDispatchRequestV1,
	type ConversationRuntimeEventRequestV1,
	ConversationRuntimeHostError,
	type ConversationRuntimeHostPortV1,
	type ConversationRuntimeStatusRequestV2,
	createTaskRuntimeAuthorizationUseCaseV1,
	type LegacyTaskControlRecoveryV1,
	type TaskRuntimeAuthorizationContextV1,
	type TaskRuntimeAuthorizationRecordV1,
	type TaskRuntimeRecoveryStateV1,
	type TaskUserDirectoryV1,
	type WorkloadReconciliationStateV1,
} from "@agent-infra/platform-core";

import { createWorkerRuntimeGrantSignerV2 } from "./runtime-grant-signer.js";
import { createWorkerRuntimeHostClientV3 } from "./runtime-host-client.js";

export type ConversationRuntimeStateV2 = TaskRuntimeRecoveryStateV1;

export interface ConversationTaskAuthorizationStoreV2 {
	readExecution(
		executionId: string,
	): Promise<TaskRuntimeAuthorizationRecordV1 | null>;
	recordControl(input: {
		readonly executionId: string;
		readonly authorizationRecordId: string;
		readonly reason: RuntimeControlReasonV2;
		readonly workerId: string;
		readonly traceId: string;
		readonly requestId: string;
	}): Promise<{ readonly controlRecordId: string }>;
}

/** Read-only projection of already verified system migration evidence. */
export type ConversationLegacyControlRecoveryV2 = LegacyTaskControlRecoveryV1;

export interface ConversationLegacyControlStoreV2 {
	readLegacyControlRecovery(
		executionId: string,
	): Promise<ConversationLegacyControlRecoveryV2 | null>;
}

export interface ConversationRuntimeOptionsV2 {
	/** Instance identity owning the PostgreSQL dispatch lease. */
	readonly workerId: string;
	readonly signing: {
		readonly issuer: string;
		/** Identity provisioned with the Runtime transport token and verification key. */
		readonly workerId: string;
		readonly keyId: string;
		readonly privateKey: KeyObject;
		readonly now?: () => number;
	};
	readonly directory: TaskUserDirectoryV1;
	readonly taskAuthorizationStore: ConversationTaskAuthorizationStoreV2;
	readonly legacyControlStore?: ConversationLegacyControlStoreV2;
	readonly dispatchStore: {
		readRuntimeState(input: {
			readonly claim: ConversationDispatchClaimV1;
		}): Promise<ConversationRuntimeStateV2 | null>;
	};
	readonly resolveRuntimeHost: (input: {
		readonly agentId: string;
		readonly signal: AbortSignal;
		readonly workload: WorkloadReconciliationStateV1 | null;
		readonly purpose: "business" | "control";
		readonly command: RuntimeBusinessCommandV2 | RuntimeControlCommandV2;
	}) => Promise<{
		readonly baseUrl: string;
		readonly serviceToken: string;
		readonly workerId: string;
	}>;
	readonly fetch?: typeof fetch;
	readonly reconnectDelayMs?: number;
	readonly signal?: AbortSignal;
}

type Context = TaskRuntimeAuthorizationContextV1;
type OriginalStatusRequest = Omit<
	ConversationRuntimeStatusRequestV2,
	"hostSessionRef" | "recovery"
> & { readonly hostSessionRef: string | null };
type Request =
	| ConversationRuntimeDispatchRequestV1
	| ConversationRuntimeEventRequestV1
	| ConversationRuntimeStatusRequestV2
	| OriginalStatusRequest;
type Command = RuntimeBusinessCommandV2 | RuntimeControlCommandV2;

function unavailable(code = "AUTHORIZATION_UNAVAILABLE"): never {
	throw new ConversationRuntimeHostError(code, true);
}
function denied(code = "AUTHORIZATION_REVOKED"): never {
	throw new ConversationRuntimeHostError(code, true);
}

async function bounded<T>(
	promise: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	let abort: (() => void) | undefined;
	try {
		signal.throwIfAborted();
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				abort = () =>
					reject(new ConversationRuntimeHostError("RUNTIME_INTERRUPTED", true));
				signal.addEventListener("abort", abort, { once: true });
			}),
		]);
	} finally {
		if (abort) signal.removeEventListener("abort", abort);
	}
}

/** Trusted in-process authorization context is never serialized as an Execution Grant. */
export function createConversationRuntimeV2(
	options: ConversationRuntimeOptionsV2,
) {
	if (!options.workerId || !options.signing.workerId)
		throw new TypeError("Conversation Worker identity is invalid");
	const reconnectDelayMs = options.reconnectDelayMs ?? 1000;
	if (
		!Number.isSafeInteger(reconnectDelayMs) ||
		reconnectDelayMs < 1 ||
		reconnectDelayMs > 30_000
	)
		throw new TypeError("Conversation reconnect interval is invalid");
	const contexts = new WeakMap<object, Context>();
	const controller = new AbortController();
	const lifetime = options.signal
		? AbortSignal.any([controller.signal, options.signal])
		: controller.signal;
	const signRequest = createWorkerRuntimeGrantSignerV2(options.signing);
	const combined = (signal?: AbortSignal) =>
		signal ? AbortSignal.any([lifetime, signal]) : lifetime;

	const legacyControlStore = options.legacyControlStore;
	const taskAuthorization = createTaskRuntimeAuthorizationUseCaseV1({
		workerId: options.workerId,
		readRuntimeState: (claim, signal) =>
			bounded(options.dispatchStore.readRuntimeState({ claim }), signal),
		readAuthorization: (executionId, signal) =>
			bounded(
				options.taskAuthorizationStore.readExecution(executionId),
				signal,
			),
		...(legacyControlStore
			? {
					readLegacyRecovery: (executionId: string, signal: AbortSignal) =>
						bounded(
							legacyControlStore.readLegacyControlRecovery(executionId),
							signal,
						),
				}
			: {}),
		resolveCurrentUser: (userId, signal) =>
			bounded(resolveCurrentTaskUserV1(options.directory, userId), signal),
		recordControl: (input, signal) =>
			bounded(options.taskAuthorizationStore.recordControl(input), signal),
	});
	const {
		current,
		recordSystemControl: control,
		readRuntimeState: stateFor,
	} = taskAuthorization;
	function contextFor(request: Request) {
		const reference = request.runtimeGrant;
		if (reference === null || typeof reference !== "object")
			denied("TASK_AUTHORIZATION_CONTEXT_INVALID");
		const context = contexts.get(reference);
		if (!context) denied("TASK_AUTHORIZATION_CONTEXT_INVALID");
		for (const key of [
			"agentId",
			"actorId",
			"channelId",
			"conversationId",
			"executionId",
			"turnId",
			"sessionGeneration",
			"traceId",
		] as const)
			if (request[key] !== context.claim[key])
				denied("TASK_AUTHORIZATION_BINDING_INVALID");
		if (context.claim.leaseOwner !== options.workerId)
			denied("RUNTIME_FENCE_STALE");
		return context;
	}
	async function prepare(
		request: Request,
		command: Command,
		signal: AbortSignal,
	) {
		const context = contextFor(request);
		let state = await stateFor(context, signal);
		const beforeRoute = await current(context, state, command, signal);
		let authority = beforeRoute.authority;
		const target = await bounded(
			options.resolveRuntimeHost({
				agentId: context.claim.agentId,
				signal,
				workload: beforeRoute.record.workload,
				purpose: authority.purpose,
				command,
			}),
			signal,
		);
		if (target.workerId !== options.signing.workerId)
			denied("RUNTIME_WORKER_BINDING_INVALID");
		state = await stateFor(context, signal);
		const afterRoute = await current(context, state, command, signal);
		if (
			beforeRoute.authority.purpose !== afterRoute.authority.purpose ||
			beforeRoute.record.configurationRevision !==
				afterRoute.record.configurationRevision ||
			!isDeepStrictEqual(beforeRoute.record.agent, afterRoute.record.agent) ||
			!isDeepStrictEqual(
				beforeRoute.record.workload,
				afterRoute.record.workload,
			)
		)
			unavailable("RUNTIME_ROUTE_STALE");
		authority = afterRoute.authority;
		// Directory, route and control persistence all cross asynchronous boundaries.
		// Recheck the actual lease after them before minting any wire grant.
		state = await stateFor(context, signal);
		if (state.stopPending && authority.purpose === "business") {
			await control(context, "stop", signal);
			unavailable("RUNTIME_ROUTE_STALE");
		}
		const client = createWorkerRuntimeHostClientV3({
			...target,
			fetch: options.fetch,
		});
		const base = {
			schemaVersion: 3 as const,
			requestId: context.claim.metadataRecovery?.id ?? request.requestId,
			traceId: context.claim.traceId,
			principal: context.principal,
			agentId: context.claim.agentId,
			channelId: context.claim.channelId,
			conversationId: context.claim.conversationId,
			executionId: context.claim.executionId,
			turnId: context.claim.turnId,
			sessionGeneration: context.claim.sessionGeneration,
			hostSessionRef: state.hostSessionRef,
			operation: {
				kind: "execution" as const,
				id: context.claim.executionId,
				deliveryFence: context.claim.executionDeliveryFence,
				executionDeliveryFence: context.claim.executionDeliveryFence,
			},
		};
		return { context, state, authority, client, base };
	}
	async function latch(
		prepared: Awaited<ReturnType<typeof prepare>>,
		signal: AbortSignal,
	) {
		const body = {
			...prepared.base,
			originalOperationDigest: prepared.state.originalOperationDigest,
		};
		await prepared.client.recoverStatus(
			{
				...body,
				grant: signRequest(body, prepared.authority, "session.status"),
			},
			signal,
		);
	}
	async function recover(
		request: OriginalStatusRequest | ConversationRuntimeStatusRequestV2,
		signal?: AbortSignal,
	) {
		const active = combined(signal);
		const { state, authority, client, base } = await prepare(
			request,
			"session.status",
			active,
		);
		const body = {
			...base,
			originalOperationDigest: state.originalOperationDigest,
		};
		const response = await client.recoverStatus(
			{ ...body, grant: signRequest(body, authority, "session.status") },
			active,
		);
		return {
			...response,
			schemaVersion: 2 as const,
		};
	}

	const authorization: ConversationDispatchAuthorizationPortV1 = {
		async authorize(input) {
			try {
				const claim = input.claim;
				const decision = await taskAuthorization.authorizeClaim(
					claim,
					lifetime,
				);
				if (decision.outcome !== "allowed") return decision;
				const { context } = decision;
				const reference = Object.freeze({
					...(context.kind === "business"
						? { authorizationRecordId: context.authorizationRecordId }
						: { migrationRecordId: context.migrationRecordId }),
					principal: context.principal,
				});
				contexts.set(reference, context);
				return {
					outcome: "allowed",
					authority: {
						schemaVersion: 1,
						agentId: claim.agentId,
						actorId: context.principal.id,
						channelId: claim.channelId,
						conversationId: claim.conversationId,
						executionId: claim.executionId,
						turnId: claim.turnId,
						sessionGeneration: claim.sessionGeneration,
						authorizationRevision: claim.authorizationRevision,
						runtimeGrant: reference,
						...(context.kind === "legacy-control" || claim.metadataRecovery
							? { controlOnly: true as const }
							: {}),
					},
				};
			} catch (error) {
				return {
					outcome:
						error instanceof ConversationRuntimeHostError &&
						error.code.startsWith("TASK_AUTHORIZATION_")
							? "denied"
							: "unavailable",
				};
			}
		},
	};
	const runtimeHost: ConversationRuntimeHostPortV1 = {
		async dispatch(request, signal) {
			const active = combined(signal);
			const context = contextFor(request);
			const expectedOperation =
				context.claim.operation === "conversation.turn.stop.v1"
					? "turn.stop"
					: context.claim.operation === "conversation.turn.supplement.v1"
						? "turn.supplement"
						: "turn.submit";
			if (
				request.operation !== expectedOperation ||
				request.deliveryFence !== context.claim.deliveryFence ||
				(request.executionDeliveryFence ??
					context.claim.executionDeliveryFence) !==
					context.claim.executionDeliveryFence
			)
				denied("RUNTIME_FENCE_STALE");
			const prepared = await prepare(request, expectedOperation, active);
			const { state, authority, client, base } = prepared;
			if (
				authority.purpose === "control" &&
				request.operation !== "turn.stop"
			) {
				await latch(prepared, active);
				denied();
			}
			if (request.operation === "turn.submit") {
				if (!context.claim.input) unavailable("RUNTIME_REQUEST_INVALID");
				const body = {
					...base,
					input: {
						...context.claim.input,
						attachments: [...context.claim.input.attachments],
					},
					...(context.claim.modelOptionId && context.claim.reasoningLevel
						? {
								selection: {
									schemaVersion: 1 as const,
									modelOptionId: context.claim.modelOptionId,
									reasoningLevel: context.claim.reasoningLevel,
								},
							}
						: {}),
				};
				const response = await client.submitTurn(
					{ ...body, grant: signRequest(body, authority, "turn.submit") },
					active,
				);
				return { ...response, schemaVersion: body.selection ? 2 : 1 };
			}
			if (!state.hostSessionRef) unavailable("RUNTIME_ACCEPTANCE_UNKNOWN");
			if (request.operation === "turn.supplement") {
				if (
					!context.claim.input ||
					!context.claim.messageId ||
					request.messageId !== context.claim.messageId
				)
					unavailable("RUNTIME_REQUEST_INVALID");
				const body = {
					...base,
					hostSessionRef: state.hostSessionRef,
					operation: {
						kind: "message" as const,
						id: context.claim.messageId,
						deliveryFence: context.claim.deliveryFence,
						executionDeliveryFence: context.claim.executionDeliveryFence,
					},
					input: {
						...context.claim.input,
						attachments: [...context.claim.input.attachments],
					},
				};
				return {
					...(await client.supplement(
						{ ...body, grant: signRequest(body, authority, "turn.supplement") },
						active,
					)),
					schemaVersion: 1,
				};
			}
			if (
				!context.claim.stopRequestId ||
				request.stopRequestId !== context.claim.stopRequestId
			)
				unavailable("RUNTIME_REQUEST_INVALID");
			const body = {
				...base,
				hostSessionRef: state.hostSessionRef,
				operation: {
					kind: "stop" as const,
					id: context.claim.stopRequestId,
					deliveryFence: context.claim.deliveryFence,
					executionDeliveryFence: context.claim.executionDeliveryFence,
				},
			};
			return {
				...(await client.stop(
					{ ...body, grant: signRequest(body, authority, "turn.stop") },
					active,
				)),
				schemaVersion: 1,
			};
		},
		async cancelGeneration(request, signal) {
			const active = combined(signal);
			const { context, state, authority, client, base } = await prepare(
				request,
				"generation.cancel",
				active,
			);
			const isolation = state.generationIsolation;
			if (
				!isolation ||
				!state.hostSessionRef ||
				authority.purpose !== "control" ||
				authority.reason !== "generation_isolation"
			)
				denied("TASK_AUTHORIZATION_CONTROL_ONLY");
			const body = {
				...base,
				hostSessionRef: state.hostSessionRef,
				operation: {
					kind: "generation" as const,
					id: isolation.operationId,
					deliveryFence: context.claim.deliveryFence,
					executionDeliveryFence: context.claim.executionDeliveryFence,
				},
			};
			return {
				...(await client.cancelGeneration(
					{ ...body, grant: signRequest(body, authority, "generation.cancel") },
					active,
				)),
				schemaVersion: 2,
			};
		},
		async *drainGenerationEvents(request, signal) {
			const active = combined(signal);
			const { state, authority, client, base } = await prepare(
				request,
				"events.persist",
				active,
			);
			if (
				!state.generationIsolation ||
				!state.hostSessionRef ||
				authority.purpose !== "control"
			)
				denied("TASK_AUTHORIZATION_CONTROL_ONLY");
			const body = {
				...base,
				hostSessionRef: state.hostSessionRef,
				consumer: "platform_worker_persistence" as const,
				afterCursor: state.runtimeCursor,
			};
			yield* client.events(
				{ ...body, grant: signRequest(body, authority, "events.persist") },
				active,
			);
		},
		recoverOriginalStatus: recover,
		recoverStatus: recover,
		async renewAuthorization(request, signal) {
			const active = combined(signal);
			const prepared = await prepare(request, "execution.renew", active);
			if (prepared.authority.purpose === "control") {
				await latch(prepared, active);
				denied();
			}
			if (!prepared.state.hostSessionRef)
				unavailable("RUNTIME_ACCEPTANCE_UNKNOWN");
			const body = {
				...prepared.base,
				hostSessionRef: prepared.state.hostSessionRef,
			};
			await prepared.client.renewAuthorization(
				{
					...body,
					grant: signRequest(body, prepared.authority, "execution.renew"),
				},
				active,
			);
		},
		async acknowledge(request, signal) {
			const active = combined(signal);
			const { state, authority, client, base } = await prepare(
				request,
				"events.ack",
				active,
			);
			if (state.runtimeCursor !== request.confirmedCursor) return;
			if (!state.hostSessionRef) unavailable("RUNTIME_ACCEPTANCE_UNKNOWN");
			const body = {
				...base,
				hostSessionRef: state.hostSessionRef,
				consumer: "platform_worker_persistence" as const,
				confirmedCursor: request.confirmedCursor,
			};
			await client.acknowledgeEvents(
				{ ...body, grant: signRequest(body, authority, "events.ack") },
				active,
			);
		},
		async *events(request, signal) {
			const active = combined(signal);
			for (;;) {
				active.throwIfAborted();
				const { state, authority, client, base } = await prepare(
					request,
					"events.persist",
					active,
				);
				if (!state.hostSessionRef) unavailable("RUNTIME_ACCEPTANCE_UNKNOWN");
				const body = {
					...base,
					hostSessionRef: state.hostSessionRef,
					consumer: "platform_worker_persistence" as const,
					afterCursor: state.runtimeCursor,
				};
				let terminal = false;
				let streamFailure: ConversationRuntimeHostError | undefined;
				try {
					for await (const event of client.events(
						{ ...body, grant: signRequest(body, authority, "events.persist") },
						active,
					)) {
						yield event;
						if (event.type === "completed") terminal = true;
					}
				} catch (error) {
					if (
						!(error instanceof ConversationRuntimeHostError) ||
						!error.retryable
					)
						throw error;
					streamFailure = error;
				}
				if (authority.purpose === "business" && !terminal) {
					// Stop invalidates the old business stream. Re-enter the existing
					// preparation boundary using the live lease and committed cursor;
					// only that boundary may mint the new control grant.
					const currentState = await stateFor(contextFor(request), active);
					if (
						currentState.stopPending ||
						["completed", "failed", "cancelled"].includes(
							currentState.executionStatus,
						)
					)
						continue;
				}
				if (streamFailure) throw streamFailure;
				if (
					terminal ||
					["completed", "failed", "cancelled"].includes(state.executionStatus)
				)
					return;
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await bounded(
						new Promise<void>((resolve) => {
							timer = setTimeout(resolve, reconnectDelayMs);
						}),
						active,
					);
				} finally {
					clearTimeout(timer);
				}
			}
		},
	};
	return { authorization, runtimeHost, close: () => controller.abort() };
}
