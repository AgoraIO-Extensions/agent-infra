import type { KeyObject } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ApprovedConnectionConsumerTargetV1 } from "@agent-infra/contracts/connection-consumer-profile";

import type {
	RuntimeBusinessCommandV2,
	RuntimeBusinessRequestV4,
	RuntimeControlCommandV2,
	RuntimeControlReasonV2,
	RuntimeEventAckRequestV4,
	RuntimeEventReadRequestV4,
} from "@agent-infra/contracts/runtime";
import {
	RuntimeEventAckRequestV4Schema,
	RuntimeEventReadRequestV4Schema,
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
	type CurrentTaskApiUseGrantV1,
	type CurrentTaskApplicationV1,
	createTaskRuntimeAuthorizationUseCaseV1,
	type LegacyTaskControlRecoveryV1,
	type SessionSandboxRuntimeStateV1,
	type TaskPrincipalV1,
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
	type WorkerExecutionKeyReaderV4,
} from "./runtime-host-client.js";

export type ConversationRuntimeStateV2 = TaskRuntimeRecoveryStateV1 & {
	/** Immutable Store pin; absent on historical, Key-free control recovery. */
	readonly runtimeSubmitProtocol?: string;
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
	readonly resolveCurrentApplication?: (
		applicationId: string,
		agentId: string,
		signal: AbortSignal,
	) => Promise<CurrentTaskApplicationV1 | null>;
	readonly resolveCurrentApiUseGrant?: (
		principal: TaskPrincipalV1,
		agentId: string,
		signal: AbortSignal,
	) => Promise<CurrentTaskApiUseGrantV1 | null>;
	readonly taskAuthorizationStore: ConversationTaskAuthorizationStoreV2;
	readonly legacyControlStore?: ConversationLegacyControlStoreV2;
	readonly dispatchStore: {
		readRuntimeState(input: {
			readonly claim: ConversationDispatchClaimV1;
		}): Promise<ConversationRuntimeStateV2 | null>;
	};
	readonly resolveRuntimeHost: (input: {
		readonly agentId: string;
		readonly conversationId?: string;
		readonly actorId?: string;
		readonly channelId?: string;
		readonly principal?: TaskPrincipalV1;
		readonly sessionGeneration?: number;
		readonly deliveryFence?: number;
		readonly signal: AbortSignal;
		readonly workload: WorkloadReconciliationStateV1 | null;
		readonly sandboxResource?: SessionSandboxRuntimeStateV1 | null;
		readonly purpose: "business" | "control";
		readonly command: RuntimeBusinessCommandV2 | RuntimeControlCommandV2;
	}) => Promise<{
		readonly baseUrl: string;
		readonly serviceToken: string;
		readonly workerId: string;
		readonly connectionConsumer?: ApprovedConnectionConsumerTargetV1;
	}>;
	readonly executionKeys?: WorkerExecutionKeyReaderV4;
	readonly relayKeyDecryptor?: RelayKeyWorkerDecryptorV1;
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
	const signV4 = createWorkerRuntimeGrantSignerV4(options.signing);
	const combined = (signal?: AbortSignal) =>
		signal ? AbortSignal.any([lifetime, signal]) : lifetime;

	const keyDependencies = new Set<Promise<unknown>>();
	function trackKeyDependency<T>(work: () => Promise<T>): Promise<T> {
		if (lifetime.aborted)
			throw new ConversationRuntimeHostError("RUNTIME_INTERRUPTED", true);
		const promise = work();
		keyDependencies.add(promise);
		void promise.then(
			() => keyDependencies.delete(promise),
			() => keyDependencies.delete(promise),
		);
		return promise;
	}
	const originalExecutionKeys = options.executionKeys;
	const executionKeys: WorkerExecutionKeyReaderV4 | undefined =
		originalExecutionKeys && {
			readAcceptedExecution: (request) =>
				trackKeyDependency(() =>
					originalExecutionKeys.readAcceptedExecution(request),
				),
			readCiphertext: (binding) =>
				trackKeyDependency(() => originalExecutionKeys.readCiphertext(binding)),
		};
	const originalDecryptor = options.relayKeyDecryptor;
	const decryptor: RelayKeyWorkerDecryptorV1 | undefined =
		originalDecryptor && {
			decrypt: (input) =>
				trackKeyDependency(() => originalDecryptor.decrypt(input)),
		};

	const legacyControlStore = options.legacyControlStore;
	const resolveCurrentApplication = options.resolveCurrentApplication;
	const resolveCurrentApiUseGrant = options.resolveCurrentApiUseGrant;
	const taskAuthorization = createTaskRuntimeAuthorizationUseCaseV1({
		workerId: options.workerId,
		channelAuthorizationCurrent: (record, signal) =>
			options.channelAuthorizationCurrent
				? bounded(options.channelAuthorizationCurrent(record, signal), signal)
				: unavailable("CHANNEL_AUTHORIZATION_UNAVAILABLE"),
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
		...(resolveCurrentApplication
			? {
					resolveCurrentApplication: (
						applicationId: string,
						agentId: string,
						signal: AbortSignal,
					) =>
						bounded(
							resolveCurrentApplication(applicationId, agentId, signal),
							signal,
						),
				}
			: {}),
		...(resolveCurrentApiUseGrant
			? {
					resolveCurrentApiUseGrant: (
						principal: TaskPrincipalV1,
						agentId: string,
						signal: AbortSignal,
					) =>
						bounded(
							resolveCurrentApiUseGrant(principal, agentId, signal),
							signal,
						),
				}
			: {}),
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
	) {
		const context = contextFor(request);
		let state = await stateFor(context, signal);
		const beforeRoute = await current(context, state, command, signal);
		let authority = beforeRoute.authority;
		const target = await bounded(
			options.resolveRuntimeHost({
				agentId: context.claim.agentId,
				conversationId: context.claim.conversationId,
				actorId: context.claim.actorId,
				channelId: context.claim.channelId,
				principal: context.claim.principal,
				sessionGeneration: context.claim.sessionGeneration,
				deliveryFence: context.claim.deliveryFence,
				signal,
				workload: beforeRoute.record.workload,
				sandboxResource: state.sandboxResource,
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
		// Recheck the authorization and route immediately before minting any wire grant.
		state = await stateFor(context, signal);
		const finalRoute = await current(context, state, command, signal);
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
				conversationId: context.claim.conversationId,
				actorId: context.claim.actorId,
				channelId: context.claim.channelId,
				principal: context.claim.principal,
				sessionGeneration: context.claim.sessionGeneration,
				deliveryFence: context.claim.deliveryFence,
				signal,
				workload: finalRoute.record.workload,
				sandboxResource: state.sandboxResource,
				purpose: finalRoute.authority.purpose,
				command,
			}),
			signal,
		);
		if (finalTarget.workerId !== options.signing.workerId)
			denied("RUNTIME_WORKER_BINDING_INVALID");
		state = await stateFor(context, signal);
		const postTargetRoute = await current(context, state, command, signal);
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
				conversationId: context.claim.conversationId,
				actorId: context.claim.actorId,
				channelId: context.claim.channelId,
				principal: context.claim.principal,
				sessionGeneration: context.claim.sessionGeneration,
				deliveryFence: context.claim.deliveryFence,
				signal,
				workload: postTargetRoute.record.workload,
				sandboxResource: state.sandboxResource,
				purpose: postTargetRoute.authority.purpose,
				command,
			}),
			signal,
		);
		if (
			postTarget.workerId !== options.signing.workerId ||
			!isDeepStrictEqual(postTarget, finalTarget)
		)
			unavailable("RUNTIME_ROUTE_STALE");
		state = await stateFor(context, signal);
		const afterTargetRoute = await current(context, state, command, signal);
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
			state: structuredClone(state) as ConversationRuntimeStateV2,
			authority,
			client,
			base,
			target: postTarget,
			route: structuredClone(afterTargetRoute.record),
		};
	}
	function customBusiness(prepared: Awaited<ReturnType<typeof prepare>>) {
		const source = prepared.route.workload?.candidate.configuration.source;
		if (
			prepared.state.runtimeSubmitProtocol !== undefined &&
			prepared.state.runtimeSubmitProtocol !== "v2" &&
			prepared.state.runtimeSubmitProtocol !== "v4"
		)
			unavailable("RELAY_KEY_UNAVAILABLE");
		if (source?.kind === "standard") {
			// The persisted Store protocol is the V4 rollout authority. Historical
			// or V2 records must never fall back to a static business Key.
			if (prepared.state.runtimeSubmitProtocol === "v4") return false;
			unavailable("RELAY_KEY_UNAVAILABLE");
		}
		if (
			source?.kind !== "custom" ||
			source.interactionMode !== "platform-adapter"
		)
			unavailable("RUNTIME_WORKLOAD_UNAVAILABLE");
		if (
			prepared.state.runtimeSubmitProtocol === "v4" ||
			prepared.context.claim.executionSource != null ||
			prepared.context.claim.relayKeyBinding != null
		)
			unavailable("RUNTIME_REQUEST_INVALID");
		return true;
	}
	function keyedIdentity(prepared: Awaited<ReturnType<typeof prepare>>) {
		const claim = prepared.context.claim;
		const binding = claim.relayKeyBinding;
		if (
			prepared.state.runtimeSubmitProtocol !== "v4" ||
			!claim.executionSource ||
			!binding
		)
			unavailable("RELAY_KEY_UNAVAILABLE");
		return {
			executionSource: claim.executionSource,
			keyBinding: {
				purpose: binding.purpose,
				subjectId: binding.subjectId,
				ciphertextRef: binding.keyId,
				version: binding.keyVersion,
			},
		};
	}
	async function assertCurrentPrepared(
		prepared: Awaited<ReturnType<typeof prepare>>,
		command: Command,
		signal: AbortSignal,
	) {
		const state = await stateFor(prepared.context, signal);
		const decision = await current(prepared.context, state, command, signal);
		if (!isDeepStrictEqual(decision.authority, prepared.authority))
			unavailable("RUNTIME_ROUTE_STALE");
		if (!isDeepStrictEqual(decision.record, prepared.route))
			unavailable("RUNTIME_ROUTE_STALE");
		const target = await bounded(
			options.resolveRuntimeHost({
				agentId: prepared.context.claim.agentId,
				conversationId: prepared.context.claim.conversationId,
				actorId: prepared.context.claim.actorId,
				channelId: prepared.context.claim.channelId,
				principal: prepared.context.claim.principal,
				sessionGeneration: prepared.context.claim.sessionGeneration,
				deliveryFence: prepared.context.claim.deliveryFence,
				signal,
				workload: decision.record.workload,
				sandboxResource: state.sandboxResource,
				purpose: decision.authority.purpose,
				command,
			}),
			signal,
		);
		if (!isDeepStrictEqual(target, prepared.target))
			unavailable("RUNTIME_ROUTE_STALE");
		const latestState = await stateFor(prepared.context, signal);
		const latest = await current(
			prepared.context,
			latestState,
			command,
			signal,
		);
		if (
			!isDeepStrictEqual(latest.authority, prepared.authority) ||
			!isDeepStrictEqual(latest.record, prepared.route)
		)
			unavailable("RUNTIME_ROUTE_STALE");
		// The last await revalidates the owned lease/fence after directory and route waits.
		const fenced = await stateFor(prepared.context, signal);
		if (!isDeepStrictEqual(fenced, prepared.state))
			unavailable("RUNTIME_FENCE_STALE");
		signal.throwIfAborted();
	}
	function v4Client(
		prepared: Awaited<ReturnType<typeof prepare>>,
		command: Command,
		signal: AbortSignal,
	) {
		const claim = prepared.context.claim;
		return createWorkerRuntimeHostClientV4({
			...prepared.target,
			fetch: options.fetch,
			verifyGrant: signV4.verify,
			executionKeys,
			decryptor,
			...(claim.modelOptionId && claim.reasoningLevel
				? {
						selection: {
							schemaVersion: 1 as const,
							modelOptionId: claim.modelOptionId,
							reasoningLevel: claim.reasoningLevel,
						},
					}
				: {}),
			assertCurrentAuthorization: () =>
				assertCurrentPrepared(prepared, command, signal),
		});
	}
	async function dispatchBusinessV4(
		prepared: Awaited<ReturnType<typeof prepare>>,
		signal: AbortSignal,
	) {
		const { context, state, authority, base } = prepared;
		if (authority.purpose !== "business")
			denied("TASK_AUTHORIZATION_CONTROL_ONLY");
		const claim = context.claim;
		if (!claim.input || !claim.modelOptionId || !claim.reasoningLevel)
			unavailable("RUNTIME_REQUEST_INVALID");
		const identity = keyedIdentity(prepared);
		const submit = claim.operation !== "conversation.turn.supplement.v1";
		if (submit && state.originalSubmitHostSessionRef === undefined)
			unavailable("RUNTIME_ACCEPTANCE_UNKNOWN");
		if (!submit && (!state.hostSessionRef || !claim.messageId))
			unavailable("RUNTIME_ACCEPTANCE_UNKNOWN");
		const unsigned: RuntimeBusinessRequestV4 = submit
			? {
					...base,
					schemaVersion: 4,
					...identity,
					hostSessionRef: state.originalSubmitHostSessionRef as string | null,
					input: { ...claim.input, attachments: [...claim.input.attachments] },
					selection: {
						schemaVersion: 1,
						modelOptionId: claim.modelOptionId,
						reasoningLevel: claim.reasoningLevel,
					},
					grant: {
						schemaVersion: 4,
						format: "runtime-execution-jws",
						token: "unsigned.unsigned.unsigned",
					},
				}
			: {
					...base,
					schemaVersion: 4,
					...identity,
					hostSessionRef: state.hostSessionRef as string,
					operation: {
						kind: "message",
						id: claim.messageId as string,
						deliveryFence: claim.deliveryFence,
						executionDeliveryFence: claim.executionDeliveryFence,
					},
					input: { ...claim.input, attachments: [...claim.input.attachments] },
					grant: {
						schemaVersion: 4,
						format: "runtime-execution-jws",
						token: "unsigned.unsigned.unsigned",
					},
				};
		const command = submit ? "turn.submit" : "turn.supplement";
		const client = v4Client(prepared, command, signal);
		const request = {
			...unsigned,
			grant: signV4.sign(unsigned, authority.authorizationRecordId),
		};
		const response = await (submit
			? client.submitTurn(request, signal)
			: client.supplement(request, signal));
		return { ...response, schemaVersion: submit ? (2 as const) : (1 as const) };
	}
	async function* readPreparedEvents(
		prepared: Awaited<ReturnType<typeof prepare>>,
		signal: AbortSignal,
	) {
		const { state, authority, client, base } = prepared;
		if (!state.hostSessionRef) unavailable("RUNTIME_ACCEPTANCE_UNKNOWN");
		const body = {
			...base,
			hostSessionRef: state.hostSessionRef,
			consumer: "platform_worker_persistence" as const,
			afterCursor: state.runtimeCursor,
		};
		if (state.runtimeSubmitProtocol !== "v4") {
			yield* client.events(
				{ ...body, grant: signRequest(body, authority, "events.persist") },
				signal,
			);
			return;
		}
		const request: RuntimeEventReadRequestV4 =
			RuntimeEventReadRequestV4Schema.parse({
				...body,
				schemaVersion: 4,
				...keyedIdentity(prepared),
				grant: {
					schemaVersion: 2,
					format: "runtime-execution-jws",
					token: "unsigned.unsigned.unsigned",
				},
			});
		const grant = await signV4.signEvent(request, authority);
		const replay = await v4Client(
			prepared,
			"events.persist",
			signal,
		).readEvents({ ...request, grant }, signal);
		yield* replay.events;
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
		const { context, state, authority, client, base, route } = await prepare(
			request,
			"session.status",
			active,
		);
		const body = {
			...base,
			originalOperationDigest: state.originalOperationDigest,
		};
		if (state.hostSessionRef === null && authority.purpose === "control") {
			// Only the Host's durable V4 facts can establish the missing ref.
			const binding = await client.readOriginalBinding(
				{ ...body, grant: signRequest(body, authority, "session.status") },
				active,
			);
			if (binding.executionId !== context.claim.executionId)
				unavailable("RUNTIME_ACCEPTANCE_UNKNOWN");
			const latestState = await stateFor(context, active);
			const latest = await current(
				context,
				latestState,
				"session.status",
				active,
			);
			if (
				!isDeepStrictEqual(latest.authority, authority) ||
				latestState.originalOperationDigest !== state.originalOperationDigest ||
				(latestState.hostSessionRef !== null &&
					latestState.hostSessionRef !== binding.hostSessionRef)
			)
				unavailable("RUNTIME_FENCE_STALE");
			if (
				latest.record.configurationRevision !== route.configurationRevision ||
				!isDeepStrictEqual(latest.record.agent, route.agent) ||
				!isDeepStrictEqual(latest.record.workload, route.workload)
			)
				unavailable("RUNTIME_ROUTE_STALE");
			return { ...binding, schemaVersion: 2 as const };
		}
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
				if (!customBusiness(prepared))
					return dispatchBusinessV4(prepared, active);
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
				if (!customBusiness(prepared))
					return dispatchBusinessV4(prepared, active);
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
			const prepared = await prepare(request, "events.persist", active);
			if (
				!prepared.state.generationIsolation ||
				!prepared.state.hostSessionRef ||
				prepared.authority.purpose !== "control"
			)
				denied("TASK_AUTHORIZATION_CONTROL_ONLY");
			yield* readPreparedEvents(prepared, active);
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
			const prepared = await prepare(request, "events.ack", active);
			const { state, authority, client, base } = prepared;
			if (state.runtimeCursor !== request.confirmedCursor) return;
			if (!state.hostSessionRef) unavailable("RUNTIME_ACCEPTANCE_UNKNOWN");
			const body = {
				...base,
				hostSessionRef: state.hostSessionRef,
				consumer: "platform_worker_persistence" as const,
				confirmedCursor: request.confirmedCursor,
			};
			if (state.runtimeSubmitProtocol !== "v4") {
				await client.acknowledgeEvents(
					{ ...body, grant: signRequest(body, authority, "events.ack") },
					active,
				);
				return;
			}
			const v4: RuntimeEventAckRequestV4 = RuntimeEventAckRequestV4Schema.parse(
				{
					...body,
					schemaVersion: 4,
					...keyedIdentity(prepared),
					grant: {
						schemaVersion: 2,
						format: "runtime-execution-jws",
						token: "unsigned.unsigned.unsigned",
					},
				},
			);
			const grant = await signV4.signEvent(v4, authority);
			await v4Client(prepared, "events.ack", active).acknowledgeEvents(
				{ ...v4, grant },
				active,
			);
		},
		async *events(request, signal) {
			const active = combined(signal);
			for (;;) {
				active.throwIfAborted();
				const prepared = await prepare(request, "events.persist", active);
				const { state, authority } = prepared;
				if (!state.hostSessionRef) unavailable("RUNTIME_ACCEPTANCE_UNKNOWN");
				let terminal = false;
				let streamFailure: ConversationRuntimeHostError | undefined;
				try {
					for await (const event of readPreparedEvents(prepared, active)) {
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
	return {
		authorization,
		runtimeHost,
		async close() {
			controller.abort();
			await Promise.allSettled([...keyDependencies]);
		},
	};
}
