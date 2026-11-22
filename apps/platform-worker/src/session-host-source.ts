import {
	type SessionSandboxHostSourceV1,
	type SessionSandboxRuntimeStateV1,
	sessionSandboxObservedPodUidV1,
	type TaskPrincipalV1,
} from "@agent-infra/platform-core";
import { readRuntimeHostSourceV1 } from "./runtime-host-client.js";

/**
 * #4358 I3b1 (Engineering Spec §18.5.1 Host 来源写入): after a business event ACK on a Session
 * Sandbox route, the Worker confirms the Host instance and start once per Pod UID on that same
 * protected, sandbox-bound route and writes them into the committed observation. It is best
 * effort: nothing here can fail, delay or reorder business events, terminals or their ACK. A
 * Host without its Pod UID offers no route, so its Sandbox keeps no Host source.
 */
export interface SessionHostSourceConfirmationV1 {
	/** The resolved Session route and its sandbox-bound service token, as used for events. */
	readonly baseUrl: string;
	readonly serviceToken: string;
	readonly traceId: string;
	readonly agentId: string;
	readonly conversationId: string;
	readonly sessionGeneration: number;
	readonly principal: TaskPrincipalV1;
	/** The Host Session the Execution was accepted on, from committed Platform state. */
	readonly hostSessionRef: string;
	readonly sandboxResource: SessionSandboxRuntimeStateV1;
}

export interface SessionHostSourceStoreV1 {
	recordSessionSandboxHostSourceV1(input: {
		readonly sandboxId: string;
		readonly conversationId: string;
		readonly agentId: string;
		readonly principal: { readonly kind: string; readonly id: string };
		readonly sessionGeneration: number;
		readonly resourceFence: number;
		readonly hostSource: SessionSandboxHostSourceV1;
	}): Promise<"recorded" | "unchanged">;
}

export type SessionHostSourceOutcomeV1 =
	| "recorded"
	| "unchanged"
	| "skipped"
	| "host_unavailable"
	| "store_unavailable";

export function createSessionHostSourceRecorderV1(options: {
	readonly store: SessionHostSourceStoreV1;
	readonly fetch?: typeof fetch;
	readonly timeoutMs?: number;
	/** Minimum spacing of attempts for one Sandbox and Pod UID that did not confirm. */
	readonly retryIntervalMs?: number;
	readonly now?: () => number;
	/** Fixed outcome codes only; never a reference or a body. */
	readonly observe?: (outcome: SessionHostSourceOutcomeV1) => void;
}) {
	const timeoutMs = options.timeoutMs ?? 5_000;
	const retryIntervalMs = options.retryIntervalMs ?? 60_000;
	const now = options.now ?? Date.now;
	/** Last unconfirmed attempt per Sandbox and Pod UID; a Host without the route is not asked on every ACK. */
	const attempted = new Map<string, number>();
	const lifetime = new AbortController();
	const running = new Map<string, Promise<void>>();
	/** Sandbox + Pod UID pairs already confirmed by this process. */
	const confirmed = new Set<string>();

	async function confirm(
		input: SessionHostSourceConfirmationV1,
	): Promise<SessionHostSourceOutcomeV1> {
		const resource = input.sandboxResource;
		const observation = resource.observation;
		const podUid = sessionSandboxObservedPodUidV1(observation);
		if (
			!observation ||
			!podUid ||
			resource.status !== "ready" ||
			observation.status !== "ready" ||
			observation.hostSource?.podUid === podUid ||
			resource.sandbox.generation !== input.sessionGeneration ||
			resource.sandbox.sessionId !== input.conversationId ||
			resource.sandbox.agentId !== input.agentId ||
			resource.sandbox.principal.kind !== input.principal.kind ||
			resource.sandbox.principal.id !== input.principal.id
		)
			return "skipped";
		const epoch = observation.executorInstance?.epoch;
		const active = AbortSignal.any([
			lifetime.signal,
			AbortSignal.timeout(timeoutMs),
		]);
		let host: { instanceRef: string; startRef: string };
		try {
			host = (
				await readRuntimeHostSourceV1(
					{
						baseUrl: input.baseUrl,
						serviceToken: input.serviceToken,
						traceId: input.traceId,
						...(options.fetch ? { fetch: options.fetch } : {}),
					},
					{
						schemaVersion: 1,
						podUid,
						agentId: input.agentId,
						conversationId: input.conversationId,
						hostSessionRef: input.hostSessionRef,
						sessionGeneration: input.sessionGeneration,
					},
					active,
				)
			).host;
		} catch {
			return "host_unavailable";
		}
		try {
			return await options.store.recordSessionSandboxHostSourceV1({
				sandboxId: resource.sandbox.sandboxId,
				conversationId: input.conversationId,
				agentId: input.agentId,
				principal: input.principal,
				sessionGeneration: input.sessionGeneration,
				resourceFence: resource.resourceFence,
				hostSource: {
					schemaVersion: 1,
					podUid,
					instanceRef: host.instanceRef,
					startRef: host.startRef,
					hostSessionRef: input.hostSessionRef,
					sessionGeneration: input.sessionGeneration,
					...(epoch === undefined ? {} : { epoch }),
				},
			});
		} catch {
			return "store_unavailable";
		}
	}

	return {
		confirm,
		/** Called after a business event ACK succeeded; never throws into or waits on it. */
		afterAcknowledge(input: SessionHostSourceConfirmationV1): void {
			if (lifetime.signal.aborted) return;
			const podUid = sessionSandboxObservedPodUidV1(
				input.sandboxResource.observation,
			);
			if (!podUid) return;
			const key = `${input.sandboxResource.sandbox.sandboxId}\n${podUid}`;
			if (confirmed.has(key) || running.has(key)) return;
			const startedAt = now();
			if (
				startedAt - (attempted.get(key) ?? Number.NEGATIVE_INFINITY) <
				retryIntervalMs
			)
				return;
			if (attempted.size >= 4_096) attempted.clear();
			attempted.set(key, startedAt);
			const task = confirm(structuredClone(input))
				.then((outcome) => {
					// Only a stored or already present Host source settles this Pod UID.
					if (
						outcome === "recorded" ||
						(outcome === "skipped" &&
							input.sandboxResource.observation?.hostSource?.podUid === podUid)
					) {
						if (confirmed.size >= 4_096) confirmed.clear();
						confirmed.add(key);
						attempted.delete(key);
					}
					options.observe?.(outcome);
				})
				.catch(() => undefined)
				.finally(() => {
					running.delete(key);
				});
			running.set(key, task);
		},
		async settled(): Promise<void> {
			await Promise.allSettled([...running.values()]);
		},
		async close(): Promise<void> {
			lifetime.abort();
			await Promise.allSettled([...running.values()]);
		},
	};
}

export type SessionHostSourceRecorderV1 = ReturnType<
	typeof createSessionHostSourceRecorderV1
>;
