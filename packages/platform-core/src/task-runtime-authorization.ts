import type { AgentManagementStateV1 } from "./agent-management.js";
import {
	type ConversationDispatchClaimV1,
	type ConversationDispatchExecutionStatusV1,
	type ConversationMetadataRecoveryV1,
	ConversationRuntimeHostError,
} from "./conversation-dispatch.js";
import type { ConversationGenerationIsolationV1 } from "./conversation-generation-isolation.js";
import {
	type CurrentTaskUserV1,
	isTaskAuthorizationCurrentV1,
	parseTaskAuthorizationBoundaryV1,
	type TaskAuthorizationBoundaryV1,
	type TaskPrincipalV1,
	type TaskSystemControlReasonV1,
} from "./task-authorization.js";
import type { WorkloadReconciliationStateV1 } from "./workload-reconciliation.js";

export interface TaskRuntimeRecoveryStateV1 {
	readonly metadataRecovery?: ConversationMetadataRecoveryV1;
	readonly generationIsolation?: ConversationGenerationIsolationV1;
	readonly hostSessionRef: string | null;
	readonly runtimeCursor: string | null;
	readonly originalOperationDigest: string;
	readonly executionStatus: ConversationDispatchExecutionStatusV1;
	readonly stopPending: boolean;
}

export interface TaskRuntimeAuthorizationRecordV1 {
	readonly authorizationRecordId: string;
	readonly executionId: string;
	readonly boundary: TaskAuthorizationBoundaryV1;
	readonly revokedAt: Date | null;
	readonly agent: AgentManagementStateV1;
	readonly configurationRevision: number;
	readonly workload: WorkloadReconciliationStateV1 | null;
}

export interface LegacyTaskControlRecoveryV1 {
	readonly migrationRecordId: string;
	readonly originalPrincipal: TaskPrincipalV1;
	readonly agentId: string;
	readonly conversationId: string;
	readonly executionId: string;
	readonly turnId: string;
	readonly channelId: string;
	readonly sessionGeneration: number;
	readonly hostSessionRef: string;
	readonly originalOperationDigest: string;
	readonly executionStatus: ConversationDispatchExecutionStatusV1;
	readonly runtimeCursor: string | null;
	readonly deliveryFence: number;
	readonly configurationRevision: number | null;
	readonly workload: WorkloadReconciliationStateV1 | null;
}

export type TaskRuntimeAuthorizationContextV1 = {
	readonly claim: ConversationDispatchClaimV1;
	readonly principal: TaskPrincipalV1;
} & (
	| { readonly kind: "business"; readonly authorizationRecordId: string }
	| { readonly kind: "legacy-control"; readonly migrationRecordId: string }
);
type Context = TaskRuntimeAuthorizationContextV1;
type Command =
	| "turn.submit"
	| "turn.supplement"
	| "turn.stop"
	| "session.status"
	| "generation.cancel"
	| "execution.renew"
	| "events.persist"
	| "events.ack";
type TaskRuntimeAuthorityV1 =
	| { readonly purpose: "business"; readonly authorizationRecordId: string }
	| {
			readonly purpose: "control";
			readonly controlRecordId: string;
			readonly reason: TaskSystemControlReasonV1;
	  };

interface Options {
	/** A channel denial enters the same durable revocation path as user access loss. */
	channelAuthorizationCurrent?(
		record: TaskRuntimeAuthorizationRecordV1,
		signal: AbortSignal,
	): Promise<boolean>;
	readonly workerId: string;
	readRuntimeState(
		claim: ConversationDispatchClaimV1,
		signal: AbortSignal,
	): Promise<TaskRuntimeRecoveryStateV1 | null>;
	readAuthorization(
		executionId: string,
		signal: AbortSignal,
	): Promise<TaskRuntimeAuthorizationRecordV1 | null>;
	readLegacyRecovery?(
		executionId: string,
		signal: AbortSignal,
	): Promise<LegacyTaskControlRecoveryV1 | null>;
	resolveCurrentUser(
		userId: string,
		signal: AbortSignal,
	): Promise<CurrentTaskUserV1 | null>;
	recordControl(
		input: {
			readonly executionId: string;
			readonly authorizationRecordId: string;
			readonly reason: TaskSystemControlReasonV1;
			readonly workerId: string;
			readonly traceId: string;
			readonly requestId: string;
		},
		signal: AbortSignal,
	): Promise<{ readonly controlRecordId: string }>;
}

function unavailable(code = "AUTHORIZATION_UNAVAILABLE"): never {
	throw new ConversationRuntimeHostError(code, true);
}
function denied(code = "AUTHORIZATION_REVOKED"): never {
	throw new ConversationRuntimeHostError(code, true);
}

/** Platform Web channel policy over the Store's current, execution-bound configuration. */
export function isPlatformConversationChannelCurrentV1(
	record: TaskRuntimeAuthorizationRecordV1,
): boolean {
	if (record.boundary.channelId !== "web")
		unavailable("CHANNEL_AUTHORIZATION_UNAVAILABLE");
	const workload = record.workload;
	const configuration = workload?.candidate.configuration;
	if (
		!workload ||
		!configuration ||
		workload.agentId !== record.boundary.agentId ||
		configuration.agentId !== record.boundary.agentId ||
		configuration.revision !== record.configurationRevision ||
		workload.sourceConfigurationRevision !== record.configurationRevision
	)
		unavailable("CHANNEL_AUTHORIZATION_UNAVAILABLE");
	// Standard templates always expose the platform channel, including during reconciliation.
	if (configuration.source.kind === "standard") return true;
	if (configuration.source.interactionMode === "self-managed") return false;
	// A previously verified platform adapter keeps its channel during an upgrade.
	// Current business readiness remains enforced by current() and the Runtime resolver.
	if (
		workload.verified?.configuration.agentId !== record.boundary.agentId ||
		workload.verified.configuration.revision > configuration.revision ||
		workload.verified.configuration.source.kind !== "custom" ||
		workload.verified.configuration.source.interactionMode !==
			"platform-adapter" ||
		!workload.capabilities
	)
		unavailable("CHANNEL_AUTHORIZATION_UNAVAILABLE");
	return true;
}

/** Current user authority and durable system control share the original task boundary. */
export function createTaskRuntimeAuthorizationUseCaseV1(options: Options) {
	if (!options.workerId) throw new TypeError("Task Worker identity is invalid");
	async function stateFor(context: Context, signal: AbortSignal) {
		const state = await options.readRuntimeState(context.claim, signal);
		if (!state) unavailable("RUNTIME_FENCE_STALE");
		if (
			JSON.stringify(state.metadataRecovery) !==
			JSON.stringify(context.claim.metadataRecovery)
		)
			unavailable("RUNTIME_FENCE_STALE");
		if (!/^[A-Za-z0-9_-]{43}$/.test(state.originalOperationDigest))
			unavailable("RUNTIME_RECOVERY_PROVENANCE_UNAVAILABLE");
		return state;
	}
	async function readBusinessRecord(
		claim: ConversationDispatchClaimV1,
		signal: AbortSignal,
	) {
		const record = await options.readAuthorization(claim.executionId, signal);
		if (!record) return null;
		let boundary: TaskAuthorizationBoundaryV1;
		try {
			boundary = parseTaskAuthorizationBoundaryV1(record.boundary);
		} catch {
			denied("TASK_AUTHORIZATION_BINDING_INVALID");
		}
		if (
			record.executionId !== claim.executionId ||
			boundary.principal.kind !== "user" ||
			boundary.principal.id !== claim.actorId ||
			boundary.agentId !== claim.agentId ||
			boundary.channelId !== claim.channelId ||
			boundary.agentAuthorizationRevision !== claim.authorizationRevision
		)
			denied("TASK_AUTHORIZATION_BINDING_INVALID");
		return { ...record, boundary };
	}
	async function recordFor(
		claim: ConversationDispatchClaimV1,
		signal: AbortSignal,
	) {
		const record = await readBusinessRecord(claim, signal);
		if (!record) denied("TASK_AUTHORIZATION_PROVENANCE_UNAVAILABLE");
		return record;
	}
	async function legacyRecordFor(
		claim: ConversationDispatchClaimV1,
		state: TaskRuntimeRecoveryStateV1,
		signal: AbortSignal,
	) {
		if (!options.readLegacyRecovery)
			denied("TASK_AUTHORIZATION_PROVENANCE_UNAVAILABLE");
		const record = await options.readLegacyRecovery(claim.executionId, signal);
		if (!record) denied("TASK_AUTHORIZATION_PROVENANCE_UNAVAILABLE");
		if (
			!record.migrationRecordId ||
			record.originalPrincipal.kind !== "user" ||
			record.originalPrincipal.id !== claim.actorId
		)
			denied("TASK_AUTHORIZATION_BINDING_INVALID");
		for (const key of [
			"agentId",
			"channelId",
			"conversationId",
			"executionId",
			"turnId",
			"sessionGeneration",
		] as const)
			if (record[key] !== claim[key])
				denied("TASK_AUTHORIZATION_BINDING_INVALID");
		if (
			record.hostSessionRef !== state.hostSessionRef ||
			record.originalOperationDigest !== state.originalOperationDigest ||
			record.deliveryFence !== claim.executionDeliveryFence
		)
			denied("TASK_AUTHORIZATION_BINDING_INVALID");
		if (
			record.runtimeCursor !== state.runtimeCursor ||
			record.executionStatus !== state.executionStatus
		)
			unavailable("RUNTIME_FENCE_STALE");
		return record;
	}
	async function control(
		context: Context,
		reason: TaskSystemControlReasonV1,
		signal: AbortSignal,
	): Promise<TaskRuntimeAuthorityV1> {
		if (context.kind !== "business") denied("TASK_AUTHORIZATION_CONTROL_ONLY");
		const record = await options.recordControl(
			{
				executionId: context.claim.executionId,
				authorizationRecordId: context.authorizationRecordId,
				reason,
				workerId: options.workerId,
				traceId: context.claim.traceId,
				requestId: context.claim.requestId,
			},
			signal,
		);
		if (!record.controlRecordId) unavailable();
		return {
			purpose: "control",
			controlRecordId: record.controlRecordId,
			reason,
		};
	}
	function isolationAuthority(
		context: Context,
		state: TaskRuntimeRecoveryStateV1,
	) {
		const isolation = state.generationIsolation;
		if (!isolation) return undefined;
		if (
			isolation.originalPrincipal.kind !== context.principal.kind ||
			isolation.originalPrincipal.id !== context.principal.id ||
			isolation.operationId !==
				`generation:${context.claim.conversationId}:${context.claim.sessionGeneration}` ||
			!isolation.controlRecordId
		)
			denied("TASK_AUTHORIZATION_BINDING_INVALID");
		return {
			purpose: "control" as const,
			controlRecordId: isolation.controlRecordId,
			reason: "generation_isolation" as const,
		};
	}
	function terminalEventRecovery(
		claim: ConversationDispatchClaimV1,
		state: TaskRuntimeRecoveryStateV1,
	) {
		return (
			(claim.operation === "conversation.turn.submit.v1" ||
				claim.operation === "conversation.turn.regenerate.v1") &&
			["completed", "failed", "cancelled"].includes(state.executionStatus) &&
			state.hostSessionRef !== null &&
			(!state.stopPending || claim.metadataRecovery !== undefined) &&
			!state.generationIsolation
		);
	}

	async function current(
		context: Context,
		state: TaskRuntimeRecoveryStateV1,
		command: Command,
		signal: AbortSignal,
	) {
		if (
			context.claim.metadataRecovery &&
			!["session.status", "events.persist", "events.ack"].includes(command)
		)
			denied("TASK_AUTHORIZATION_CONTROL_ONLY");
		if (context.kind === "legacy-control") {
			if (
				![
					"session.status",
					"turn.stop",
					"events.persist",
					"events.ack",
					...(state.generationIsolation ? ["generation.cancel"] : []),
				].includes(command)
			)
				denied("TASK_AUTHORIZATION_CONTROL_ONLY");
			const original = await legacyRecordFor(context.claim, state, signal);
			if (
				original.migrationRecordId !== context.migrationRecordId ||
				original.originalPrincipal.kind !== context.principal.kind ||
				original.originalPrincipal.id !== context.principal.id
			)
				denied("TASK_AUTHORIZATION_BINDING_INVALID");
			return {
				authority: isolationAuthority(context, state) ?? {
					purpose: "control" as const,
					controlRecordId: original.migrationRecordId,
					// The immutable migration record always denotes historical recovery.
					// turn.stop itself establishes the Host's durable stop latch.
					reason: "recovery" as const,
				},
				record: {
					agent: null,
					configurationRevision: original.configurationRevision,
					workload: original.workload,
				},
			};
		}
		const record = await recordFor(context.claim, signal);
		if (
			record.authorizationRecordId !== context.authorizationRecordId ||
			record.boundary.principal.kind !== context.principal.kind ||
			record.boundary.principal.id !== context.principal.id
		)
			denied("TASK_AUTHORIZATION_BINDING_INVALID");
		const isolation = isolationAuthority(context, state);
		if (isolation) return { authority: isolation, record };
		if (terminalEventRecovery(context.claim, state)) {
			if (!["session.status", "events.persist", "events.ack"].includes(command))
				denied("TASK_AUTHORIZATION_CONTROL_ONLY");
			return { authority: await control(context, "recovery", signal), record };
		}
		if (record.revokedAt)
			return {
				authority: await control(context, "authorization_revoked", signal),
				record,
			};
		const user = await options.resolveCurrentUser(
			record.boundary.principal.id,
			signal,
		);
		const latest = await recordFor(context.claim, signal);
		if (latest.authorizationRecordId !== context.authorizationRecordId)
			denied("TASK_AUTHORIZATION_BINDING_INVALID");
		if (
			latest.revokedAt ||
			(options.channelAuthorizationCurrent &&
				!(await options.channelAuthorizationCurrent(latest, signal))) ||
			!user ||
			!isTaskAuthorizationCurrentV1({
				boundary: latest.boundary,
				user,
				agent: latest.agent,
			})
		)
			return {
				authority: await control(context, "authorization_revoked", signal),
				record: latest,
			};
		if (state.stopPending || command === "turn.stop")
			return {
				authority: await control(context, "stop", signal),
				record: latest,
			};
		const workload = latest.workload;
		if (
			latest.agent.status !== "available" ||
			latest.agent.desiredState !== "running" ||
			latest.agent.serviceAvailability !== "ready" ||
			!workload ||
			workload.agentId !== context.claim.agentId ||
			workload.phase !== "ready" ||
			!workload.identity ||
			!workload.verified ||
			workload.verifiedRevision === null ||
			workload.sourceConfigurationRevision !== latest.configurationRevision ||
			workload.verified.configuration.revision !==
				latest.configurationRevision ||
			(workload.verified.configuration.source.kind === "standard"
				? context.claim.modelConfigurationRevision !==
					latest.configurationRevision
				: workload.verified.configuration.source.kind !== "custom" ||
					context.claim.modelConfigurationRevision !== null) ||
			workload.sourceLifecycleRevision !== latest.agent.workloadRevision ||
			!Number.isSafeInteger(latest.agent.fence) ||
			latest.agent.fence < 1 ||
			workload.fence !== latest.agent.fence
		) {
			if (["session.status", "events.persist", "events.ack"].includes(command))
				return {
					authority: await control(context, "recovery", signal),
					record: latest,
				};
			unavailable("RUNTIME_WORKLOAD_UNAVAILABLE");
		}
		return {
			authority: {
				purpose: "business" as const,
				authorizationRecordId: context.authorizationRecordId,
			},
			record: latest,
		};
	}

	async function authorizeClaim(
		claim: ConversationDispatchClaimV1,
		signal: AbortSignal,
	): Promise<
		| { readonly outcome: "allowed"; readonly context: Context }
		| { readonly outcome: "denied" | "unavailable" }
	> {
		try {
			if (claim.leaseOwner !== options.workerId) return { outcome: "denied" };
			const record = await readBusinessRecord(claim, signal);
			let context: Context;
			if (record)
				context = {
					kind: "business",
					claim: structuredClone(claim),
					authorizationRecordId: record.authorizationRecordId,
					principal: { ...record.boundary.principal },
				};
			else {
				if (claim.operation === "conversation.turn.supplement.v1")
					return { outcome: "denied" };
				const state = await options.readRuntimeState(claim, signal);
				if (!state) unavailable("RUNTIME_FENCE_STALE");
				const original = await legacyRecordFor(claim, state, signal);
				if (original.executionStatus === "submitted")
					return { outcome: "unavailable" };
				context = {
					kind: "legacy-control",
					claim: structuredClone(claim),
					migrationRecordId: original.migrationRecordId,
					principal: { ...original.originalPrincipal },
				};
			}
			const state = await stateFor(context, signal);
			const { authority: result } = await current(
				context,
				state,
				claim.operation === "conversation.turn.stop.v1"
					? "turn.stop"
					: "session.status",
				signal,
			);
			if (
				context.kind === "business" &&
				!state.generationIsolation &&
				result.purpose === "control" &&
				!state.stopPending &&
				!terminalEventRecovery(claim, state) &&
				!["processing", "unknown"].includes(state.executionStatus) &&
				claim.operation !== "conversation.turn.stop.v1"
			)
				return {
					outcome: result.reason === "recovery" ? "unavailable" : "denied",
				};

			return { outcome: "allowed", context };
		} catch (error) {
			return {
				outcome:
					error instanceof ConversationRuntimeHostError &&
					error.code.startsWith("TASK_AUTHORIZATION_")
						? "denied"
						: "unavailable",
			};
		}
	}
	return {
		authorizeClaim,
		current,
		recordSystemControl: control,
		readRuntimeState: stateFor,
	};
}
