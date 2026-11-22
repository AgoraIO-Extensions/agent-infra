/**
 * Engineering Spec §18.5.1/§18.5.2: the Worker re-checks every persisted safety evidence
 * record against the deployment window and the original execution scope before it is stored.
 * Evidence never changes business results; a rejected record is simply not signed. The wire
 * schema lives in the contracts (`RuntimeIsolationEvidenceV1`); this module only needs the
 * binding and the fixed classes, and receives the strict parser from its caller.
 */

type ResourceClass =
	| "file"
	| "env"
	| "proc"
	| "workspace"
	| "memory_file"
	| "model_context";
type ActionClass =
	| "open"
	| "read"
	| "write"
	| "stat"
	| "list"
	| "signal"
	| "model_request";

/** The parts of a parsed `RuntimeIsolationEvidenceV1` that admission checks. */
export interface RuntimeIsolationEvidenceAdmissibleV1 {
	readonly resourceClass: ResourceClass;
	readonly actionClass: ActionClass;
	readonly binding: {
		readonly scenario: { readonly id: string; readonly version: number };
		readonly windowRef: string;
		readonly agentId: string;
		readonly conversationId: string;
		readonly executionId: string;
		readonly operation: { readonly ref: string; readonly attemptRef: string };
		readonly principalRef: string;
		readonly purposeRef: string;
		readonly authorization?: {
			readonly recordId: string;
			readonly revision: string;
		};
		readonly sessionGeneration: number;
		readonly executionDeliveryFence: number;
		readonly sandbox: {
			readonly ref: string;
			readonly podUid: string;
			readonly resourceFence: number;
			readonly executorEpoch?: string;
		};
		readonly host: {
			readonly instanceRef: string;
			readonly startRef: string;
			readonly configurationRevision: string;
			readonly imageDigest: string;
		};
		readonly producer: {
			readonly kind: "native_helper" | "model_transport";
			readonly version: string;
		};
		readonly observedAt: string;
	};
}

/** Deployment-configured, default-off acceptance window (§18.5.1 验收场景). */
export interface RuntimeSafetyEvidenceWindowV1 {
	readonly windowRef: string;
	readonly opensAt: string;
	readonly closesAt: string;
	readonly agentIds: readonly string[];
	readonly principalRefs: readonly string[];
	readonly scenarios: readonly {
		readonly id: string;
		readonly version: number;
		readonly resourceClasses: readonly ResourceClass[];
		readonly actionClasses: readonly ActionClass[];
	}[];
	readonly producers: readonly {
		readonly kind: "native_helper" | "model_transport";
		readonly version: string;
	}[];
}

/** The original execution scope, read back from committed Platform records. */
export interface RuntimeSafetyEvidenceScopeV1 {
	readonly agentId: string;
	readonly conversationId: string;
	readonly executionId: string;
	readonly principalRef: string;
	readonly purposeRef: string;
	readonly authorization?: {
		readonly recordId: string;
		readonly revision: string;
	};
	readonly sessionGeneration: number;
	readonly executionDeliveryFence: number;
	readonly operations: readonly {
		readonly ref: string;
		readonly attemptRef: string;
	}[];
	readonly sandbox: {
		readonly ref: string;
		readonly podUid: string;
		readonly resourceFence: number;
		readonly executorEpoch?: string;
	};
	/**
	 * The Host instance and the configuration and image the execution was originally bound to,
	 * from its persisted binding; never the Agent's current configuration (§18.5.1 共同绑定).
	 */
	readonly host: {
		readonly instanceRef: string;
		readonly startRef: string;
		readonly configurationRevision: string;
		readonly imageDigest: string;
	};
	/** The original subject's current permission for this task has been revoked. */
	readonly revoked: boolean;
}

export type RuntimeSafetyEvidenceRejectionV1 =
	| "window_closed"
	| "out_of_window_scope"
	| "scenario_mismatch"
	| "producer_unknown"
	| "scope_mismatch"
	| "stale_binding"
	| "future_observation"
	| "revoked"
	| "challenge_replay"
	| "evidence_conflict";

export type RuntimeSafetyEvidenceAdmissionV1 =
	| { readonly accepted: true }
	| {
			readonly accepted: false;
			readonly reason: RuntimeSafetyEvidenceRejectionV1;
	  };

/** Clock skew tolerated between the producer's wall clock and the Worker's. */
export const runtimeSafetyEvidenceClockSkewMsV1 = 5_000;

const reject = (
	reason: RuntimeSafetyEvidenceRejectionV1,
): RuntimeSafetyEvidenceAdmissionV1 => ({ accepted: false, reason });

export function admitIsolationEvidenceV1(input: {
	readonly record: RuntimeIsolationEvidenceAdmissibleV1;
	readonly window: RuntimeSafetyEvidenceWindowV1 | undefined;
	readonly scope: RuntimeSafetyEvidenceScopeV1 | undefined;
	readonly now: Date;
}): RuntimeSafetyEvidenceAdmissionV1 {
	const { record, window, scope, now } = input;
	const binding = record.binding;
	if (!window || window.windowRef !== binding.windowRef)
		return reject("window_closed");
	const observed = Date.parse(binding.observedAt);
	if (observed > now.getTime() + runtimeSafetyEvidenceClockSkewMsV1)
		return reject("future_observation");
	if (
		!(observed >= Date.parse(window.opensAt)) ||
		!(observed <= Date.parse(window.closesAt))
	)
		return reject("window_closed");
	if (
		!window.agentIds.includes(binding.agentId) ||
		!window.principalRefs.includes(binding.principalRef)
	)
		return reject("out_of_window_scope");
	const scenario = window.scenarios.find(
		(entry) =>
			entry.id === binding.scenario.id &&
			entry.version === binding.scenario.version,
	);
	if (
		!scenario?.resourceClasses.includes(record.resourceClass) ||
		!scenario.actionClasses.includes(record.actionClass)
	)
		return reject("scenario_mismatch");
	if (
		!window.producers.some(
			(producer) =>
				producer.kind === binding.producer.kind &&
				producer.version === binding.producer.version,
		)
	)
		return reject("producer_unknown");
	if (
		!scope ||
		scope.agentId !== binding.agentId ||
		scope.conversationId !== binding.conversationId ||
		scope.executionId !== binding.executionId ||
		scope.principalRef !== binding.principalRef ||
		scope.purposeRef !== binding.purposeRef ||
		scope.authorization?.recordId !== binding.authorization?.recordId ||
		scope.authorization?.revision !== binding.authorization?.revision ||
		!scope.operations.some(
			(operation) =>
				operation.ref === binding.operation.ref &&
				operation.attemptRef === binding.operation.attemptRef,
		)
	)
		return reject("scope_mismatch");
	// A changed Pod UID, epoch, generation, fence, Host configuration or image means late
	// evidence of an older execution.
	if (
		scope.sessionGeneration !== binding.sessionGeneration ||
		scope.executionDeliveryFence !== binding.executionDeliveryFence ||
		scope.sandbox.ref !== binding.sandbox.ref ||
		scope.sandbox.podUid !== binding.sandbox.podUid ||
		scope.sandbox.resourceFence !== binding.sandbox.resourceFence ||
		scope.sandbox.executorEpoch !== binding.sandbox.executorEpoch ||
		scope.host.instanceRef !== binding.host.instanceRef ||
		scope.host.startRef !== binding.host.startRef ||
		scope.host.configurationRevision !== binding.host.configurationRevision ||
		scope.host.imageDigest !== binding.host.imageDigest
	)
		return reject("stale_binding");
	if (scope.revoked) return reject("revoked");
	return { accepted: true };
}

/**
 * Append-only persistence (§18.5.1 载体与版本). `duplicate` is the same record delivered again;
 * `challenge_replay` is another record for an already used challenge; `evidence_conflict` is a
 * different record under an existing evidence ID; `revoked`/`stale_binding`/`scope_mismatch`
 * mean the store re-checked the committed original binding in its own write transaction and
 * found it changed since the scope was read. Only `recorded` stores anything.
 */
export interface RuntimeSafetyEvidenceStoreV1<
	TRecord extends RuntimeIsolationEvidenceAdmissibleV1,
> {
	recordOnce(record: TRecord): Promise<
		| "recorded"
		| "duplicate"
		| "challenge_replay"
		| "evidence_conflict"
		/** The original binding changed after the scope was read (#4358 S1). */
		| "revoked"
		| "stale_binding"
		| "scope_mismatch"
	>;
}

export class RuntimeSafetyEvidenceUnsupportedErrorV1 extends Error {
	readonly code = "RUNTIME_SAFETY_EVIDENCE_UNSUPPORTED";
	constructor() {
		super("Runtime safety evidence record is not understood by this reader");
	}
}

export interface RuntimeSafetyEvidenceIngestResultV1 {
	/** Cursor the Host may now treat as acknowledged; null when nothing advanced. */
	readonly ackCursor: string | null;
	readonly recorded: number;
	readonly duplicates: number;
	readonly rejected: readonly {
		readonly cursor: string;
		readonly reason: RuntimeSafetyEvidenceRejectionV1;
	}[];
	/**
	 * The batch stopped before an entry that stays unconfirmed in the Host log: a record the
	 * reader cannot parse, or one whose own original scope cannot be resolved yet.
	 */
	readonly stopped?: "unsupported" | "unresolved";
}

/**
 * Reads one Host evidence log batch in order. A record this reader cannot parse stops the
 * batch before its cursor (upgrade first, never drop fields). A record outside the window is
 * acknowledged without being stored. Inside the window each record is checked against its own
 * Execution's original scope; when that scope cannot be resolved the batch stops before it,
 * so nothing is confirmed that was never committed (HLD §8.5.6 step 4, #4367). A record whose
 * resolved scope does not match is acknowledged without being stored. Storage failures
 * propagate before the cursor advances, so the Host keeps the entry; business events are
 * never touched.
 */
export async function ingestRuntimeSafetyEvidenceBatchV1<
	TRecord extends RuntimeIsolationEvidenceAdmissibleV1,
>(input: {
	readonly entries: readonly {
		readonly cursor: string;
		readonly record: unknown;
	}[];
	/** Strict reader schema; undefined for a kind or shape this reader does not understand. */
	readonly parse: (record: unknown) => TRecord | undefined;
	readonly window: RuntimeSafetyEvidenceWindowV1 | undefined;
	/** The record's own Execution; undefined when it cannot be resolved (the batch stops). */
	readonly resolveScope: (
		record: TRecord,
	) => Promise<RuntimeSafetyEvidenceScopeV1 | undefined>;
	readonly store: RuntimeSafetyEvidenceStoreV1<TRecord>;
	readonly now: () => Date;
}): Promise<RuntimeSafetyEvidenceIngestResultV1> {
	let ackCursor: string | null = null;
	let recorded = 0;
	let duplicates = 0;
	const rejected: {
		cursor: string;
		reason: RuntimeSafetyEvidenceRejectionV1;
	}[] = [];
	let stopped: "unsupported" | "unresolved" | undefined;
	for (const entry of input.entries) {
		const record = input.parse(entry.record);
		if (record === undefined) {
			if (ackCursor === null)
				throw new RuntimeSafetyEvidenceUnsupportedErrorV1();
			stopped = "unsupported";
			break;
		}
		// Window, scenario and producer do not depend on the scope; they are final.
		const windowAdmission = admitIsolationEvidenceV1({
			record,
			window: input.window,
			scope: undefined,
			now: input.now(),
		});
		if (
			!windowAdmission.accepted &&
			windowAdmission.reason !== "scope_mismatch"
		) {
			rejected.push({ cursor: entry.cursor, reason: windowAdmission.reason });
			ackCursor = entry.cursor;
			continue;
		}
		const scope = await input.resolveScope(record);
		if (scope === undefined) {
			stopped = "unresolved";
			break;
		}
		const admission = admitIsolationEvidenceV1({
			record,
			window: input.window,
			scope,
			now: input.now(),
		});
		if (admission.accepted) {
			const outcome = await input.store.recordOnce(record);
			if (outcome === "recorded") recorded++;
			else if (outcome === "duplicate") duplicates++;
			else rejected.push({ cursor: entry.cursor, reason: outcome });
		} else rejected.push({ cursor: entry.cursor, reason: admission.reason });
		ackCursor = entry.cursor;
	}
	return {
		ackCursor,
		recorded,
		duplicates,
		rejected,
		...(stopped ? { stopped } : {}),
	};
}

/**
 * §18.5.1 读取 and §18.3: the necessary persistent audit of one evidence read by the original
 * subject. The principal is the server-resolved identity; the original scope is recorded only
 * once it is confirmed (a success). A rejection or failure records a fixed reason and never the
 * caller's references. The evidence body, its results, length and hash are never audited.
 */
export interface RuntimeSafetyEvidenceReadAuditV1 {
	readonly action: "runtime_evidence.read";
	readonly traceId: string;
	readonly requestId: string;
	readonly principal: {
		readonly kind: "user" | "application";
		readonly id: string;
	};
	readonly outcome: "succeeded" | "rejected" | "failed";
	readonly target: {
		readonly evidenceRef: string;
		readonly agentId: string;
		readonly conversationId: string;
		readonly executionId: string;
	} | null;
	readonly reason?: "RESOURCE_UNAVAILABLE" | "DEPENDENCY_UNAVAILABLE";
}

const nonEmpty = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= 256;

export function runtimeSafetyEvidenceReadAuditV1(
	input:
		| {
				readonly traceId: string;
				readonly requestId: string;
				readonly principal: RuntimeSafetyEvidenceReadAuditV1["principal"];
				readonly outcome: "succeeded";
				readonly target: NonNullable<
					RuntimeSafetyEvidenceReadAuditV1["target"]
				>;
		  }
		| {
				readonly traceId: string;
				readonly requestId: string;
				readonly principal: RuntimeSafetyEvidenceReadAuditV1["principal"];
				readonly outcome: "rejected" | "failed";
		  },
): RuntimeSafetyEvidenceReadAuditV1 {
	if (
		!nonEmpty(input.traceId) ||
		!nonEmpty(input.requestId) ||
		(input.principal?.kind !== "user" &&
			input.principal?.kind !== "application") ||
		!nonEmpty(input.principal.id)
	)
		throw new TypeError("Runtime safety evidence read audit is invalid");
	const common = {
		action: "runtime_evidence.read" as const,
		traceId: input.traceId,
		requestId: input.requestId,
		principal: { kind: input.principal.kind, id: input.principal.id },
	};
	if (input.outcome !== "succeeded")
		return {
			...common,
			outcome: input.outcome,
			target: null,
			reason:
				input.outcome === "rejected"
					? "RESOURCE_UNAVAILABLE"
					: "DEPENDENCY_UNAVAILABLE",
		};
	const target = (input as { readonly target?: unknown }).target as
		| Record<string, unknown>
		| undefined;
	if (
		!target ||
		!nonEmpty(target.evidenceRef) ||
		!nonEmpty(target.agentId) ||
		!nonEmpty(target.conversationId) ||
		!nonEmpty(target.executionId)
	)
		throw new TypeError("Runtime safety evidence read audit is invalid");
	return {
		...common,
		outcome: "succeeded",
		target: {
			evidenceRef: target.evidenceRef,
			agentId: target.agentId,
			conversationId: target.conversationId,
			executionId: target.executionId,
		},
	};
}
