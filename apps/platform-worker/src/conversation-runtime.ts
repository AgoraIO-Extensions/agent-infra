import type { KeyObject } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
	RuntimeBusinessCommandV2,
	RuntimeBusinessRequestV4,
	RuntimeControlCommandV2,
	RuntimeControlReasonV2,
	RuntimeEventV1,
	RuntimeSubmitTurnRequestV4,
} from "@agent-infra/contracts/runtime";
import {
	RuntimeEventAckRequestV4Schema,
	RuntimeEventReadRequestV4Schema,
	RuntimeRelayKeyDeliveryV1Schema,
} from "@agent-infra/contracts/runtime";
import { resolveCurrentTaskUserV1 } from "@agent-infra/identity";
import {
	type ConversationDispatchAuthorizationPortV1,
	type ConversationDispatchClaimV1,
	type ConversationRuntimeDispatchRequestV1,
	type ConversationRuntimeEventRequestV1,
	ConversationRuntimeHostError,
	type ConversationRuntimeHostPortV1,
	type ConversationRuntimeOperationEventV2,
	type ConversationRuntimeStatusRequestV2,
	createTaskRuntimeAuthorizationUseCaseV1,
	type LegacyTaskControlRecoveryV1,
	type TaskRuntimeAuthorizationContextV1,
	type TaskRuntimeAuthorizationRecordV1,
	type TaskRuntimeRecoveryStateV1,
	type TaskUserDirectoryV1,
	type WorkloadReconciliationStateV1,
} from "@agent-infra/platform-core";
import type { RelayKeyWorkerDecryptorV1 } from "@agent-infra/secret-store/worker";

import { createWorkerRuntimeGrantSignerV2 } from "./runtime-grant-signer.js";
import { createWorkerRuntimeGrantSignerV4 } from "./runtime-grant-signer-v4.js";
import {
	createWorkerRuntimeHostClientV3,
	createWorkerRuntimeHostClientV4,
	RuntimeRelayKeyDeliveryError,
	type WorkerRuntimeHostClientOptionsV4,
} from "./runtime-host-client.js";

function hasKeyedV4Selection(
	claim: ConversationDispatchClaimV1,
): claim is ConversationDispatchClaimV1 & {
	readonly executionSource: NonNullable<
		ConversationDispatchClaimV1["executionSource"]
	>;
	readonly relayKeyBinding: NonNullable<
		ConversationDispatchClaimV1["relayKeyBinding"]
	>;
	readonly modelOptionId: string;
	readonly reasoningLevel: string;
} {
	return Boolean(
		claim.executionSource &&
			claim.relayKeyBinding &&
			claim.modelOptionId &&
			claim.reasoningLevel,
	);
}

export type ConversationRuntimeStateV2 = TaskRuntimeRecoveryStateV1 & {
	/** The Store's immutable submit protocol pin, when supplied by recovery. */
	readonly runtimeSubmitProtocol?: "v2" | "v4";
	/** The immutable Host Session Ref carried by the original V4 submit scope. */
	readonly originalSubmitHostSessionRef?: string | null;
};

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
	}): Promise<{
		readonly controlRecordId: string;
		readonly reason: RuntimeControlReasonV2;
	}>;
}

/** Read-only projection of already verified system migration evidence. */
export type ConversationLegacyControlRecoveryV2 = LegacyTaskControlRecoveryV1;

export interface ConversationLegacyControlStoreV2 {
	readLegacyControlRecovery(
		executionId: string,
	): Promise<ConversationLegacyControlRecoveryV2 | null>;
}

export interface ConversationRuntimeOptionsV2 {
	readonly channelAuthorizationCurrent?: (
		record: TaskRuntimeAuthorizationRecordV1,
		signal: AbortSignal,
	) => Promise<boolean>;
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
			readonly runtimeSubmitProtocol?: "v2" | "v4";
			readonly allowPinnedV2Recovery?: boolean;
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
	readonly executionKeys?: WorkerRuntimeHostClientOptionsV4["executionKeys"];
	readonly relayKeyDecryptor?: RelayKeyWorkerDecryptorV1;
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
	const signV4 = createWorkerRuntimeGrantSignerV4(options.signing);
	function submitExecutionKeys(request: RuntimeSubmitTurnRequestV4) {
		const executionKeys = options.executionKeys;
		if (!executionKeys) unavailable("RELAY_KEY_UNAVAILABLE");
		if (request.hostSessionRef !== null) return executionKeys;
		return {
			readAcceptedExecution: async (request: RuntimeBusinessRequestV4) => {
				const accepted = await executionKeys.readAcceptedExecution(request);
				if (!accepted) return null;
				return {
					scope: { ...accepted.scope, hostSessionRef: null },
					trustedHostSessionRef: null,
				};
			},
			readCiphertext: executionKeys.readCiphertext.bind(executionKeys),
		};
	}
	async function submitKeyedV4(input: {
		readonly target: {
			readonly baseUrl: string;
			readonly serviceToken: string;
		};
		readonly unsigned: RuntimeSubmitTurnRequestV4;
		readonly authorizationRecordId: string;
		readonly assertCurrentAuthorization: () => Promise<void>;
		readonly signal: AbortSignal;
	}) {
		const createClient = (
			executionKeys: NonNullable<ConversationRuntimeOptionsV2["executionKeys"]>,
		) =>
			createWorkerRuntimeHostClientV4({
				...input.target,
				fetch: options.fetch,
				verifyGrant: signV4.verify,
				executionKeys,
				decryptor: options.relayKeyDecryptor as RelayKeyWorkerDecryptorV1,
				assertCurrentAuthorization: input.assertCurrentAuthorization,
			});
		const request = {
			...input.unsigned,
			grant: signV4.sign(input.unsigned, input.authorizationRecordId),
		};
		return createClient(submitExecutionKeys(input.unsigned)).submitTurn(
			request,
			input.signal,
		);
	}
	function submitHostSessionRef(state: ConversationRuntimeStateV2) {
		if (state.originalSubmitHostSessionRef !== undefined)
			return state.originalSubmitHostSessionRef;
		if (
			state.runtimeSubmitProtocol === "v2" ||
			state.runtimeSubmitProtocol === "v4"
		)
			return null;
		return state.hostSessionRef;
	}
	const combined = (signal?: AbortSignal) =>
		signal ? AbortSignal.any([lifetime, signal]) : lifetime;

	const legacyControlStore = options.legacyControlStore;
	const taskAuthorization = createTaskRuntimeAuthorizationUseCaseV1({
		workerId: options.workerId,
		channelAuthorizationCurrent: (record, signal) =>
			options.channelAuthorizationCurrent
				? bounded(options.channelAuthorizationCurrent(record, signal), signal)
				: unavailable("CHANNEL_AUTHORIZATION_UNAVAILABLE"),
		readRuntimeState: (claim, signal) =>
			bounded(
				options.dispatchStore.readRuntimeState({
					claim,
					...(hasKeyedV4Selection(claim)
						? {
								runtimeSubmitProtocol: "v4" as const,
								allowPinnedV2Recovery: true,
							}
						: {}),
				}),
				signal,
			),
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
		if (
			request.requestId !== context.claim.requestId &&
			request.requestId !== context.claim.metadataRecovery?.id
		)
			denied("TASK_AUTHORIZATION_BINDING_INVALID");
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
		recoveryOnly = false,
	) {
		const context = contextFor(request);
		let state: ConversationRuntimeStateV2 = await stateFor(context, signal);
		const beforeRoute = await current(
			context,
			state,
			command,
			signal,
			recoveryOnly,
		);
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
		const afterRoute = await current(
			context,
			state,
			command,
			signal,
			recoveryOnly,
		);
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
		// Recheck the authorization and route immediately before minting any wire grant.
		state = await stateFor(context, signal);
		const finalRoute = await current(
			context,
			state,
			command,
			signal,
			recoveryOnly,
		);
		if (finalRoute.authority.purpose !== authority.purpose) {
			if (finalRoute.authority.purpose === "control")
				await control(context, finalRoute.authority.reason, signal);
			unavailable("RUNTIME_ROUTE_STALE");
		}
		if (
			afterRoute.record.configurationRevision !==
				finalRoute.record.configurationRevision ||
			!isDeepStrictEqual(afterRoute.record.agent, finalRoute.record.agent) ||
			!isDeepStrictEqual(afterRoute.record.workload, finalRoute.record.workload)
		)
			unavailable("RUNTIME_ROUTE_STALE");
		authority = finalRoute.authority;
		const finalTarget = await bounded(
			options.resolveRuntimeHost({
				agentId: context.claim.agentId,
				signal,
				workload: finalRoute.record.workload,
				purpose: finalRoute.authority.purpose,
				command,
			}),
			signal,
		);
		if (finalTarget.workerId !== options.signing.workerId)
			denied("RUNTIME_WORKER_BINDING_INVALID");
		state = await stateFor(context, signal);
		const postTargetRoute = await current(
			context,
			state,
			command,
			signal,
			recoveryOnly,
		);
		if (postTargetRoute.authority.purpose !== finalRoute.authority.purpose) {
			if (postTargetRoute.authority.purpose === "control")
				await control(context, postTargetRoute.authority.reason, signal);
			unavailable("RUNTIME_ROUTE_STALE");
		}
		if (
			postTargetRoute.record.configurationRevision !==
				finalRoute.record.configurationRevision ||
			!isDeepStrictEqual(
				postTargetRoute.record.agent,
				finalRoute.record.agent,
			) ||
			!isDeepStrictEqual(
				postTargetRoute.record.workload,
				finalRoute.record.workload,
			)
		)
			unavailable("RUNTIME_ROUTE_STALE");
		authority = postTargetRoute.authority;
		if (state.stopPending && authority.purpose === "business") {
			await control(context, "stop", signal);
			unavailable("RUNTIME_ROUTE_STALE");
		}
		const postTarget = await bounded(
			options.resolveRuntimeHost({
				agentId: context.claim.agentId,
				signal,
				workload: postTargetRoute.record.workload,
				purpose: postTargetRoute.authority.purpose,
				command,
			}),
			signal,
		);
		if (
			postTarget.workerId !== options.signing.workerId ||
			postTarget.baseUrl !== finalTarget.baseUrl ||
			postTarget.serviceToken !== finalTarget.serviceToken
		)
			unavailable("RUNTIME_ROUTE_STALE");
		state = await stateFor(context, signal);
		const afterTargetRoute = await current(
			context,
			state,
			command,
			signal,
			recoveryOnly,
		);
		if (
			afterTargetRoute.authority.purpose !== postTargetRoute.authority.purpose
		) {
			if (afterTargetRoute.authority.purpose === "control")
				await control(context, afterTargetRoute.authority.reason, signal);
			unavailable("RUNTIME_ROUTE_STALE");
		}
		if (
			afterTargetRoute.record.configurationRevision !==
				postTargetRoute.record.configurationRevision ||
			!isDeepStrictEqual(
				afterTargetRoute.record.agent,
				postTargetRoute.record.agent,
			) ||
			!isDeepStrictEqual(
				afterTargetRoute.record.workload,
				postTargetRoute.record.workload,
			)
		)
			unavailable("RUNTIME_ROUTE_STALE");
		authority = afterTargetRoute.authority;
		const client = createWorkerRuntimeHostClientV3({
			...postTarget,
			fetch: options.fetch,
		});
		const base = {
			schemaVersion: 3 as const,
			requestId: context.claim.metadataRecovery?.id ?? context.claim.requestId,
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
		return {
			context,
			state,
			recoveryOnly,
			authority,
			client,
			base,
			target: postTarget,
			route: afterTargetRoute.record,
		};
	}
	function keyedEvent(
		request: Request,
		command: "events.persist" | "events.ack",
		prepared: Awaited<ReturnType<typeof prepare>>,
		signal: AbortSignal,
	) {
		const { context, state, target, authority } = prepared;
		if (
			!hasKeyedV4Selection(context.claim) ||
			state.runtimeSubmitProtocol !== "v4"
		)
			return null;
		if (
			!state.hostSessionRef ||
			!options.executionKeys ||
			!options.relayKeyDecryptor
		)
			unavailable("RELAY_KEY_UNAVAILABLE");
		return {
			body: {
				...prepared.base,
				schemaVersion: 4 as const,
				hostSessionRef: state.hostSessionRef,
				executionSource: context.claim.executionSource,
				keyBinding: {
					purpose: context.claim.relayKeyBinding.purpose,
					subjectId: context.claim.relayKeyBinding.subjectId,
					ciphertextRef: context.claim.relayKeyBinding.keyId,
					version: context.claim.relayKeyBinding.keyVersion,
				},
				consumer: "platform_worker_persistence" as const,
				grant: {
					schemaVersion: 2 as const,
					format: "runtime-execution-jws" as const,
					token: "a.b.c",
				},
			},
			client: createWorkerRuntimeHostClientV4({
				...target,
				fetch: options.fetch,
				verifyGrant: signV4.verify,
				executionKeys: options.executionKeys,
				decryptor: options.relayKeyDecryptor,
				assertCurrentAuthorization: async () => {
					const current = await prepare(request, command, signal);
					if (
						!isDeepStrictEqual(current.authority, authority) ||
						current.state.runtimeCursor !== state.runtimeCursor ||
						!isDeepStrictEqual(current.route, prepared.route) ||
						!isDeepStrictEqual(current.target, target)
					)
						unavailable("RUNTIME_ROUTE_STALE");
				},
			}),
		};
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
	async function readOriginalControlBinding(
		prepared: Awaited<ReturnType<typeof prepare>>,
		signal: AbortSignal,
	) {
		if (
			prepared.state.hostSessionRef !== null ||
			prepared.authority.purpose !== "control" ||
			!hasKeyedV4Selection(prepared.context.claim) ||
			prepared.state.runtimeSubmitProtocol !== "v4"
		)
			unavailable("RUNTIME_ACCEPTANCE_UNKNOWN");
		const body = {
			...prepared.base,
			hostSessionRef: null,
			originalOperationDigest: prepared.state.originalOperationDigest,
		};
		const result = await prepared.client.readOriginalBinding(
			{
				...body,
				grant: signRequest(body, prepared.authority, "session.status"),
			},
			signal,
		);
		if (result.executionId !== prepared.context.claim.executionId)
			unavailable("RUNTIME_ACCEPTANCE_UNKNOWN");
		const latestState = await stateFor(prepared.context, signal);
		const latestRoute = await current(
			prepared.context,
			latestState,
			"session.status",
			signal,
			prepared.recoveryOnly,
		);
		if (
			!isDeepStrictEqual(latestRoute.authority, prepared.authority) ||
			latestState.originalOperationDigest !==
				prepared.state.originalOperationDigest ||
			(latestState.hostSessionRef !== null &&
				latestState.hostSessionRef !== result.hostSessionRef)
		)
			unavailable("RUNTIME_FENCE_STALE");
		return result;
	}
	async function readRecoveredStatus(
		prepared: Awaited<ReturnType<typeof prepare>>,
		signal: AbortSignal,
	) {
		const { context, state, authority, client, base } = prepared;
		if (
			state.hostSessionRef === null &&
			authority.purpose === "control" &&
			hasKeyedV4Selection(context.claim) &&
			state.runtimeSubmitProtocol === "v4"
		) {
			const binding = await readOriginalControlBinding(prepared, signal);
			return { ...binding, schemaVersion: 2 as const };
		}
		const body = {
			...base,
			hostSessionRef: state.hostSessionRef,
			originalOperationDigest: state.originalOperationDigest,
		};
		const response = await client.recoverStatus(
			{ ...body, grant: signRequest(body, authority, "session.status") },
			signal,
		);
		return { ...response, schemaVersion: 2 as const };
	}
	async function recover(
		request: OriginalStatusRequest | ConversationRuntimeStatusRequestV2,
		signal?: AbortSignal,
	) {
		const active = combined(signal);
		const prepared = await prepare(request, "session.status", active);
		const { context, state, authority, base, target, route } = prepared;
		if (
			state.hostSessionRef === null &&
			authority.purpose === "control" &&
			hasKeyedV4Selection(context.claim) &&
			state.runtimeSubmitProtocol === "v4"
		) {
			return readRecoveredStatus(prepared, active);
		}
		let businessAuthorizationRecordId: string | undefined;
		let businessTarget = target;
		let businessRoute = route;
		if (
			hasKeyedV4Selection(context.claim) &&
			authority.purpose === "business"
		) {
			businessAuthorizationRecordId = authority.authorizationRecordId;
		} else if (
			context.kind === "business" &&
			hasKeyedV4Selection(context.claim) &&
			authority.purpose === "control" &&
			authority.reason === "recovery" &&
			(state.executionStatus === "unknown" ||
				state.executionStatus === "processing") &&
			!state.stopPending
		) {
			const business = await current(
				context,
				await stateFor(context, active),
				"turn.submit",
				active,
			);
			if (business.authority.purpose === "business") {
				businessTarget = await bounded(
					options.resolveRuntimeHost({
						agentId: context.claim.agentId,
						signal: active,
						workload: business.record.workload,
						purpose: "business",
						command: "turn.submit",
					}),
					active,
				);
				if (businessTarget.workerId !== options.signing.workerId)
					denied("RUNTIME_WORKER_BINDING_INVALID");
				const latest = await current(
					context,
					await stateFor(context, active),
					"turn.submit",
					active,
				);
				if (
					latest.authority.purpose !== "business" ||
					latest.authority.authorizationRecordId !==
						business.authority.authorizationRecordId
				)
					denied();
				businessAuthorizationRecordId = latest.authority.authorizationRecordId;
				businessRoute = latest.record;
			}
		}
		if (
			businessAuthorizationRecordId &&
			hasKeyedV4Selection(context.claim) &&
			state.runtimeSubmitProtocol === "v4"
		) {
			if (
				!context.claim.input ||
				!options.executionKeys ||
				!options.relayKeyDecryptor
			)
				unavailable("RELAY_KEY_UNAVAILABLE");
			const assertCurrentAuthorization = async () => {
				const latest = await current(
					context,
					await stateFor(context, active),
					"turn.submit",
					active,
				);
				if (
					latest.authority.purpose !== "business" ||
					latest.authority.authorizationRecordId !==
						businessAuthorizationRecordId
				)
					denied();
				if (
					latest.record.configurationRevision !==
						businessRoute.configurationRevision ||
					!isDeepStrictEqual(latest.record.agent, businessRoute.agent) ||
					!isDeepStrictEqual(latest.record.workload, businessRoute.workload)
				)
					unavailable("RUNTIME_ROUTE_STALE");
			};
			const unsigned = {
				...base,
				schemaVersion: 4 as const,
				hostSessionRef: submitHostSessionRef(state),
				executionSource: context.claim.executionSource,
				keyBinding: {
					purpose: context.claim.relayKeyBinding.purpose,
					subjectId: context.claim.relayKeyBinding.subjectId,
					ciphertextRef: context.claim.relayKeyBinding.keyId,
					version: context.claim.relayKeyBinding.keyVersion,
				},
				input: {
					...context.claim.input,
					attachments: [...context.claim.input.attachments],
				},
				selection: {
					schemaVersion: 1 as const,
					modelOptionId: context.claim.modelOptionId,
					reasoningLevel: context.claim.reasoningLevel,
				},
				grant: {
					schemaVersion: 4 as const,
					format: "runtime-execution-jws" as const,
					token: "a.b.c",
				},
			} satisfies RuntimeBusinessRequestV4;
			let response: Awaited<ReturnType<typeof submitKeyedV4>>;
			try {
				response = await submitKeyedV4({
					target: businessTarget,
					unsigned,
					authorizationRecordId: businessAuthorizationRecordId,
					assertCurrentAuthorization,
					signal: active,
				});
			} catch (error) {
				if (!(error instanceof RuntimeRelayKeyDeliveryError)) throw error;
				const keyless = await prepare(request, "session.status", active, true);
				if (keyless.authority.purpose !== "control") throw error;
				return readRecoveredStatus(keyless, active);
			}
			if (response.result.outcome !== "accepted")
				throw new ConversationRuntimeHostError(
					"RUNTIME_ACCEPTANCE_UNKNOWN",
					true,
				);
			return {
				schemaVersion: 2 as const,
				hostSessionRef: response.hostSessionRef,
				executionId: context.claim.executionId,
				outcome: "found" as const,
				status: response.result.status,
			};
		}
		return readRecoveredStatus(prepared, active);
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
			const assertCurrentAuthorization = async () => {
				const latest = await current(
					context,
					await stateFor(context, active),
					expectedOperation,
					active,
				);
				if (
					authority.purpose !== "business" ||
					latest.authority.purpose !== "business" ||
					latest.authority.authorizationRecordId !==
						authority.authorizationRecordId
				)
					denied();
				if (
					latest.record.configurationRevision !==
						prepared.route.configurationRevision ||
					!isDeepStrictEqual(latest.record.agent, prepared.route.agent) ||
					!isDeepStrictEqual(latest.record.workload, prepared.route.workload)
				)
					unavailable("RUNTIME_ROUTE_STALE");
			};
			if (
				authority.purpose === "control" &&
				request.operation !== "turn.stop"
			) {
				await latch(prepared, active);
				denied();
			}
			if (
				hasKeyedV4Selection(context.claim) &&
				state.runtimeSubmitProtocol === "v2" &&
				request.operation !== "turn.stop"
			)
				unavailable("RUNTIME_ACCEPTANCE_UNKNOWN");
			if (request.operation === "turn.submit") {
				if (!context.claim.input) unavailable("RUNTIME_REQUEST_INVALID");
				if (hasKeyedV4Selection(context.claim)) {
					if (
						authority.purpose !== "business" ||
						!options.executionKeys ||
						!options.relayKeyDecryptor
					)
						unavailable("RELAY_KEY_UNAVAILABLE");
					const unsigned = {
						...base,
						schemaVersion: 4 as const,
						hostSessionRef: submitHostSessionRef(state),
						executionSource: context.claim.executionSource,
						keyBinding: {
							purpose: context.claim.relayKeyBinding.purpose,
							subjectId: context.claim.relayKeyBinding.subjectId,
							ciphertextRef: context.claim.relayKeyBinding.keyId,
							version: context.claim.relayKeyBinding.keyVersion,
						},
						input: {
							...context.claim.input,
							attachments: [...context.claim.input.attachments],
						},
						selection: {
							schemaVersion: 1 as const,
							modelOptionId: context.claim.modelOptionId,
							reasoningLevel: context.claim.reasoningLevel,
						},
						grant: {
							schemaVersion: 4 as const,
							format: "runtime-execution-jws" as const,
							token: "a.b.c",
						},
					} satisfies RuntimeBusinessRequestV4;
					const response = await submitKeyedV4({
						target: prepared.target,
						unsigned,
						authorizationRecordId: authority.authorizationRecordId,
						assertCurrentAuthorization,
						signal: active,
					});
					return { ...response, schemaVersion: 2 as const };
				}
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
			const resolvedHostSessionRef =
				request.operation === "turn.stop" && !state.hostSessionRef
					? (await readOriginalControlBinding(prepared, active)).hostSessionRef
					: state.hostSessionRef;
			if (!resolvedHostSessionRef) unavailable("RUNTIME_ACCEPTANCE_UNKNOWN");
			if (request.operation === "turn.supplement") {
				if (
					!context.claim.input ||
					!context.claim.messageId ||
					request.messageId !== context.claim.messageId
				)
					unavailable("RUNTIME_REQUEST_INVALID");
				if (hasKeyedV4Selection(context.claim)) {
					if (
						authority.purpose !== "business" ||
						!options.executionKeys ||
						!options.relayKeyDecryptor
					)
						unavailable("RELAY_KEY_UNAVAILABLE");
					const unsigned = {
						...base,
						schemaVersion: 4 as const,
						executionSource: context.claim.executionSource,
						keyBinding: {
							purpose: context.claim.relayKeyBinding.purpose,
							subjectId: context.claim.relayKeyBinding.subjectId,
							ciphertextRef: context.claim.relayKeyBinding.keyId,
							version: context.claim.relayKeyBinding.keyVersion,
						},
						hostSessionRef: resolvedHostSessionRef,
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
						grant: {
							schemaVersion: 4 as const,
							format: "runtime-execution-jws" as const,
							token: "a.b.c",
						},
					} satisfies RuntimeBusinessRequestV4;
					const keyedClient = createWorkerRuntimeHostClientV4({
						...prepared.target,
						fetch: options.fetch,
						verifyGrant: signV4.verify,
						executionKeys: options.executionKeys,
						decryptor: options.relayKeyDecryptor,
						assertCurrentAuthorization,
					});
					const response = await keyedClient.supplement(
						{
							...unsigned,
							grant: signV4.sign(unsigned, authority.authorizationRecordId),
						},
						active,
					);
					return { ...response, schemaVersion: 1 as const };
				}
				const body = {
					...base,
					hostSessionRef: resolvedHostSessionRef,
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
				hostSessionRef: resolvedHostSessionRef,
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
			let prepared = await prepare(request, "execution.renew", active);
			if (prepared.authority.purpose === "control") {
				await latch(prepared, active);
				denied();
			}
			if (
				hasKeyedV4Selection(prepared.context.claim) &&
				prepared.state.runtimeSubmitProtocol !== "v2"
			) {
				const key = prepared.context.claim.relayKeyBinding;
				const binding = {
					purpose: key.purpose,
					subjectId: key.subjectId,
					keyId: key.keyId,
					keyVersion: key.keyVersion,
				};
				try {
					if (!options.executionKeys || !options.relayKeyDecryptor)
						throw new RuntimeRelayKeyDeliveryError("RELAY_KEY_UNAVAILABLE");
					const encryptedRecord = await bounded(
						options.executionKeys.readCiphertext(binding),
						active,
					);
					if (!encryptedRecord)
						throw new RuntimeRelayKeyDeliveryError("RELAY_KEY_UNAVAILABLE");
					// Renewal can clear a Host recovery latch while its original Key is
					// still cached. Verify that exact Key without sending or reinstalling it.
					await bounded(
						options.relayKeyDecryptor
							.decrypt({ encryptedRecord, expectedBinding: binding })
							.then((decrypted) => {
								if (decrypted.outcome !== "decrypted")
									throw new RuntimeRelayKeyDeliveryError(decrypted.code);
								try {
									RuntimeRelayKeyDeliveryV1Schema.parse({
										relayKey: new TextDecoder("utf-8", { fatal: true }).decode(
											decrypted.plaintext,
										),
									});
								} finally {
									decrypted.plaintext.fill(0);
								}
							}),
						active,
					);
				} catch (error) {
					if (!(error instanceof RuntimeRelayKeyDeliveryError)) throw error;
					await latch(
						await prepare(request, "session.status", active, true),
						active,
					);
					denied("TASK_AUTHORIZATION_CONTROL_ONLY");
				}
				const checked = await prepare(request, "execution.renew", active);
				if (checked.authority.purpose === "control") {
					await latch(checked, active);
					denied();
				}
				if (
					!isDeepStrictEqual(checked.authority, prepared.authority) ||
					!isDeepStrictEqual(checked.state, prepared.state) ||
					!isDeepStrictEqual(checked.route, prepared.route) ||
					!isDeepStrictEqual(checked.target, prepared.target)
				)
					unavailable("RUNTIME_ROUTE_STALE");
				prepared = checked;
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
			const prepared = await prepare(request, "events.ack", active);
			const { state, authority, client, base } = prepared;
			if (state.runtimeCursor !== request.confirmedCursor) return;
			if (!state.hostSessionRef) unavailable("RUNTIME_ACCEPTANCE_UNKNOWN");
			const keyed = keyedEvent(request, "events.ack", prepared, active);
			if (keyed) {
				const body = RuntimeEventAckRequestV4Schema.parse({
					...keyed.body,
					confirmedCursor: request.confirmedCursor,
				});
				await keyed.client.acknowledgeEvents(
					{ ...body, grant: await signV4.signEvent(body, authority) },
					active,
				);
				return;
			}
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
				const prepared = await prepare(request, "events.persist", active);
				const { state, authority, client, base } = prepared;
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
					const keyed = keyedEvent(request, "events.persist", prepared, active);
					let events:
						| Iterable<RuntimeEventV1 | ConversationRuntimeOperationEventV2>
						| AsyncIterable<
								RuntimeEventV1 | ConversationRuntimeOperationEventV2
						  >;
					if (keyed) {
						const unsigned = RuntimeEventReadRequestV4Schema.parse({
							...keyed.body,
							afterCursor: state.runtimeCursor,
						});
						events = (
							await keyed.client.readEvents(
								{
									...unsigned,
									grant: await signV4.signEvent(unsigned, authority),
								},
								active,
							)
						).events;
					} else {
						events = client.events(
							{
								...body,
								grant: signRequest(body, authority, "events.persist"),
							},
							active,
						);
					}
					for await (const event of events) {
						yield event;
						if (event.type === "completed") terminal = true;
					}
				} catch (error) {
					if (
						!(error instanceof ConversationRuntimeHostError) ||
						(!error.retryable &&
							!(
								authority.purpose === "business" &&
								!terminal &&
								error.code === "RUNTIME_GRANT_INVALID"
							))
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
