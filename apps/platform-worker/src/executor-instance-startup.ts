import {
	createHash,
	createPublicKey,
	type KeyObject,
	randomUUID,
	verify,
} from "node:crypto";
import {
	codexSessionExecutorBindingDigestV1,
	issueExecutorStartIdentityV1,
} from "@agent-infra/agent-runtime";
import {
	ExecutorInstanceAdoptionV2Schema,
	type ExecutorInstanceMutationV2,
	type ExecutorInstanceStateV2,
	executorInstanceAdoptionBytesV2,
	executorInstanceStartV2,
} from "@agent-infra/contracts/runtime";
import type { V1Pod, V1Secret } from "@kubernetes/client-node";
import {
	type WorkerKubernetesClientV1,
	WorkloadKubernetesError,
} from "./kubernetes-client.js";
import {
	hasSessionSandboxIdentityV1,
	type SessionSandboxAllocationV1,
} from "./session-workload-adapter.js";

export type ExecutorInstanceLedgerV2 = (
	mutation: ExecutorInstanceMutationV2,
) => Promise<{ state: ExecutorInstanceStateV2; permit: boolean } | null>;
const annotation = "agent-infra.agora.io/executor-instance-digest";
const unavailable = (): never => {
	throw new WorkloadKubernetesError("unavailable");
};

/** One original Store claim owns this receiver; no callback is accepted from a serialized allocation. */
export function createExecutorInstanceControlV2(options: {
	client: WorkerKubernetesClientV1;
	issuer: KeyObject;
	allocation: SessionSandboxAllocationV1;
	ledger: ExecutorInstanceLedgerV2;
	signal: AbortSignal;
}) {
	const { client, allocation, ledger, signal } = options;
	if (
		client.namespace !== allocation.namespace ||
		!allocation.runtime?.serviceToken ||
		!allocation.executorInstance ||
		!allocation.runtime.sessionExecutor ||
		allocation.executorInstance.bindingDigest !==
			codexSessionExecutorBindingDigestV1(
				allocation.runtime.sessionExecutor.binding,
			)
	)
		throw new WorkloadKubernetesError("policy");
	let state: ExecutorInstanceStateV2 = allocation.executorInstance;
	let permitted = false;
	const record = async (mutation: ExecutorInstanceMutationV2) => {
		signal.throwIfAborted();
		const next = await ledger(mutation);
		signal.throwIfAborted();
		if (!next) return unavailable();
		state = next.state;
		permitted = next.permit;
		return state;
	};
	type MutationInput<T> = T extends { attemptId: string; revision: number }
		? Omit<T, "revision" | "attemptId">
		: never;
	const mutate = async (
		mutation: MutationInput<ExecutorInstanceMutationV2>,
	) => {
		if (!state) return unavailable();
		return record({
			...mutation,
			attemptId: state.attemptId,
			revision: state.revision,
		} as ExecutorInstanceMutationV2);
	};
	const projection = async () => {
		if (!state || !client.readMetadata) return unavailable();
		const object = await client.readMetadata("Secret", state.startupRef);
		if (
			object &&
			(object.metadata?.name !== state.startupRef ||
				object.metadata.namespace !== allocation.namespace ||
				!object.metadata.uid ||
				!object.metadata.resourceVersion ||
				object.metadata.deletionTimestamp ||
				object.metadata.annotations?.[annotation] !==
					state.delivery?.identityDigest ||
				object.metadata.ownerReferences?.length !== 1 ||
				!object.metadata.ownerReferences.some(
					(owner) =>
						owner.kind === "Pod" &&
						owner.apiVersion === "v1" &&
						owner.name === allocation.podName &&
						owner.uid === state?.podUid,
				) ||
				(state.projection && object.metadata.uid !== state.projection.uid))
		)
			throw new WorkloadKubernetesError("conflict");
		return object;
	};
	const cleanup = async () => {
		if (!state) return unavailable();
		const current = await projection();
		if (state.cleanup === "absent") {
			if (current) return unavailable();
			return;
		}
		if (!state.delivery) {
			if (current) return unavailable();
			await mutate({ kind: "cleanup-request" });
			return;
		}
		if (!state.projection) {
			if (!current?.metadata) return unavailable();
			await mutate({
				kind: "published",
				projection: {
					kind: "Secret",
					namespace: allocation.namespace,
					name: state.startupRef,
					uid: current.metadata.uid ?? "",
					resourceVersion: current.metadata.resourceVersion ?? "",
				},
			});
		}
		if (state.cleanup !== "delete-pending") {
			await mutate({ kind: "cleanup-request" });
			if (current)
				await client.delete({
					apiVersion: "v1",
					kind: "Secret",
					metadata: current.metadata,
				});
		}
		if (await projection()) return unavailable();
		await mutate({ kind: "cleanup-absent" });
	};
	const readAdoption = async () => {
		if (!state?.delivery || !state.podUid) return unavailable();
		const service = await client.read("Service", allocation.serviceName);
		if (
			!service ||
			!hasSessionSandboxIdentityV1(service, allocation) ||
			!state.resources.some(
				(r) => r.kind === "Service" && r.uid === service.metadata?.uid,
			)
		)
			return unavailable();
		const challenge = state.adoption ? randomUUID() : state.delivery.challenge;
		const response = await fetch(
			`http://${allocation.serviceName}.${allocation.namespace}.svc:${allocation.containerPort}/internal/runtime/v2/executor-startup/read`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${allocation.runtime?.serviceToken}`,
				},
				body: JSON.stringify({
					schemaVersion: 2,
					challenge,
					startupRef: state.startupRef,
					attemptId: state.attemptId,
					podUid: state.podUid,
				}),
				redirect: "error",
				cache: "no-store",
				signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
			},
		);
		if (!response.ok || !response.body) return unavailable();
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			while (true) {
				const result = await reader.read();
				if (result.done) break;
				length += result.value.length;
				if (length > 16384) return unavailable();
				chunks.push(result.value);
			}
		} finally {
			void reader.cancel().catch(() => {});
		}
		const proof = ExecutorInstanceAdoptionV2Schema.parse(
			JSON.parse(Buffer.concat(chunks).toString("utf8")),
		);
		if (
			proof.challenge !== challenge ||
			proof.startupRef !== state.startupRef ||
			proof.attemptId !== state.attemptId ||
			proof.recordRef !== state.recordRef ||
			proof.podUid !== state.podUid ||
			proof.bindingDigest !== state.bindingDigest ||
			proof.generation !== state.generation ||
			proof.resourceFence !== state.resourceFence ||
			(state.adoption &&
				(state.adoption.epoch !== proof.epoch ||
					state.adoption.pinDigest !== proof.pinDigest)) ||
			!verify(
				null,
				Buffer.from(executorInstanceAdoptionBytesV2(proof)),
				createPublicKey({
					key: Buffer.from(state.delivery.hostPublicKey, "base64url"),
					format: "der",
					type: "spki",
				}),
				Buffer.from(proof.signature, "base64url"),
			)
		)
			return unavailable();
		const current = await client.read<V1Pod>("Pod", allocation.podName);
		if (
			current?.metadata?.uid !== state.podUid ||
			!hasSessionSandboxIdentityV1(current, allocation)
		)
			return unavailable();
		signal.throwIfAborted();
		if (!state.adoption) await mutate({ kind: "adopted", proof });
	};
	const bindPod = async (pod: V1Pod) => {
		if (
			!state ||
			!hasSessionSandboxIdentityV1(pod, allocation) ||
			!pod.metadata?.uid ||
			pod.metadata.name !== allocation.podName ||
			pod.metadata.namespace !== allocation.namespace ||
			pod.metadata.annotations?.[
				"agent-infra.agora.io/executor-startup-deadline"
			] !== String(state.expiresAt) ||
			pod.spec?.volumes?.find((v) => v.name === "executor-bootstrap")?.secret
				?.secretName !== state.startupRef
		)
			return unavailable();
		if (state.podUid && state.podUid !== pod.metadata.uid)
			throw new WorkloadKubernetesError("conflict");
		if (!state.podUid) {
			const service = await client.read("Service", allocation.serviceName);
			if (
				!hasSessionSandboxIdentityV1(service, allocation) ||
				!service?.metadata?.uid ||
				!service.metadata.resourceVersion
			)
				return unavailable();
			await mutate({
				kind: "bind",
				podUid: pod.metadata.uid,
				resources: [
					{
						kind: "Pod",
						namespace: allocation.namespace,
						name: allocation.podName,
						uid: pod.metadata.uid,
						resourceVersion: pod.metadata.resourceVersion ?? "",
					},
					{
						kind: "Service",
						namespace: allocation.namespace,
						name: allocation.serviceName,
						uid: service.metadata.uid,
						resourceVersion: service.metadata.resourceVersion,
					},
				],
			});
		}
	};
	return {
		current: () => state,
		async beforePodCreate() {
			const next = await mutate({ kind: "pod-create" });
			if (
				!permitted ||
				next.phase !== "pod-pending" ||
				next.revision !== (allocation.executorInstance?.revision ?? 0) + 1
			)
				return unavailable();
			// The ledger's CAS winner advances prepared exactly once; retries never recreate an unknown Pod.
		},
		bindForCleanup: bindPod,
		async afterPod(pod: V1Pod) {
			await bindPod(pod);
			let published = await projection();
			if (state.phase === "bound") {
				if (Date.now() >= state.expiresAt) return unavailable();
				const material = issueExecutorStartIdentityV1(
					executorInstanceStartV2(state),
					options.issuer,
				);
				const identityDigest = createHash("sha256")
					.update(
						JSON.stringify([
							material.host.statement,
							material.runner.statement,
						]),
					)
					.digest("hex");
				const priorRevision = state.revision;
				const delivered = await mutate({
					kind: "delivery",
					hostPublicKey: material.host.statement.publicKey,
					runnerPublicKey: material.runner.statement.publicKey,
					identityDigest,
				});
				if (
					!permitted ||
					delivered.phase !== "delivery-pending" ||
					delivered.revision !== priorRevision + 1 ||
					delivered.delivery?.identityDigest !== identityDigest ||
					published
				)
					return unavailable();
				// Store committed both public keys and the conservative V2 adoption boundary before this one create.
				await client.create<V1Secret>({
					apiVersion: "v1",
					kind: "Secret",
					type: "Opaque",
					immutable: true,
					metadata: {
						name: state.startupRef,
						namespace: allocation.namespace,
						annotations: { [annotation]: identityDigest },
						ownerReferences: [
							{
								apiVersion: "v1",
								kind: "Pod",
								name: allocation.podName,
								uid: state.podUid ?? "",
							},
						],
					},
					data: {
						host: Buffer.from(JSON.stringify(material.host)).toString("base64"),
						runner: Buffer.from(JSON.stringify(material.runner)).toString(
							"base64",
						),
					},
				});
				published = await projection();
			}
			if (state.phase === "delivery-pending") {
				if (!published?.metadata?.uid || !published.metadata.resourceVersion)
					return unavailable();
				await mutate({
					kind: "published",
					projection: {
						kind: "Secret",
						namespace: allocation.namespace,
						name: state.startupRef,
						uid: published.metadata.uid,
						resourceVersion: published.metadata.resourceVersion,
					},
				});
			}
			const initialized = pod.status?.initContainerStatuses?.some(
				(item) =>
					item.name === "codex-session-workspace-init" &&
					item.state?.terminated?.exitCode === 0,
			);
			const ready = pod.status?.conditions?.some(
				(item) => item.type === "Ready" && item.status === "True",
			);
			if (initialized && ready) {
				await readAdoption();
				await cleanup();
			}
		},
		async retire() {
			if (!state) return unavailable();
			if (state.phase !== "closing") await mutate({ kind: "seal" });
			await cleanup();
			for (const resource of state.resources) {
				let progress = state.retirement.find(
					(item) => item.resource.kind === resource.kind,
				);
				const current = await client.read(resource.kind, resource.name);
				if (
					current &&
					(current.metadata?.uid !== resource.uid ||
						current.metadata.namespace !== resource.namespace ||
						current.metadata.name !== resource.name ||
						!hasSessionSandboxIdentityV1(current, allocation))
				)
					throw new WorkloadKubernetesError("conflict");
				if (progress?.state === "absent") {
					if (current) return unavailable();
					continue;
				}
				if (!progress) {
					progress = {
						resource: {
							...resource,
							resourceVersion:
								current?.metadata?.resourceVersion ?? resource.resourceVersion,
						},
						deleteAttemptId: randomUUID(),
						state: "delete-requested",
						callResult: "not-attempted",
					};
					await mutate({ kind: "retirement-progress", progress });
					if (current) {
						try {
							await client.delete({
								apiVersion: "v1",
								kind: resource.kind,
								metadata: current.metadata,
							});
							progress = { ...progress, callResult: "acknowledged" };
						} catch {
							await mutate({
								kind: "retirement-progress",
								progress: { ...progress, callResult: "unknown" },
							});
							return unavailable();
						}
					} else progress = { ...progress, callResult: "unknown" };
					await mutate({ kind: "retirement-progress", progress });
				}
				if (await client.read(resource.kind, resource.name))
					return unavailable();
				await mutate({
					kind: "retirement-progress",
					progress: { ...progress, state: "absent" },
				});
			}
			await mutate({ kind: "retired" });
		},
	};
}
export type ExecutorInstanceControlV2 = ReturnType<
	typeof createExecutorInstanceControlV2
>;
