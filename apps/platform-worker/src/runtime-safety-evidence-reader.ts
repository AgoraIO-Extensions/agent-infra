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
/**
 * The business Execution drain that triggered the read: its Session route, Conversation and
 * Sandbox. Each record's scope is resolved from its own Execution's committed binding.
 */
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
	readonly sandboxResource: SessionSandboxRuntimeStateV1;
}

function observedPodUid(resource: SessionSandboxRuntimeStateV1) {
	const observation = resource.observation;
	return (
		observation?.executorInstance?.podUid ??
		observation?.resources.find((entry) => entry.kind === "Pod")?.uid
	);
}

/** The committed original binding of one Execution, read by the Store. */
export interface RuntimeSafetyEvidenceOriginalFactsV1 {
	readonly agentId: string;
	readonly conversationId: string;
	readonly executionId: string;
	readonly principal: TaskPrincipalV1;
	readonly authorizationRecordId: string;
	readonly authorizationRevision: string;
	readonly revoked: boolean;
	readonly sessionGeneration: number;
	readonly executionDeliveryFence: number;
	readonly sandbox: {
		readonly ref: string;
		readonly resourceFence: number;
		readonly podUid: string;
		readonly executorEpoch?: string;
		readonly configurationRevision: number;
		readonly imageDigest: string;
	};
	readonly operations: readonly {
		readonly ref: string;
		readonly attemptRef: string;
	}[];
}

/**
 * The original scope of the record's own Execution (#4367). The Host log is shared by every
 * Execution of the Session, so a record is never judged by the Execution whose ACK triggered
 * the drain. Undefined, and the batch stops before the record, when the record does not
 * belong to this Session route or its Execution's binding is not committed.
 *
 * The Host instance and start references are taken from the record only because it was read
 * through the route bound to this Session Sandbox; the Pod UID, fences, epoch, configuration
 * revision and image come from the committed Sandbox state, so a record of another Pod is
 * rejected as stale.
 */
export async function runtimeSafetyEvidenceScopeFromOriginalV1(
	drain: Pick<RuntimeSafetyEvidenceDrainV1, "claim" | "sandboxResource">,
	record: RuntimePersistedSafetyEvidenceV1,
	facts: RuntimeSafetyEvidenceOriginalFactsV1 | undefined,
): Promise<RuntimeSafetyEvidenceScopeV1 | undefined> {
	const { binding } = record;
	if (
		binding.conversationId !== drain.claim.conversationId ||
		binding.sandbox.ref !== drain.sandboxResource.sandbox.sandboxId ||
		!observedPodUid(drain.sandboxResource) ||
		!facts ||
		facts.executionId !== binding.executionId ||
		facts.conversationId !== binding.conversationId ||
		facts.sandbox.ref !== binding.sandbox.ref
	)
		return undefined;
	return {
		agentId: facts.agentId,
		conversationId: facts.conversationId,
		executionId: facts.executionId,
		principalRef: await runtimeSafetyEvidencePrincipalRefV1(facts.principal),
		purposeRef: runtimeSafetyEvidenceBusinessPurposeRefV1,
		authorization: {
			recordId: facts.authorizationRecordId,
			revision: facts.authorizationRevision,
		},
		sessionGeneration: facts.sessionGeneration,
		executionDeliveryFence: facts.executionDeliveryFence,
		operations: facts.operations,
		sandbox: {
			ref: facts.sandbox.ref,
			podUid: facts.sandbox.podUid,
			resourceFence: facts.sandbox.resourceFence,
			...(facts.sandbox.executorEpoch === undefined
				? {}
				: { executorEpoch: facts.sandbox.executorEpoch }),
		},
		host: {
			instanceRef: binding.host.instanceRef,
			startRef: binding.host.startRef,
			configurationRevision: String(facts.sandbox.configurationRevision),
			imageDigest: facts.sandbox.imageDigest,
		},
		revoked: facts.revoked,
	};
}

export type RuntimeSafetyEvidenceDrainOutcomeV1 = {
	readonly status:
		| "drained"
		| "unsupported"
		/** Stopped before a record whose own Execution scope is not resolvable yet. */
		| "unresolved"
		| "host_unavailable"
		| "store_unavailable"
		| "interrupted";
	readonly recorded: number;
	readonly duplicates: number;
	readonly rejected: number;
};

export interface RuntimeSafetyEvidenceReaderStoreV1 {
	/**
	 * Stores the record only if the committed original binding still matches it in the same
	 * write transaction (#4358 S1); otherwise it reports the rejection.
	 */
	recordOnce(
		record: RuntimePersistedSafetyEvidenceV1,
	): Promise<
		| "recorded"
		| "duplicate"
		| "challenge_replay"
		| "evidence_conflict"
		| "revoked"
		| "stale_binding"
		| "scope_mismatch"
	>;
	readOriginalScope(input: {
		readonly conversationId: string;
		readonly executionId: string;
	}): Promise<RuntimeSafetyEvidenceOriginalFactsV1 | undefined>;
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
	/** The latest ACK per route waiting for its drain; a later ACK replaces it. */
	const pending = new Map<string, RuntimeSafetyEvidenceDrainV1>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	/**
	 * Starts the waiting drain of a route unless one runs or the interval has not passed; in
	 * that case it runs afterwards (a trailing drain), so the last ACK is never skipped.
	 */
	const pump = (key: string): void => {
		if (lifetime.signal.aborted || running.has(key) || timers.has(key)) return;
		const input = pending.get(key);
		if (!input) return;
		const wait = intervalMs - (Date.now() - (lastStarted.get(key) ?? 0));
		if (wait > 0) {
			const timer = setTimeout(() => {
				timers.delete(key);
				pump(key);
			}, wait);
			timer.unref?.();
			timers.set(key, timer);
			return;
		}
		pending.delete(key);
		const startedAt = Date.now();
		if (lastStarted.size >= 1_024)
			for (const [entry, at] of lastStarted)
				if (startedAt - at >= intervalMs && !pending.has(entry))
					lastStarted.delete(entry);
		lastStarted.set(key, startedAt);
		const task = drain(input)
			.then(
				(result) => options.observe?.(result),
				() => undefined,
			)
			.catch(() => undefined)
			.finally(() => {
				running.delete(key);
				pump(key);
			});
		running.set(key, task);
	};
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
		const original = new Map<
			string,
			Promise<RuntimeSafetyEvidenceOriginalFactsV1 | undefined>
		>();
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
						if (record.binding.conversationId !== input.claim.conversationId)
							return undefined;
						const executionId = record.binding.executionId;
						let facts = original.get(executionId);
						if (!facts) {
							facts = options.store.readOriginalScope({
								conversationId: input.claim.conversationId,
								executionId,
							});
							original.set(executionId, facts);
						}
						return runtimeSafetyEvidenceScopeFromOriginalV1(
							input,
							record,
							await facts,
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
			// The batch stopped before an entry that stays in the Host log.
			if (result.stopped) return outcome(result.stopped);
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
			// One reader per Session route: the Host log and its cursor belong to the route.
			const key = input.baseUrl;
			pending.set(key, structuredClone(input));
			pump(key);
		},
		/** Waits for the background drains already started, without interrupting them. */
		async settled(): Promise<void> {
			await Promise.allSettled([...running.values()]);
		},
		/** Interrupts background drains; unconfirmed entries stay in the Host log. */
		async close(): Promise<void> {
			lifetime.abort();
			for (const timer of timers.values()) clearTimeout(timer);
			timers.clear();
			pending.clear();
			await Promise.allSettled([...running.values()]);
		},
	};
}

export type RuntimeSafetyEvidenceReaderV1 = ReturnType<
	typeof createRuntimeSafetyEvidenceReaderV1
>;
