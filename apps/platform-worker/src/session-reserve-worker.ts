import { randomUUID } from "node:crypto";
import {
	parseSessionSandboxReserveConfigurationV1,
	type SessionSandboxReserveConfigurationV1,
	type SessionSandboxReserveOperationInputV1,
	type SessionSandboxReserveOperationV1,
	type SessionSandboxReserveResourceKindV1,
	type SessionSandboxResourceIdentityV1,
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
	| "statistics"
	| "applyConfiguration"
	| "prepare"
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
/** The adapter verifies current resource ownership/spec and never retries mutations. */
export interface SessionReserveAdapterV1 {
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
	): Promise<{ bootstrapReady: boolean; businessStateAbsent: boolean }>;
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
	readonly store?: SessionReserveStoreV1;
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
	async function prepare(
		claim: Claim,
		result: SessionReserveReconcileResultV1,
		guard: () => Promise<void>,
	) {
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
				if (!(await store.recordIntent(claim, operation)))
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
		await guard();
		const evidence = await adapter.bootstrap(
			{ ...claim, operations },
			observed,
			abortController.signal,
		);
		await guard();
		if (!evidence.bootstrapReady || !evidence.businessStateAbsent) return;
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
		// An uncertain reserve is not promoted. Once all original writes settle it can be retired safely.
		if (
			claim.operations.every(
				(operation) => operation.writeCompletion === "response",
			)
		)
			await retire(claim);
	}
	async function inspectReady(
		row: Awaited<
			ReturnType<PostgresSessionSandboxReserveStoreV1["list"]>
		>[number],
		result: SessionReserveReconcileResultV1,
	) {
		const inspection = await store.inspect(row.sandboxId);
		if (
			inspection?.status !== "ready" ||
			inspection.currentProfileDigest !== row.profileDigest ||
			!inspection.deployment ||
			!inspection.modelProjection
		) {
			if (await store.retire(row.sandboxId)) result.retired++;
			return;
		}
		try {
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
			}
		} catch {
			if (await store.retire(row.sandboxId)) result.retired++;
		}
	}
	async function clean(
		claim: Claim,
		result: SessionReserveReconcileResultV1,
		guard: () => Promise<void>,
	) {
		if (claim.status !== "retiring") return;
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
			let deletion = claim.operations.find(
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
			if (deletion?.status === "unknown") {
				// The original DELETE has no terminal response. A GET cannot close it.
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
				await guard();
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
		const current = await store.list();
		let statistics:
			| Awaited<ReturnType<PostgresSessionSandboxReserveStoreV1["statistics"]>>
			| undefined;
		try {
			statistics = await store.statistics({ windowMs: 60_000 });
		} catch {
			report();
		}
		const profiles = configuration.profiles;
		for (let offset = 0; offset < profiles.length; offset++) {
			const profile = profiles[(profileCursor + offset) % profiles.length];
			if (!profile || stopped) break;
			if ((backoff.get(profile.agentId) ?? 0) > now()) continue;
			const demand = statistics?.profiles.find(
				(sample) =>
					sample.agentId === profile.agentId &&
					sample.profileDigest === sample.currentProfileDigest,
			);
			const target = Math.min(
				profile.maximum,
				Math.max(
					profile.minimum,
					profile.minimum +
						Math.max(
							0,
							(demand?.newSessionCount ?? 0) - (demand?.claimedCount ?? 0),
						),
				),
			);
			const count = current.filter(
				(row) =>
					row.agentId === profile.agentId &&
					["ready", "preparing"].includes(row.status) &&
					(!demand || row.profileDigest === demand.profileDigest),
			).length;
			let missing = Math.max(0, target - count);
			while (
				missing > 0 &&
				result.prepared < configuration.maximumConcurrentCreates
			) {
				try {
					if (await store.prepare(profile.agentId)) {
						result.prepared++;
						missing--;
					} else {
						defer(profile.agentId);
						break;
					}
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
