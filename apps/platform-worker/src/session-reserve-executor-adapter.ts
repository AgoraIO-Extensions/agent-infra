import { createHash, createPublicKey } from "node:crypto";
import {
	codexSessionExecutorBindingDigestV1,
	issueExecutorStartIdentityV1,
	verifyExecutorStartIdentityV1,
} from "@agent-infra/agent-runtime";
import {
	ExecutorInstanceStateV2Schema,
	executorInstanceStartV2,
} from "@agent-infra/contracts/runtime";
import { sessionSandboxReserveRefV1 } from "@agent-infra/platform-core";
import type {
	KubernetesObject,
	V1Endpoints,
	V1Pod,
	V1Secret,
} from "@kubernetes/client-node";
import {
	sessionExecutorContainerNameV1,
	sessionExecutorInitContainerNameV1,
	sessionSandboxResourceCostsV1,
} from "./codex-session-executor.js";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import type {
	SessionSandboxReserveAdapterOptionsV1,
	SessionSandboxReserveObservationV1,
} from "./session-reserve-adapter.js";
import { readSessionReserveInstanceV1 } from "./session-reserve-instance.js";
import type { SessionReserveExecutorAdapterV1 } from "./session-reserve-worker.js";
import {
	hasSessionSandboxIdentityV1,
	type SessionSandboxResourceInputV1,
	sessionSandboxIdentityAnnotationsV1,
	sessionSandboxLabelsV1,
} from "./session-workload-adapter.js";

const identityDigestAnnotation =
	"agent-infra.agora.io/executor-instance-digest";
const keyAnnotation = "agent-infra.agora.io/executor-host-key-id";
const invalid = (): never => {
	throw new WorkloadKubernetesError("conflict");
};

/** Only metadata crosses recovery/cleanup reads; private role inputs never get reloaded or regenerated. */
export function createSessionReserveExecutorOperationsV1(context: {
	options: SessionSandboxReserveAdapterOptionsV1;
	resourceInput: (
		options: SessionSandboxReserveAdapterOptionsV1,
		claim: SessionSandboxReserveObservationV1,
	) => SessionSandboxResourceInputV1;
	validatedInput: (
		claim: SessionSandboxReserveObservationV1,
	) => SessionSandboxResourceInputV1;
	read: (
		claim: SessionSandboxReserveObservationV1,
		kind: "Pod" | "Service",
		signal?: AbortSignal,
	) => Promise<KubernetesObject | null>;
}): SessionReserveExecutorAdapterV1 {
	const { options, read } = context;
	const client = options.workload.client;
	const inputFor = (claim: SessionSandboxReserveObservationV1) =>
		context.resourceInput(options, claim);
	const stateFor = (claim: SessionSandboxReserveObservationV1) => {
		if (
			claim.status === "claimed" ||
			"principal" in claim ||
			"channelId" in claim ||
			"execution" in claim
		)
			return invalid();
		const state = ExecutorInstanceStateV2Schema.parse(
			claim.executorStartup?.instance,
		);
		if (
			state.sandboxId !== claim.sandboxId ||
			state.namespace !== client.namespace ||
			state.podName !== `sandbox-${claim.sandboxId}` ||
			state.generation !== 1 ||
			state.resourceFence !== 1 ||
			state.startupRef !== claim.executorStartup?.startupRef ||
			state.expiresAt !== claim.executorStartup.deadlineMs
		)
			return invalid();
		return state;
	};
	const readProjection: SessionReserveExecutorAdapterV1["readProjection"] =
		async (claim, signal) => {
			signal?.throwIfAborted();
			const state = stateFor(claim);
			if (!client.readMetadata) throw new WorkloadKubernetesError("policy");
			const object = await client.readMetadata("Secret", state.startupRef);
			signal?.throwIfAborted();
			if (!object) return null;
			const original = claim.executorStartup?.projection;
			const metadata = object.metadata;
			if (
				!original ||
				!state.delivery ||
				metadata?.name !== state.startupRef ||
				metadata.namespace !== state.namespace ||
				!metadata.uid ||
				!metadata.resourceVersion ||
				!hasSessionSandboxIdentityV1(object, claim) ||
				metadata.annotations?.[identityDigestAnnotation] !==
					state.delivery.identityDigest ||
				metadata.annotations?.[keyAnnotation] !== original.hostKeyId ||
				metadata.ownerReferences?.length !== 1 ||
				!metadata.ownerReferences.some(
					(owner) =>
						owner.apiVersion === "v1" &&
						owner.kind === "Pod" &&
						owner.name === state.podName &&
						owner.uid === original.podUid,
				) ||
				(original.create.resource &&
					metadata.uid !== original.create.resource.uid)
			)
				return invalid();
			return { apiVersion: "v1", kind: "Secret", metadata };
		};
	return {
		async startup(claim) {
			const input = inputFor(claim);
			if (!input.runtime?.sessionExecutor) return null;
			const approvals =
				options.workload.policy.executorInstanceStartupApprovals;
			if (
				!approvals ||
				approvals.length > 128 ||
				new Set(approvals.map((x) => x.imageDigest)).size !== approvals.length
			)
				throw new WorkloadKubernetesError("policy");
			const approval = approvals
				.map((x) => ExecutorInstanceStateV2Schema.shape.approval.parse(x))
				.find((x) => x.imageDigest === input.imageDigest);
			const required = sessionSandboxResourceCostsV1(options.workload.policy);
			if (
				!approval ||
				!options.executorDrainStartupTimeoutMs ||
				(["cpuMillis", "memoryBytes", "storageBytes"] as const).some(
					(key) => claim.profile.resources[key] < required[key],
				)
			)
				throw new WorkloadKubernetesError("policy");
			return {
				kind: "prepare",
				bindingDigest: codexSessionExecutorBindingDigestV1(
					input.runtime.sessionExecutor.binding,
				),
				configurationVersion: JSON.parse(input.runtime.modelConfiguration)
					.configVersion,
				timeoutMs: options.executorDrainStartupTimeoutMs,
				approval,
			};
		},
		async projection(claim, pod) {
			context.validatedInput(claim);
			const state = stateFor(claim);
			if (
				claim.status !== "preparing" ||
				!options.executorIdentityIssuer ||
				state.phase !== "bound" ||
				!state.recordRef ||
				pod.metadata?.uid !== state.podUid ||
				!hasSessionSandboxIdentityV1(pod, claim) ||
				claim.executorStartup?.projection ||
				Date.now() >= state.expiresAt
			)
				return invalid();
			const material = issueExecutorStartIdentityV1(
				executorInstanceStartV2(state),
				options.executorIdentityIssuer,
			);
			const identityDigest = createHash("sha256")
				.update(
					JSON.stringify([material.host.statement, material.runner.statement]),
				)
				.digest("hex");
			const hostKeyId = createHash("sha256")
				.update(material.host.statement.publicKey)
				.digest("hex");
			return {
				intent: {
					attemptId: state.attemptId,
					podUid: state.podUid!,
					hostKeyId,
					hostPublicKey: material.host.statement.publicKey,
					bindingDigest: state.bindingDigest,
					instanceDelivery: {
						runnerPublicKey: material.runner.statement.publicKey,
						identityDigest,
					},
				},
				resource: {
					apiVersion: "v1",
					kind: "Secret",
					type: "Opaque",
					immutable: true,
					metadata: {
						name: state.startupRef,
						namespace: state.namespace,
						labels: { ...sessionSandboxLabelsV1(claim) },
						annotations: {
							...sessionSandboxIdentityAnnotationsV1(claim),
							"agent-infra.agora.io/managed": "session-sandbox-v1",
							"agent-infra.agora.io/fence": "1",
							[identityDigestAnnotation]: identityDigest,
							[keyAnnotation]: hostKeyId,
						},
						ownerReferences: [
							{
								apiVersion: "v1",
								kind: "Pod",
								name: state.podName,
								uid: state.podUid!,
							},
						],
					},
					data: {
						host: Buffer.from(JSON.stringify(material.host)).toString("base64"),
						runner: Buffer.from(JSON.stringify(material.runner)).toString(
							"base64",
						),
					},
				} as V1Secret,
			};
		},
		readProjection,
		async createProjection(claim, resource, signal) {
			context.validatedInput(claim);
			signal?.throwIfAborted();
			const state = stateFor(claim);
			const original = claim.executorStartup?.projection;
			const secret = resource as V1Secret;
			if (
				claim.status !== "preparing" ||
				original?.create.status !== "pending" ||
				original.create.writeCompletion !== "pending" ||
				original.create.writer.owner !== claim.leaseOwner ||
				original.create.writer.fence !== claim.deliveryFence ||
				!state.delivery ||
				!options.executorIdentityIssuer ||
				secret.kind !== "Secret" ||
				secret.type !== "Opaque" ||
				secret.immutable !== true ||
				Object.keys(secret.data ?? {})
					.sort()
					.join(",") !== "host,runner" ||
				secret.stringData ||
				secret.metadata?.name !== state.startupRef ||
				secret.metadata.namespace !== state.namespace ||
				!hasSessionSandboxIdentityV1(secret, claim) ||
				secret.metadata.annotations?.[identityDigestAnnotation] !==
					state.delivery.identityDigest ||
				secret.metadata.annotations?.[keyAnnotation] !== original.hostKeyId ||
				secret.metadata.ownerReferences?.length !== 1 ||
				!secret.metadata.ownerReferences.some(
					(x) =>
						x.apiVersion === "v1" &&
						x.kind === "Pod" &&
						x.name === state.podName &&
						x.uid === state.podUid,
				)
			)
				return invalid();
			const inputs = ["host", "runner"].map((role) =>
				JSON.parse(
					Buffer.from(secret.data?.[role] ?? "", "base64").toString("utf8"),
				),
			);
			for (const [index, role] of (["host", "runner"] as const).entries()) {
				const identity = verifyExecutorStartIdentityV1(inputs[index], {
					...executorInstanceStartV2(state),
					role,
					now: Date.now(),
					issuerKey: createPublicKey(options.executorIdentityIssuer),
				});
				if (
					identity.publicKey !==
					(role === "host"
						? state.delivery.hostPublicKey
						: state.delivery.runnerPublicKey)
				)
					return invalid();
			}
			if (
				createHash("sha256")
					.update(JSON.stringify(inputs.map((x) => x.statement)))
					.digest("hex") !== state.delivery.identityDigest ||
				(await readProjection(claim, signal)) ||
				Date.now() >= state.expiresAt
			)
				return invalid();
			return client.create(secret);
		},
		async removeProjection(claim, resource, signal) {
			signal?.throwIfAborted();
			const state = stateFor(claim);
			const original = claim.executorStartup?.projection;
			const deletion = original?.deletes.at(-1);
			if (
				!["preparing", "retiring"].includes(claim.status) ||
				!client.deleteResult ||
				!deletion ||
				deletion.writeCompletion !== "pending" ||
				deletion.writer.owner !== claim.leaseOwner ||
				deletion.writer.fence !== claim.deliveryFence ||
				resource.name !== state.startupRef ||
				resource.namespace !== state.namespace ||
				resource.kind !== "Secret" ||
				resource.uid !== original?.create.resource?.uid ||
				deletion.resource?.uid !== resource.uid ||
				deletion.resource.resourceVersion !== resource.resourceVersion
			)
				return invalid();
			const current = await readProjection(claim, signal);
			if (
				current &&
				(current.metadata?.uid !== resource.uid ||
					current.metadata.resourceVersion !== resource.resourceVersion)
			)
				return invalid();
			// Even a preceding GET absence is followed by the original conditional DELETE; only its 404 is a DELETE response.
			return client.deleteResult({
				apiVersion: "v1",
				kind: "Secret",
				metadata: current?.metadata ?? {
					name: resource.name,
					namespace: resource.namespace,
					uid: resource.uid,
					resourceVersion: resource.resourceVersion,
				},
			});
		},
		async readInstance(claim, _resources, signal) {
			try {
				const state = stateFor(claim);
				const startup = claim.executorStartup;
				const projection = startup?.projection;
				const input = context.validatedInput(claim);
				const runtime = input.runtime;
				const readFence =
					"deliveryFence" in claim ? claim.deliveryFence : claim.readFence;
				if (
					!runtime?.sessionExecutor ||
					!projection?.create.resource ||
					projection.create.status !== "confirmed" ||
					projection.create.writeCompletion !== "response" ||
					!options.executorIdentityIssuer ||
					!state.delivery ||
					typeof readFence !== "number" ||
					readFence < 1 ||
					!Number.isSafeInteger(readFence)
				)
					return null;
				const revalidate = async () => {
					const pod = (await read(claim, "Pod", signal)) as V1Pod | null;
					const service = await read(claim, "Service", signal);
					const endpoints = await client.read<V1Endpoints>(
						"Endpoints",
						input.serviceName,
					);
					const addresses =
						endpoints?.subsets?.flatMap((x) => x.addresses ?? []) ?? [];
					const statuses = pod?.status?.containerStatuses ?? [];
					const init = pod?.status?.initContainerStatuses?.find(
						(x) => x.name === sessionExecutorInitContainerNameV1,
					);
					const digest = claim.profile.policy.imageDigest;
					if (
						!pod ||
						pod.metadata?.uid !== projection.podUid ||
						!service ||
						service.metadata?.uid !==
							claim.operations.find(
								(o) => o.kind === "Service" && o.operation === "create",
							)?.resource?.uid ||
						pod.status?.phase !== "Running" ||
						!pod.status.conditions?.some(
							(x) => x.type === "Ready" && x.status === "True",
						) ||
						statuses.length !== 2 ||
						!["runtime", sessionExecutorContainerNameV1].every((name) =>
							statuses.some(
								(x) =>
									x.name === name &&
									x.ready &&
									x.restartCount === 0 &&
									x.state?.running &&
									x.imageID?.endsWith(digest),
							),
						) ||
						init?.state?.terminated?.exitCode !== 0 ||
						!init.imageID?.endsWith(digest) ||
						endpoints?.metadata?.name !== input.serviceName ||
						endpoints.metadata.namespace !== input.namespace ||
						addresses.length !== 1 ||
						addresses[0]?.targetRef?.uid !== pod.metadata.uid ||
						addresses[0].targetRef?.name !== input.podName ||
						addresses[0].targetRef?.namespace !== input.namespace ||
						addresses[0].targetRef?.kind !== "Pod" ||
						addresses[0].ip !== pod.status.podIP ||
						endpoints.subsets?.some(
							(x) => (x.notReadyAddresses?.length ?? 0) > 0,
						) ||
						!endpoints.subsets?.some((x) =>
							x.ports?.some(
								(p) =>
									p.port === input.containerPort &&
									(p.protocol ?? "TCP") === "TCP",
							),
						)
					)
						return invalid();
				};
				return readSessionReserveInstanceV1({
					binding: {
						schemaVersion: 1,
						workerId: runtime.workerId,
						namespace: input.namespace,
						agentId: claim.agentId,
						sessionId: claim.sessionId,
						sandboxId: claim.sandboxId,
						podUid: projection.podUid,
						generation: 1,
						resourceFence: 1,
						startupRef: startup!.startupRef,
						bindingDigest: projection.bindingDigest,
						profileDigest: claim.profile.digest,
						scope: {
							phase: "reserve",
							reserveRef: sessionSandboxReserveRefV1(claim.sandboxId),
							reserveDeliveryFence: readFence,
						},
					},
					hostKeyId: projection.hostKeyId,
					hostPublicKey: projection.hostPublicKey,
					...(startup?.consumption
						? { expectedRunnerEpoch: startup.consumption.runnerEpoch }
						: {}),
					serviceToken: runtime.serviceToken,
					origin: `http://${input.serviceName}.${input.namespace}.svc:${input.containerPort}/`,
					signing: {
						privateKey: options.executorIdentityIssuer,
						workerId: runtime.workerId,
						issuer: runtime.grantIssuer,
						keyId: runtime.grantKeyId,
					},
					revalidate,
					signal,
					fetch: options.fetch ?? options.workload.fetch,
				});
			} catch {
				return null;
			}
		},
	};
}
