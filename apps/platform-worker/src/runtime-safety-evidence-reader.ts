import {
	type RuntimePersistedSafetyEvidenceV1,
	RuntimePersistedSafetyEvidenceV1Schema,
	type RuntimeSafetyEvidenceWindowV1,
	runtimeSafetyEvidenceBusinessPurposeRefV1,
	runtimeSafetyEvidencePrincipalRefV1,
} from "@agent-infra/contracts/runtime";
import {
	ingestRuntimeSafetyEvidenceBatchV1,
	type RuntimeSafetyEvidenceScopeV1,
	RuntimeSafetyEvidenceUnsupportedErrorV1,
	type SessionSandboxRuntimeStateV1,
	type TaskPrincipalV1,
} from "@agent-infra/platform-core";
import {
	acknowledgeRuntimeSafetyEvidenceV1,
	readRuntimeSafetyEvidenceV1,
} from "./runtime-host-client.js";

/**
 * Engineering Spec §18.5.1 and Runtime HLD §8.5.6 step 4: the Worker continues reading the Host
 * evidence log of a business Execution it is already draining, re-checks every record against
 * the deployment window and the committed original scope, stores it and only then confirms the
 * evidence cursor. Evidence is best effort: nothing here can fail, delay or reorder business
 * events, terminals or their ACK. Absent a valid window this module is never assembled.
 */
/** Committed facts of one business Execution drain; the only source of its original scope. */
export interface RuntimeSafetyEvidenceDrainV1 {
	/** The resolved Session route and its sandbox-bound service token, as used for events. */
	readonly baseUrl: string;
	readonly serviceToken: string;
	readonly traceId: string;
	readonly claim: {
		readonly agentId: string;
		readonly conversationId: string;
		readonly executionId: string;
		readonly sessionGeneration: number;
		readonly executionDeliveryFence: number;
		readonly authorizationRevision: string;
	};
	readonly principal: TaskPrincipalV1;
	readonly authorizationRecordId: string;
	/** The original subject's current permission for the task was revoked. */
	readonly revoked: boolean;
	readonly sandboxResource: SessionSandboxRuntimeStateV1;
}

function observedPodUid(resource: SessionSandboxRuntimeStateV1) {
	const observation = resource.observation;
	return (
		observation?.executorInstance?.podUid ??
		observation?.resources.find((entry) => entry.kind === "Pod")?.uid
	);
}

/**
 * The original scope of the drained Execution. A record of any other Execution has no scope here
 * and is rejected (`scope_mismatch`): late evidence never signs into a newer Execution. The Host
 * instance and start references are accepted from the record only because it was read through
 * the route bound to the Pod UID the Platform observed; the Pod UID, fences, epoch, configuration
 * revision and image digest come from the committed Session Sandbox state.
 */
export async function runtimeSafetyEvidenceScopeFromDrainV1(
	drain: RuntimeSafetyEvidenceDrainV1,
	record: RuntimePersistedSafetyEvidenceV1,
	operations: readonly { readonly ref: string; readonly attemptRef: string }[],
): Promise<RuntimeSafetyEvidenceScopeV1 | undefined> {
	const { claim, sandboxResource } = drain;
	const podUid = observedPodUid(sandboxResource);
	const policy = sandboxResource.policy;
	if (
		record.binding.executionId !== claim.executionId ||
		record.binding.conversationId !== claim.conversationId ||
		!podUid ||
		!policy
	)
		return undefined;
	const executorEpoch = sandboxResource.observation?.executorInstance?.epoch;
	return {
		agentId: claim.agentId,
		conversationId: claim.conversationId,
		executionId: claim.executionId,
		principalRef: await runtimeSafetyEvidencePrincipalRefV1(drain.principal),
		purposeRef: runtimeSafetyEvidenceBusinessPurposeRefV1,
		authorization: {
			recordId: drain.authorizationRecordId,
			revision: claim.authorizationRevision,
		},
		sessionGeneration: claim.sessionGeneration,
		executionDeliveryFence: claim.executionDeliveryFence,
		operations,
		sandbox: {
			ref: sandboxResource.sandbox.sandboxId,
			podUid,
			resourceFence: sandboxResource.resourceFence,
			...(executorEpoch === undefined ? {} : { executorEpoch }),
		},
		host: {
			instanceRef: record.binding.host.instanceRef,
			startRef: record.binding.host.startRef,
			configurationRevision: String(policy.configurationRevision),
			imageDigest: policy.imageDigest,
		},
		revoked: drain.revoked,
	};
}

export type RuntimeSafetyEvidenceDrainOutcomeV1 = {
	readonly status:
		| "drained"
		| "unsupported"
		| "host_unavailable"
		| "store_unavailable"
		| "interrupted";
	readonly recorded: number;
	readonly duplicates: number;
	readonly rejected: number;
};

export interface RuntimeSafetyEvidenceReaderStoreV1 {
	recordOnce(
		record: RuntimePersistedSafetyEvidenceV1,
	): Promise<
		"recorded" | "duplicate" | "challenge_replay" | "evidence_conflict"
	>;
	readExecutionOperationAttempts(input: {
		readonly conversationId: string;
		readonly executionId: string;
	}): Promise<readonly { readonly ref: string; readonly attemptRef: string }[]>;
}

export function createRuntimeSafetyEvidenceReaderV1(options: {
	readonly window: RuntimeSafetyEvidenceWindowV1;
	readonly store: RuntimeSafetyEvidenceReaderStoreV1;
	readonly fetch?: typeof fetch;
	readonly now?: () => Date;
	readonly pageLimit?: number;
	readonly maximumPages?: number;
	readonly timeoutMs?: number;
	/** Minimum spacing of background drains of one Session route. */
	readonly intervalMs?: number;
	/** Fixed outcome codes and counts only; never a record, reference or body. */
	readonly observe?: (outcome: RuntimeSafetyEvidenceDrainOutcomeV1) => void;
}) {
	const pageLimit = options.pageLimit ?? 50;
	const maximumPages = options.maximumPages ?? 4;
	const timeoutMs = options.timeoutMs ?? 5_000;
	const intervalMs = options.intervalMs ?? 1_000;
	const now = options.now ?? (() => new Date());
	const lifetime = new AbortController();
	const running = new Map<string, Promise<void>>();
	const lastStarted = new Map<string, number>();
	const parse = (value: unknown) => {
		const parsed = RuntimePersistedSafetyEvidenceV1Schema.safeParse(value);
		return parsed.success ? parsed.data : undefined;
	};

	async function drain(
		input: RuntimeSafetyEvidenceDrainV1,
		signal?: AbortSignal,
	): Promise<RuntimeSafetyEvidenceDrainOutcomeV1> {
		const active = AbortSignal.any([
			lifetime.signal,
			AbortSignal.timeout(timeoutMs),
			...(signal ? [signal] : []),
		]);
		const target = {
			baseUrl: input.baseUrl,
			serviceToken: input.serviceToken,
			traceId: input.traceId,
			...(options.fetch ? { fetch: options.fetch } : {}),
		};
		let recorded = 0;
		let duplicates = 0;
		let rejected = 0;
		const outcome = (
			status: RuntimeSafetyEvidenceDrainOutcomeV1["status"],
		): RuntimeSafetyEvidenceDrainOutcomeV1 => ({
			status,
			recorded,
			duplicates,
			rejected,
		});
		let operations:
			| readonly { readonly ref: string; readonly attemptRef: string }[]
			| undefined;
		for (let page = 0; page < maximumPages; page++) {
			let entries: Awaited<ReturnType<typeof readRuntimeSafetyEvidenceV1>>;
			try {
				entries = await readRuntimeSafetyEvidenceV1(
					target,
					{ after: null, limit: pageLimit },
					active,
				);
			} catch {
				return outcome(active.aborted ? "interrupted" : "host_unavailable");
			}
			if (entries.length === 0) return outcome("drained");
			let result: Awaited<
				ReturnType<typeof ingestRuntimeSafetyEvidenceBatchV1>
			>;
			try {
				result = await ingestRuntimeSafetyEvidenceBatchV1({
					entries,
					parse,
					window: options.window,
					resolveScope: async (record) => {
						operations ??= await options.store.readExecutionOperationAttempts({
							conversationId: input.claim.conversationId,
							executionId: input.claim.executionId,
						});
						return runtimeSafetyEvidenceScopeFromDrainV1(
							input,
							record,
							operations,
						);
					},
					store: options.store,
					now,
				});
			} catch (error) {
				// Nothing is confirmed: the Host keeps the entries for the next drain.
				return outcome(
					error instanceof RuntimeSafetyEvidenceUnsupportedErrorV1
						? "unsupported"
						: "store_unavailable",
				);
			}
			recorded += result.recorded;
			duplicates += result.duplicates;
			rejected += result.rejected.length;
			if (result.ackCursor !== null) {
				try {
					await acknowledgeRuntimeSafetyEvidenceV1(
						target,
						result.ackCursor,
						active,
					);
				} catch {
					// A lost ACK only redelivers committed records; they come back as duplicates.
					return outcome(active.aborted ? "interrupted" : "host_unavailable");
				}
			}
			// The batch stopped before a record this reader does not understand.
			if (result.ackCursor !== entries.at(-1)?.cursor)
				return outcome("unsupported");
			if (entries.length < pageLimit) return outcome("drained");
		}
		return outcome("drained");
	}

	return {
		drain,
		/**
		 * Called after a business event ACK succeeded. Schedules at most one bounded drain per
		 * Session route and never throws into, or waits on, the business path.
		 */
		afterAcknowledge(input: RuntimeSafetyEvidenceDrainV1): void {
			if (lifetime.signal.aborted) return;
			const key = `${input.baseUrl}\n${input.claim.executionId}`;
			if (running.has(key)) return;
			const startedAt = Date.now();
			if (startedAt - (lastStarted.get(key) ?? 0) < intervalMs) return;
			if (lastStarted.size >= 1_024)
				for (const [entry, at] of lastStarted)
					if (startedAt - at >= intervalMs) lastStarted.delete(entry);
			lastStarted.set(key, startedAt);
			const task = drain(structuredClone(input))
				.then(
					(result) => options.observe?.(result),
					() => undefined,
				)
				.catch(() => undefined)
				.finally(() => {
					running.delete(key);
				});
			running.set(key, task);
		},
		/** Waits for the background drains already started, without interrupting them. */
		async settled(): Promise<void> {
			await Promise.allSettled([...running.values()]);
		},
		/** Interrupts background drains; unconfirmed entries stay in the Host log. */
		async close(): Promise<void> {
			lifetime.abort();
			await Promise.allSettled([...running.values()]);
		},
	};
}

export type RuntimeSafetyEvidenceReaderV1 = ReturnType<
	typeof createRuntimeSafetyEvidenceReaderV1
>;
