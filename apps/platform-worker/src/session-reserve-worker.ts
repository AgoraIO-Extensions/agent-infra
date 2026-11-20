import { randomUUID } from "node:crypto";
import type { ExecutorInstanceMutationV2 } from "@agent-infra/contracts/runtime";
import {
	parseSessionSandboxReserveConfigurationV1,
	type SessionSandboxInstanceEvidenceV1,
	type SessionSandboxReserveConfigurationV1,
	type SessionSandboxReserveOperationInputV1,
	type SessionSandboxReserveOperationV1,
	type SessionSandboxReserveResourceKindV1,
	type SessionSandboxResourceIdentityV1,
	sessionSandboxReserveExecutorSettledV1,
	sessionSandboxReserveResourceKindsV1,
} from "@agent-infra/platform-core";
import {
	PostgresSessionSandboxReserveStoreV1,
	type SessionSandboxReserveWorkerClaimV1,
} from "@agent-infra/platform-store";
import type { KubernetesObject } from "@kubernetes/client-node";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import type { SessionSandboxReserveObservationV1 } from "./session-reserve-adapter.js";

type Claim = SessionSandboxReserveWorkerClaimV1;
type Kind = SessionSandboxReserveResourceKindV1;
type Operation = SessionSandboxReserveOperationV1;
export type SessionReserveStoreV1 = Pick<
	PostgresSessionSandboxReserveStoreV1,
	| "list"
	| "listPage"
	| "inspect"
	| "refreshReady"
	| "applyConfiguration"
	| "reconcileCapacity"
	| "claimLease"
	| "renewLease"
	| "recordIntent"
	| "recordObservation"
	| "recordCreateResponse"
	| "recordResult"
	| "recordDeleteResponse"
	| "recordDeleteObservation"
	| "markReady"
	| "retire"
	| "finishRetirement"
	| "close"
>;
export type SessionReserveExecutorStoreV1 = Pick<
	PostgresSessionSandboxReserveStoreV1,
	| "transitionExecutorReserveInstanceV2"
	| "recordExecutorProjectionIntent"
	| "recordExecutorProjectionCreateResponse"
	| "recordExecutorProjectionResult"
	| "recordExecutorConsumption"
	| "recordExecutorProjectionDeleteIntent"
	| "recordExecutorProjectionDeleteResponse"
	| "recordExecutorProjectionDeleteObservation"
>;
export interface SessionReserveExecutorAdapterV1 {
	startup(
		claim: Claim,
	): Promise<Extract<ExecutorInstanceMutationV2, { kind: "prepare" }> | null>;
	projection(
		claim: Claim,
		pod: KubernetesObject,
	): Promise<{
		intent: Parameters<
			PostgresSessionSandboxReserveStoreV1["recordExecutorProjectionIntent"]
		>[1];
		resource: KubernetesObject;
	}>;
	readProjection(
		claim: SessionSandboxReserveObservationV1,
		signal?: AbortSignal,
	): Promise<KubernetesObject | null>;
	createProjection(
		claim: Claim,
		resource: KubernetesObject,
		signal?: AbortSignal,
	): Promise<KubernetesObject>;
	removeProjection(
		claim: Claim,
		resource: SessionSandboxResourceIdentityV1,
		signal?: AbortSignal,
	): Promise<"acknowledged" | "absent">;
	readInstance(
		claim: SessionSandboxReserveObservationV1,
		resources: readonly KubernetesObject[],
		signal?: AbortSignal,
	): Promise<SessionSandboxInstanceEvidenceV1 | null>;
}
/** The adapter verifies current resource ownership/spec and never retries mutations. */
export interface SessionReserveAdapterV1 {
	/** Preparation seam only; the production adapter's Codex admission guard stays closed. */
	readonly executor?: SessionReserveExecutorAdapterV1;
	render(claim: Claim): Promise<readonly KubernetesObject[]>;
	read(
		claim: SessionSandboxReserveObservationV1,
		kind: Kind,
		signal?: AbortSignal,
	): Promise<KubernetesObject | null>;
	create(
		claim: Claim,
		resource: KubernetesObject,
		signal?: AbortSignal,
	): Promise<KubernetesObject>;
	remove(
		claim: Claim,
		resource: SessionSandboxResourceIdentityV1,
		signal?: AbortSignal,
	): Promise<"acknowledged" | "absent">;
	bootstrap(
		claim: SessionSandboxReserveObservationV1,
		resources: readonly KubernetesObject[],
		signal?: AbortSignal,
	): Promise<{
		bootstrapReady: boolean;
		businessStateAbsent: boolean;
		instanceEvidence?: SessionSandboxInstanceEvidenceV1;
	}>;
	/**
	 * False when the reserve would deliver a startup-selected Consumer snapshot to an Agent
	 * that now has a persistent association (Spec §13.5.7). Throws when the source is
	 * unavailable. Absent means the deployment selected no such Consumer.
	 */
	deliverable?(claim: SessionSandboxReserveObservationV1): Promise<boolean>;
}
export interface SessionReserveReconcileResultV1 {
	prepared: number;
	ready: number;
	retired: number;
	unavailable: number;
}
const creationOrder: readonly Kind[] = [
	"PersistentVolumeClaim",
	"ServiceAccount",
	"NetworkPolicy",
	"Service",
	"Secret",
	"Pod",
];
const deletionOrder: readonly Kind[] = [
	"Pod",
	"Service",
	"Secret",
	"NetworkPolicy",
	"ServiceAccount",
	"PersistentVolumeClaim",
];
const emptyResult = (): SessionReserveReconcileResultV1 => ({
	prepared: 0,
	ready: 0,
	retired: 0,
	unavailable: 0,
});
class LeaseLost extends Error {}
function identity(
	claim: Claim,
	object: KubernetesObject,
): SessionSandboxResourceIdentityV1 {
	const { kind, metadata } = object;
	if (
		!sessionSandboxReserveResourceKindsV1.includes(kind as Kind) ||
		metadata?.name !== `sandbox-${claim.sandboxId}` ||
		metadata.namespace !== claim.profile.policy.namespace ||
		!metadata.uid ||
		!metadata.resourceVersion
	)
		throw new WorkloadKubernetesError("conflict");
	return {
		kind: kind as Kind,
		name: metadata.name,
		namespace: metadata.namespace,
		uid: metadata.uid,
		resourceVersion: metadata.resourceVersion,
	};
}
function definiteCreateRejection(error: unknown) {
	return (
		error instanceof WorkloadKubernetesError &&
		error.details.verb === "create" &&
		[400, 401, 403, 404, 405, 413, 415, 422].includes(error.details.status ?? 0)
	);
}
function definiteDeleteRejection(error: unknown) {
	return (
		error instanceof WorkloadKubernetesError &&
		error.details.verb === "delete" &&
		error.details.status === 409
	);
}
function input(operation: Operation): SessionSandboxReserveOperationInputV1 {
	const { writeCompletion: _completion, writer: _writer, ...value } = operation;
	return value;
}

/** Reconciles reserves only. Business admission stays in the original Conversation transaction. */
export function createPlatformSessionReserveWorkerV1(options: {
	readonly databaseUrl: string;
	readonly configuration: SessionSandboxReserveConfigurationV1;
	readonly adapter: SessionReserveAdapterV1;
	readonly store?: SessionReserveStoreV1 &
		Partial<SessionReserveExecutorStoreV1>;
	readonly workerId?: string;
	readonly pollIntervalMs?: number;
	readonly leaseDurationMs?: number;
	readonly now?: () => number;
	readonly signal?: AbortSignal;
	readonly log?: (code: "SESSION_RESERVE_RECONCILE_UNAVAILABLE") => void;
}) {
	const configuration = parseSessionSandboxReserveConfigurationV1(
		options.configuration,
	);
	const workerId = options.workerId ?? randomUUID();
	const pollIntervalMs = options.pollIntervalMs ?? 1_000;
	const leaseDurationMs = options.leaseDurationMs ?? 30_000;
	if (
		!workerId ||
		workerId.includes("\0") ||
		!Number.isSafeInteger(pollIntervalMs) ||
		pollIntervalMs < 1 ||
		pollIntervalMs > 30_000 ||
		!Number.isSafeInteger(leaseDurationMs) ||
		leaseDurationMs < 100 ||
		leaseDurationMs > 300_000
	)
		throw new TypeError("Session reserve Worker options are invalid");
	const store =
		options.store ??
		new PostgresSessionSandboxReserveStoreV1({
			databaseUrl: options.databaseUrl,
			configuration,
		});
	const adapter = options.adapter;
	const executorStore = (): SessionReserveExecutorStoreV1 => {
		const candidate = store as SessionReserveStoreV1 &
			Partial<SessionReserveExecutorStoreV1>;
		for (const name of [
			"transitionExecutorReserveInstanceV2",
			"recordExecutorProjectionIntent",
			"recordExecutorProjectionCreateResponse",
			"recordExecutorProjectionResult",
			"recordExecutorConsumption",
			"recordExecutorProjectionDeleteIntent",
			"recordExecutorProjectionDeleteResponse",
			"recordExecutorProjectionDeleteObservation",
		] as const)
			if (typeof candidate[name] !== "function")
				throw new WorkloadKubernetesError("policy");
		return candidate as SessionReserveStoreV1 & SessionReserveExecutorStoreV1;
	};
	const now = options.now ?? Date.now;
	const abortController = new AbortController();
	let stopped = false;
	let started = false;
	let pending: Promise<SessionReserveReconcileResultV1> | undefined;
	let closing: Promise<void> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let profileCursor = 0;
	let configurationApplied = false;
	const backoff = new Map<string, number>();
	const report = () => {
		try {
			options.log?.("SESSION_RESERVE_RECONCILE_UNAVAILABLE");
		} catch {
			/* Diagnostics do not affect durable state. */
		}
	};
	const defer = (key: string) =>
		backoff.set(
			key,
			now() + Math.max(configuration.failureBackoffMs, pollIntervalMs),
		);
	async function ensureConfiguration() {
		if (configurationApplied) return;
		await store.applyConfiguration();
		configurationApplied = true;
	}
	async function withLease(
		claim: Claim,
		action: (guard: () => Promise<void>) => Promise<void>,
	) {
		let active = true;
		let heartbeat: Promise<void> | undefined;
		async function renew() {
			if (stopped || !active) throw new LeaseLost();
			if (!(await store.renewLease(claim, leaseDurationMs))) {
				active = false;
				throw new LeaseLost();
			}
			if (stopped || !active) throw new LeaseLost();
		}
		const interval = setInterval(
			() => {
				if (heartbeat || stopped || !active) return;
				heartbeat = renew()
					.catch(() => {
						active = false;
					})
					.finally(() => {
						heartbeat = undefined;
					});
			},
			Math.max(1, Math.floor(leaseDurationMs / 3)),
		);
		interval.unref?.();
		try {
			await renew();
			await action(renew);
		} finally {
			clearInterval(interval);
			await heartbeat;
		}
	}
	async function retire(claim: Claim) {
		if (!stopped) await store.retire(claim.sandboxId);
	}
	async function reload(claim: Claim): Promise<Claim> {
		const snapshot = await store.inspect(claim.sandboxId);
		if (
			!snapshot ||
			snapshot.status === "claimed" ||
			snapshot.profile.digest !== claim.profile.digest ||
			snapshot.sessionId !== claim.sessionId ||
			snapshot.agentId !== claim.agentId ||
			(snapshot.status !== "retiring" &&
				snapshot.currentProfileDigest !== claim.profile.digest)
		)
			throw new LeaseLost();
		return { ...claim, ...snapshot };
	}
	async function prepareProjection(
		initialClaim: Claim,
		resources: readonly KubernetesObject[],
		guard: () => Promise<void>,
	): Promise<Claim | null> {
		let claim = initialClaim;
		if (!claim.executorStartup) return claim;
		const port = adapter.executor;
		if (!port) throw new WorkloadKubernetesError("policy");
		const writes = executorStore();
		claim = await reload(claim);
		let startup = claim.executorStartup;
		if (!startup?.instance) throw new WorkloadKubernetesError("policy");
		if (!startup.consumption && now() >= startup.deadlineMs) {
			await retire(claim);
			return null;
		}
		if (startup.instance.phase === "pod-pending") {
			const pod = resources.find((r) => r.kind === "Pod");
			const service = resources.find((r) => r.kind === "Service");
			if (!pod || !service) throw new WorkloadKubernetesError("conflict");
			await guard();
			const bound = await writes.transitionExecutorReserveInstanceV2(claim, {
				kind: "bind",
				attemptId: startup.instance.attemptId,
				revision: startup.instance.revision,
				podUid: identity(claim, pod).uid,
				resources: [identity(claim, pod), identity(claim, service)].map(
					(r) => ({ ...r, kind: r.kind as "Pod" | "Service" }),
				),
			});
			if (!bound) throw new LeaseLost();
			claim = await reload(claim);
			startup = claim.executorStartup;
		}
		if (!startup) throw new LeaseLost();
		if (!startup.projection) {
			const pod = resources.find((r) => r.kind === "Pod");
			if (!pod || startup.instance?.phase !== "bound") return null;
			if (await port.readProjection(claim, abortController.signal))
				throw new WorkloadKubernetesError("conflict");
			const publication = await port.projection(claim, pod);
			await guard();
			if (
				!(await writes.recordExecutorProjectionIntent(
					claim,
					publication.intent,
				))
			)
				throw new LeaseLost();
			claim = await reload(claim);
			await guard();
			try {
				const created = await port.createProjection(
					claim,
					publication.resource,
					abortController.signal,
				);
				if (
					!(await writes.recordExecutorProjectionCreateResponse(claim, {
						attemptId: publication.intent.attemptId,
						response: "created",
						resource: projectionIdentity(claim, created),
					}))
				)
					throw new LeaseLost();
			} catch (error) {
				if (error instanceof LeaseLost) throw error;
				if (definiteCreateRejection(error)) {
					await writes.recordExecutorProjectionCreateResponse(claim, {
						attemptId: publication.intent.attemptId,
						response: "rejected",
						resource: null,
					});
					await retire(claim);
				} else
					await writes.recordExecutorProjectionResult(claim, {
						attemptId: publication.intent.attemptId,
					});
				throw error;
			}
			claim = await reload(claim);
			startup = claim.executorStartup;
		}
		const projection = startup?.projection;
		if (!projection || projection.create.writeCompletion !== "response") {
			await port.readProjection(claim, abortController.signal);
			return null;
		}
		if (projection.create.status === "rejected") {
			await retire(claim);
			return null;
		}
		if (!startup?.consumption) {
			await guard();
			const proof = await port.readInstance(
				claim,
				resources,
				abortController.signal,
			);
			if (!proof) return null;
			await guard();
			if (
				!(await writes.recordExecutorConsumption(claim, {
					attemptId: projection.create.attemptId,
					podUid: proof.podUid,
					hostKeyId: proof.hostKeyId,
					runnerEpoch: proof.runnerEpoch,
					projectionUid: projection.create.resource?.uid ?? "",
					evidence: proof,
				}))
			)
				return null;
			claim = await reload(claim);
		}
		if (!(await cleanProjection(claim, guard))) return null;
		return reload(claim);
	}
	function projectionIdentity(
		claim: Claim,
		object: KubernetesObject,
	): SessionSandboxResourceIdentityV1 {
		const metadata = object.metadata;
		if (
			!claim.executorStartup?.startupRef ||
			object.kind !== "Secret" ||
			metadata?.namespace !== claim.profile.policy.namespace ||
			metadata.name !== claim.executorStartup?.startupRef ||
			!metadata.uid ||
			!metadata.resourceVersion
		)
			throw new WorkloadKubernetesError("conflict");
		return {
			kind: "Secret",
			name: metadata.name,
			namespace: claim.profile.policy.namespace,
			uid: metadata.uid,
			resourceVersion: metadata.resourceVersion,
		};
	}
	/** The temporary projection settles before any of the six long-lived resources are touched. */
	async function cleanProjection(
		initialClaim: Claim,
		guard: () => Promise<void>,
	): Promise<boolean> {
		let claim = initialClaim;
		const startup = claim.executorStartup;
		if (!startup) return true;
		if (!adapter.executor) throw new WorkloadKubernetesError("policy");
		const writes = executorStore();
		await guard();
		const object = await adapter.executor.readProjection(
			claim,
			abortController.signal,
		);
		await guard();
		const projection = startup.projection;
		if (!projection) {
			if (object) throw new WorkloadKubernetesError("conflict");
			return !startup.instance?.delivery;
		}
		const create = projection.create;
		if (
			object &&
			create.resource?.uid &&
			object.metadata?.uid !== create.resource.uid
		)
			throw new WorkloadKubernetesError("conflict");
		// A GET is never the response to the original create. In particular, no new key or write is issued.
		if (create.writeCompletion !== "response") return false;
		if (create.status === "rejected") {
			if (object) throw new WorkloadKubernetesError("conflict");
			return true;
		}
		if (create.status !== "confirmed" || !create.resource) return false;
		const deletion = projection.deletes.at(-1);
		if (deletion?.absent) {
			if (object) throw new WorkloadKubernetesError("conflict");
			return sessionSandboxReserveExecutorSettledV1(startup);
		}
		if (deletion?.writeCompletion === "pending") return false;
		if (deletion && !object) {
			return writes.recordExecutorProjectionDeleteObservation(claim, {
				attemptId: deletion.attemptId,
			});
		}
		if (deletion?.status === "confirmed") return false;
		if (
			deletion &&
			(projection.deletes.length >= 3 ||
				deletion.resource?.resourceVersion ===
					object?.metadata?.resourceVersion)
		)
			return false;
		const resource = object
			? projectionIdentity(claim, object)
			: create.resource;
		const attemptId = randomUUID();
		await guard();
		if (
			!(await writes.recordExecutorProjectionDeleteIntent(claim, {
				attemptId,
				resource,
			}))
		)
			throw new LeaseLost();
		claim = await reload(claim);
		try {
			const response = await adapter.executor.removeProjection(
				claim,
				resource,
				abortController.signal,
			);
			if (
				!(await writes.recordExecutorProjectionDeleteResponse(claim, {
					attemptId,
					response,
				}))
			)
				throw new LeaseLost();
		} catch (error) {
			if (error instanceof LeaseLost) throw error;
			if (definiteDeleteRejection(error))
				await writes.recordExecutorProjectionDeleteResponse(claim, {
					attemptId,
					response: "rejected",
				});
			else await writes.recordExecutorProjectionResult(claim, { attemptId });
			throw error;
		}
		await guard();
		if (await adapter.executor.readProjection(claim, abortController.signal))
			return false;
		await guard();
		const inspection = await store.inspect(claim.sandboxId);
		const recorded = inspection?.executorStartup?.projection?.deletes.at(-1);
		if (!recorded || recorded.attemptId !== attemptId) throw new LeaseLost();
		return (
			recorded.absent ||
			writes.recordExecutorProjectionDeleteObservation(claim, { attemptId })
		);
	}
	async function prepare(
		initialClaim: Claim,
		result: SessionReserveReconcileResultV1,
		guard: () => Promise<void>,
	) {
		let claim = initialClaim;
		// Retire before any write: nothing was created for this reserve with the old Consumer.
		// Backing off the Agent stops capacity reconciliation from recreating it every poll.
		if (adapter.deliverable && !(await adapter.deliverable(claim))) {
			defer(claim.agentId);
			await retire(claim);
			return;
		}
		const startupPlan = await adapter.executor?.startup(claim);
		if (startupPlan) {
			await guard();
			if (
				!(await executorStore().transitionExecutorReserveInstanceV2(
					claim,
					startupPlan,
				))
			)
				throw new LeaseLost();
			claim = await reload(claim);
		} else if (claim.executorStartup)
			throw new WorkloadKubernetesError("policy");
		const rendered = await adapter.render(claim);
		if (
			rendered.length !== creationOrder.length ||
			new Set(rendered.map((r) => r.kind)).size !== creationOrder.length ||
			creationOrder.some((kind) => !rendered.some((r) => r.kind === kind))
		)
			throw new WorkloadKubernetesError("policy");
		const operations = [...claim.operations];
		const observed: KubernetesObject[] = [];
		for (const kind of creationOrder) {
			await guard();
			if (
				claim.executorStartup &&
				!claim.executorStartup.consumption &&
				now() >= claim.executorStartup.deadlineMs
			) {
				await retire(claim);
				return;
			}
			const prior = operations.find(
				(operation) =>
					operation.kind === kind && operation.operation === "create",
			);
			if (prior?.status === "rejected") {
				await retire(claim);
				return;
			}
			let object: KubernetesObject | null;
			if (prior) {
				object = await adapter.read(claim, kind, abortController.signal);
				if (
					object &&
					!(await store.recordObservation(claim, identity(claim, object)))
				)
					throw new LeaseLost();
				if (
					prior.writeCompletion !== "response" ||
					prior.status !== "confirmed"
				)
					return;
				operations[operations.indexOf(prior)] = {
					...prior,
					resource: object ? identity(claim, object) : prior.resource,
				};
				if (!object) {
					await retire(claim);
					return;
				}
			} else {
				if (claim.status === "unknown") return;
				if (await adapter.read(claim, kind, abortController.signal))
					throw new WorkloadKubernetesError("conflict");
				const operation: SessionSandboxReserveOperationInputV1 = {
					attemptId: randomUUID(),
					operation: "create",
					kind,
					name: `sandbox-${claim.sandboxId}`,
					status: "pending",
					resource: null,
					absent: false,
				};
				await guard();
				if (kind === "Pod" && claim.executorStartup?.instance) {
					const instance = claim.executorStartup.instance;
					const pending =
						await executorStore().transitionExecutorReserveInstanceV2(
							claim,
							{
								kind: "pod-create",
								attemptId: instance.attemptId,
								revision: instance.revision,
							},
							operation,
						);
					if (!pending?.permit) throw new LeaseLost();
					claim = await reload(claim);
				} else if (!(await store.recordIntent(claim, operation)))
					throw new LeaseLost();
				if (stopped) return;
				const desired = rendered.find((resource) => resource.kind === kind);
				if (!desired) throw new WorkloadKubernetesError("policy");
				try {
					object = await adapter.create(claim, desired, abortController.signal);
				} catch (error) {
					if (definiteCreateRejection(error)) {
						await store.recordCreateResponse(claim, {
							attemptId: operation.attemptId,
							response: "rejected",
							resource: null,
						});
						await retire(claim);
					} else
						await store.recordResult(claim, {
							...operation,
							status: "unknown",
						});
					throw error;
				}
				const resource = identity(claim, object);
				// Late original responses close only that write; they never authorize more resource writes.
				if (
					!(await store.recordCreateResponse(claim, {
						attemptId: operation.attemptId,
						response: "created",
						resource,
					}))
				)
					throw new LeaseLost();
				operations.push({
					...operation,
					status: "confirmed",
					resource,
					writeCompletion: "response",
					writer: { owner: claim.leaseOwner, fence: claim.deliveryFence },
				});
			}
			observed.push(object);
		}
		const prepared = await prepareProjection(
			{ ...claim, operations },
			observed,
			guard,
		);
		if (!prepared) return;
		claim = prepared;
		await guard();
		const evidence = await adapter.bootstrap(
			{ ...claim, operations },
			observed,
			abortController.signal,
		);
		await guard();
		if (!evidence.bootstrapReady || !evidence.businessStateAbsent) {
			// Association may arrive during preparation; such a reserve is removed, never readied.
			if (adapter.deliverable && !(await adapter.deliverable(claim))) {
				defer(claim.agentId);
				await retire(claim);
			}
			return;
		}
		// Bind the accepted readiness receipt to current GET versions, including status changes after CREATE.
		for (const kind of creationOrder) {
			await guard();
			const current = await adapter.read(claim, kind, abortController.signal);
			if (!current) {
				await retire(claim);
				return;
			}
			if (!(await store.recordObservation(claim, identity(claim, current))))
				throw new LeaseLost();
		}
		await guard();
		// The readiness reads above await; recheck the current source last so an association
		// written during them never readies the reserve. A source error leaves it not ready.
		if (adapter.deliverable && !(await adapter.deliverable(claim))) {
			defer(claim.agentId);
			await retire(claim);
			return;
		}
		// markReady itself checks the lease, so the source check stays the last await before it.
		if (await store.markReady(claim, evidence)) result.ready++;
	}
	async function observeUnknown(claim: Claim, guard: () => Promise<void>) {
		// Inspect every original attempt, not just the first successful resource preceding the unknown call.
		for (const operation of claim.operations) {
			if (operation.operation !== "create" || operation.status === "rejected")
				continue;
			await guard();
			const current = await adapter.read(
				claim,
				operation.kind,
				abortController.signal,
			);
			if (
				current &&
				!(await store.recordObservation(claim, identity(claim, current)))
			)
				throw new LeaseLost();
		}
		if (claim.executorStartup) {
			if (!adapter.executor) throw new WorkloadKubernetesError("policy");
			await guard();
			await adapter.executor.readProjection(claim, abortController.signal);
		}
		// An uncertain reserve is not promoted. Once all original writes settle it can be retired safely.
		if (
			claim.operations.every(
				(operation) => operation.writeCompletion === "response",
			) &&
			sessionSandboxReserveExecutorSettledV1(claim.executorStartup)
		)
			await retire(claim);
	}
	async function inspectReady(
		row: Awaited<
			ReturnType<PostgresSessionSandboxReserveStoreV1["list"]>
		>[number],
		result: SessionReserveReconcileResultV1,
	) {
		if (row.status !== "ready") return;
		const inspection = await store.inspect(row.sandboxId);
		if (
			inspection?.status === "ready" &&
			inspection.currentProfileDigest === row.profileDigest &&
			inspection.deployment &&
			inspection.modelProjection
		) {
			try {
				// A ready reserve carrying a startup-selected Consumer for an Agent that is now
				// associated is retired, so no business Session adopts it.
				if (adapter.deliverable && !(await adapter.deliverable(inspection))) {
					defer(row.agentId);
					if (await store.retire(row.sandboxId)) result.retired++;
					return;
				}
				const observed: KubernetesObject[] = [];
				for (const kind of creationOrder) {
					const current = await adapter.read(
						inspection,
						kind,
						abortController.signal,
					);
					if (!current) {
						if (await store.retire(row.sandboxId)) result.retired++;
						return;
					}
					observed.push(current);
				}
				const instance = inspection.executorStartup
					? await adapter.bootstrap(
							inspection,
							observed,
							abortController.signal,
						)
					: null;
				if (
					inspection.executorStartup &&
					(!instance?.bootstrapReady ||
						!instance.businessStateAbsent ||
						!instance.instanceEvidence ||
						!inspection.readFence)
				) {
					if (await store.retire(row.sandboxId)) result.retired++;
					return;
				}
				// Recheck after the awaited reads, immediately before extending readiness.
				if (adapter.deliverable && !(await adapter.deliverable(inspection))) {
					defer(row.agentId);
					if (await store.retire(row.sandboxId)) result.retired++;
					return;
				}
				const refreshed =
					instance?.instanceEvidence && inspection.readFence
						? await store.refreshReady(row.sandboxId, configuration.ttlMs, {
								readFence: inspection.readFence,
								instanceEvidence: instance.instanceEvidence,
							})
						: await store.refreshReady(row.sandboxId, configuration.ttlMs);
				if (!refreshed) {
					if (await store.retire(row.sandboxId)) result.retired++;
				}
			} catch {
				if (await store.retire(row.sandboxId)) result.retired++;
			}
			return;
		}
		if (await store.retire(row.sandboxId)) result.retired++;
	}
	async function clean(
		claim: Claim,
		result: SessionReserveReconcileResultV1,
		guard: () => Promise<void>,
	) {
		if (claim.status !== "retiring") return;
		if (!(await cleanProjection(claim, guard))) return;
		for (const kind of deletionOrder) {
			await guard();
			const create = claim.operations.find(
				(operation) =>
					operation.kind === kind && operation.operation === "create",
			);
			const object = await adapter.read(claim, kind, abortController.signal);
			if (!create) {
				if (object) throw new WorkloadKubernetesError("conflict");
				continue;
			}
			if (
				create.writeCompletion !== "response" ||
				create.status === "pending" ||
				create.status === "unknown"
			) {
				if (object)
					await store.recordObservation(claim, identity(claim, object));
				return;
			}
			if (create.status === "rejected") {
				if (object) throw new WorkloadKubernetesError("conflict");
				continue;
			}
			if (!create.resource) throw new WorkloadKubernetesError("conflict");
			let deletion = claim.operations.findLast(
				(operation) =>
					operation.kind === kind && operation.operation === "delete",
			);
			if (object && object.metadata?.uid !== create.resource.uid)
				throw new WorkloadKubernetesError("conflict");
			if (deletion?.status === "confirmed") {
				if (deletion.absent) {
					if (object) throw new WorkloadKubernetesError("conflict");
					continue;
				}
				if (!object) {
					await guard();
					if (
						!(await store.recordDeleteObservation(claim, {
							attemptId: deletion.attemptId,
						}))
					)
						throw new LeaseLost();
					continue;
				}
				return;
			}
			if (deletion?.status === "unknown" || deletion?.status === "pending") {
				// An existing DELETE intent may already have reached the provider. Never resend it.
				return;
			}
			let deleteResource = create.resource;
			if (deletion?.status === "rejected") {
				if (!object) {
					await guard();
					if (
						!(await store.recordDeleteObservation(claim, {
							attemptId: deletion.attemptId,
						}))
					)
						throw new LeaseLost();
					continue;
				}
				if (
					claim.operations.filter(
						(operation) =>
							operation.operation === "delete" &&
							operation.kind === kind &&
							operation.status === "rejected",
					).length >= 3
				)
					throw new WorkloadKubernetesError("conflict");
				deleteResource = identity(claim, object);
				await guard();
				if (!(await store.recordObservation(claim, deleteResource)))
					throw new LeaseLost();
				deletion = undefined;
			}
			if (!deletion) {
				const resource = object ? identity(claim, object) : deleteResource;
				if (object && !(await store.recordObservation(claim, resource)))
					throw new LeaseLost();
				const intent: SessionSandboxReserveOperationInputV1 = {
					attemptId: randomUUID(),
					operation: "delete",
					kind,
					name: resource.name,
					status: "pending",
					resource,
					absent: false,
				};
				await guard();
				if (!(await store.recordIntent(claim, intent))) throw new LeaseLost();
				deletion = {
					...intent,
					writeCompletion: "pending",
					writer: { owner: claim.leaseOwner, fence: claim.deliveryFence },
				};
			}
			if (!deletion.resource) throw new WorkloadKubernetesError("conflict");
			if (
				object &&
				object.metadata?.resourceVersion !== deletion.resource.resourceVersion
			)
				throw new WorkloadKubernetesError("conflict");
			let deleteResponse: "acknowledged" | "absent" | undefined;
			await guard();
			try {
				const response = await adapter.remove(
					claim,
					deletion.resource,
					abortController.signal,
				);
				deleteResponse = response;
				if (
					!(await store.recordDeleteResponse(claim, {
						attemptId: deletion.attemptId,
						response,
						resource: deletion.resource,
					}))
				)
					throw new LeaseLost();
			} catch (error) {
				if (error instanceof LeaseLost) throw error;
				if (definiteDeleteRejection(error)) {
					if (
						!(await store.recordDeleteResponse(claim, {
							attemptId: deletion.attemptId,
							response: "rejected",
							resource: deletion.resource,
						}))
					)
						throw new LeaseLost();
				} else if (
					!(await store.recordResult(claim, {
						...input(deletion),
						status: "unknown",
					}))
				)
					throw new LeaseLost();
				throw error;
			}
			await guard();
			if (!(await adapter.read(claim, kind, abortController.signal))) {
				if (deleteResponse !== "absent") {
					if (
						!(await store.recordDeleteObservation(claim, {
							attemptId: deletion.attemptId,
						}))
					)
						throw new LeaseLost();
				}
				await guard();
				continue;
			}
			return;
		}
		await guard();
		if (await store.finishRetirement(claim)) result.retired++;
	}
	async function run(): Promise<SessionReserveReconcileResultV1> {
		const result = emptyResult();
		await ensureConfiguration();
		const rows = await store.list();
		for (const row of rows) {
			if (stopped) break;
			if ((backoff.get(row.sandboxId) ?? 0) > now()) continue;
			const approved = configuration.profiles.find(
				(profile) => profile.agentId === row.agentId,
			);
			try {
				if (
					(!configuration.enabled ||
						!approved ||
						row.expiresAt.getTime() <= now()) &&
					row.status !== "retiring"
				) {
					if (!(await store.retire(row.sandboxId))) continue;
				} else if (row.status === "claimed") continue;
				else if (row.status === "ready") {
					await inspectReady(row, result);
					continue;
				}
				const claim = await store.claimLease({
					sandboxId: row.sandboxId,
					workerId,
					leaseDurationMs,
				});
				if (!claim || stopped) continue;
				await withLease(claim, (guard) =>
					claim.status === "retiring"
						? clean(claim, result, guard)
						: claim.status === "unknown"
							? observeUnknown(claim, guard)
							: prepare(claim, result, guard),
				);
			} catch (error) {
				if (!(error instanceof LeaseLost) && !stopped) {
					result.unavailable++;
					defer(row.sandboxId);
					report();
				}
			}
		}
		if (stopped || !configuration.enabled || !configuration.profiles.length)
			return result;
		const profiles = configuration.profiles;
		for (let offset = 0; offset < profiles.length; offset++) {
			const profile = profiles[(profileCursor + offset) % profiles.length];
			if (!profile || stopped) break;
			if ((backoff.get(profile.agentId) ?? 0) > now()) continue;
			while (result.prepared < configuration.maximumConcurrentCreates) {
				try {
					const capacity = await store.reconcileCapacity(profile.agentId);
					result.prepared += capacity.prepared;
					result.retired += capacity.retired;
					if (!capacity.prepared) break;
				} catch {
					result.unavailable++;
					defer(profile.agentId);
					report();
					break;
				}
			}
			if (result.prepared >= configuration.maximumConcurrentCreates) break;
		}
		profileCursor = (profileCursor + 1) % profiles.length;
		return result;
	}
	function reconcile(): Promise<SessionReserveReconcileResultV1> {
		if (stopped) return Promise.resolve(emptyResult());
		if (pending) return pending;
		pending = run()
			.catch(() => {
				if (!stopped) report();
				return { ...emptyResult(), unavailable: 1 };
			})
			.finally(() => {
				pending = undefined;
			});
		return pending;
	}
	function start() {
		if (stopped || started) return;
		started = true;
		const tick = async () => {
			await reconcile();
			if (!stopped) {
				timer = setTimeout(tick, pollIntervalMs);
				timer.unref?.();
			}
		};
		timer = setTimeout(tick, 0);
		timer.unref?.();
	}
	function stop(): Promise<void> {
		if (closing) return closing;
		stopped = true;
		abortController.abort();
		if (timer) clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		closing = (async () => {
			try {
				await pending;
			} finally {
				await store.close();
			}
		})();
		return closing;
	}
	const abort = () => {
		void stop();
	};
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) void stop();
	return { reconcile, start, stop, close: stop };
}
