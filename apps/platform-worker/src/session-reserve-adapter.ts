import { createPublicKey, type KeyObject } from "node:crypto";
import { codexSessionExecutorBindingDigestV1 } from "@agent-infra/agent-runtime";
import { ExecutorInstanceStateV2Schema } from "@agent-infra/contracts/runtime";
import {
	type AgentWorkloadDesiredV1,
	validateAgentWorkloadDesiredV1,
} from "@agent-infra/contracts/workload";
import { validateRuntimeModelProjectionV4 } from "@agent-infra/model-catalog";
import {
	type SessionSandboxReserveResourceKindV1,
	type SessionSandboxResourceIdentityV1,
	sessionSandboxReserveDigestV1,
} from "@agent-infra/platform-core";
import type { SessionSandboxReserveWorkerClaimV1 } from "@agent-infra/platform-store";
import type {
	KubernetesObject,
	V1Endpoints,
	V1NetworkPolicy,
	V1Pod,
	V1Service,
} from "@kubernetes/client-node";
import { sessionSandboxResourceCostsV1 } from "./codex-session-executor.js";
import type { ConnectionInstallBootstrapDeploymentV1 } from "./connection-install-bootstrap.js";
import { createSessionSandboxResourceInputResolverV1 } from "./conversation-deployment.js";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import type { KubernetesWorkloadPolicyV1 } from "./kubernetes-runtime-adapter.js";
import {
	agentAnnotation,
	ownerLabel,
	quantityRatio,
	workloadResourceNameV1,
} from "./kubernetes-runtime-comparison.js";
import { createSessionReserveExecutorOperationsV1 } from "./session-reserve-executor-adapter.js";
import {
	hasSessionSandboxIdentityV1,
	type SessionSandboxResourceInputV1,
	sessionSandboxExecutorReserveResourcesV1,
	sessionSandboxReserveResourcesV1,
	sessionSandboxResourceMatchesV1,
	sessionSandboxRuntimeContainerName,
	// This adapter deliberately consumes the resource-only renderer; it never
	// manufactures a principal or channel for an unclaimed reserve.
} from "./session-workload-adapter.js";
import { workerTemplateBindingsForAgentV1 } from "./single-agent-template-binding.js";
import {
	hasAdditionalEgressPolicyV1,
	type WorkloadEgressPolicyV1,
	workloadEgressRulesV1,
} from "./workload-network.js";
import {
	type WorkloadRuntimeOptionsV1,
	workloadResourceConfigurationHashV1,
} from "./workload-runtime.js";

export interface SessionSandboxReserveAdapterOptionsV1 {
	readonly executorIdentityIssuer?: KeyObject;
	readonly executorDrainStartupTimeoutMs?: number;
	readonly workload: Pick<
		WorkloadRuntimeOptionsV1,
		| "client"
		| "policy"
		| "templateModelBindings"
		| "singleAgentTemplateRelease"
		| "fetch"
		| "connectionDeliveryCurrent"
	>;
	readonly serviceToken: string;
	readonly connectionInstallBootstrap?: ConnectionInstallBootstrapDeploymentV1;
	readonly fetch?: typeof fetch;
}

export type SessionSandboxReserveAdapterResourceV1 =
	SessionSandboxResourceInputV1;

/** Read-only Store snapshot; ready inspection carries no manufactured lease. */
export type SessionSandboxReserveObservationV1 = Omit<
	SessionSandboxReserveWorkerClaimV1,
	"leaseOwner" | "deliveryFence"
> & {
	readonly currentProfileDigest?: string | null;
	readonly readFence?: number;
};

function reserveEgressPolicy(
	policy: KubernetesWorkloadPolicyV1,
): WorkloadEgressPolicyV1 {
	return {
		...(policy.nativeEgress ? { nativeEgress: policy.nativeEgress } : {}),
		...(policy.modelEgress ? { modelEgress: policy.modelEgress } : {}),
		...(policy.connectionEgress
			? { connectionEgress: policy.connectionEgress }
			: {}),
		...(policy.nativeMetadataWorkerEgress
			? { nativeMetadataWorkerEgress: policy.nativeMetadataWorkerEgress }
			: {}),
		...(policy.fileExchangeEgress
			? { fileExchangeEgress: policy.fileExchangeEgress }
			: {}),
		...(policy.dnsEgress ? { dnsEgress: policy.dnsEgress } : {}),
	};
}

function readDeployment(value: unknown): AgentWorkloadDesiredV1 {
	const deployment = validateAgentWorkloadDesiredV1(value);
	if (
		deployment.desiredState !== "running" ||
		deployment.runtimeManifest.interactionMode !== "platform-adapter" ||
		deployment.secretRefs.length !== 0 ||
		deployment.multiService !== undefined
	)
		throw new WorkloadKubernetesError("policy");
	return deployment;
}

function resourceIdentity(object: KubernetesObject): {
	kind:
		| "Pod"
		| "Service"
		| "ServiceAccount"
		| "PersistentVolumeClaim"
		| "NetworkPolicy"
		| "Secret";
	name: string;
	namespace: string;
	uid: string;
	resourceVersion: string;
} {
	if (
		!object.kind ||
		object.kind === "StatefulSet" ||
		!object.metadata?.name ||
		!object.metadata.namespace ||
		!object.metadata.uid ||
		!object.metadata.resourceVersion ||
		!(
			[
				"Pod",
				"Service",
				"ServiceAccount",
				"PersistentVolumeClaim",
				"NetworkPolicy",
				"Secret",
			] as string[]
		).includes(object.kind)
	)
		throw new WorkloadKubernetesError("conflict");
	return {
		kind: object.kind as ReturnType<typeof resourceIdentity>["kind"],
		name: object.metadata.name,
		namespace: object.metadata.namespace,
		uid: object.metadata.uid,
		resourceVersion: object.metadata.resourceVersion,
	};
}

function reserveResourceInput(
	options: SessionSandboxReserveAdapterOptionsV1,
	claim: SessionSandboxReserveObservationV1,
): SessionSandboxResourceInputV1 {
	if (
		claim.generation !== 1 ||
		claim.resourceFence !== 1 ||
		"principal" in claim ||
		"channelId" in claim ||
		"execution" in claim ||
		!["preparing", "ready", "unknown"].includes(claim.status)
	)
		throw new WorkloadKubernetesError("policy");
	if (!claim.deployment || !claim.modelProjection)
		throw new WorkloadKubernetesError("policy");
	const deployment = readDeployment(claim.deployment);
	if (
		deployment.agentId !== claim.agentId ||
		claim.profile.agentId !== claim.agentId ||
		deployment.imageDigest !== claim.profile.policy.imageDigest ||
		deployment.configRevision !== claim.profile.policy.configurationRevision ||
		deployment.workloadRevision !== claim.profile.policy.workloadRevision ||
		sessionSandboxReserveDigestV1(deployment) !==
			claim.profile.deploymentDigest ||
		sessionSandboxReserveDigestV1(deployment.env) !==
			claim.profile.environmentDigest ||
		sessionSandboxReserveDigestV1(deployment.skills ?? []) !==
			claim.profile.skillsDigest
	)
		throw new WorkloadKubernetesError("conflict");
	const policy = options.workload.policy;
	if (
		policy.namespace !== claim.profile.policy.namespace ||
		options.workload.client.namespace !== policy.namespace ||
		workloadResourceConfigurationHashV1(policy) !==
			claim.profile.policy.resourceConfigurationHash
	) {
		throw new WorkloadKubernetesError("policy");
	}
	workloadEgressRulesV1(reserveEgressPolicy(policy));
	const costs = [
		[claim.profile.resources.cpuMillis, policy.resources.limits.cpu, 1000],
		[claim.profile.resources.memoryBytes, policy.resources.limits.memory, 1],
		[claim.profile.resources.storageBytes, policy.storageSize, 1],
	] as const;
	for (const [budget, quantity, scale] of costs) {
		const ratio = quantityRatio(quantity);
		if (
			!Number.isSafeInteger(budget) ||
			budget < 1 ||
			!ratio ||
			BigInt(budget) * ratio[1] < ratio[0] * BigInt(scale)
		)
			throw new WorkloadKubernetesError("policy");
	}
	const projection = validateRuntimeModelProjectionV4(claim.modelProjection);
	const template = projection.standardTemplateBinding;
	if (
		projection.agentId !== claim.agentId ||
		projection.configurationRevision !== deployment.configRevision ||
		sessionSandboxReserveDigestV1(projection) !==
			claim.profile.modelProjectionDigest ||
		template.imageDigest !== deployment.imageDigest ||
		!workerTemplateBindingsForAgentV1(options.workload, claim.agentId).some(
			(item) =>
				sessionSandboxReserveDigestV1(item) ===
				sessionSandboxReserveDigestV1(template),
		)
	)
		throw new WorkloadKubernetesError("policy");
	return createSessionSandboxResourceInputResolverV1(options.workload, {
		serviceToken: options.serviceToken,
		...(options.executorDrainStartupTimeoutMs === undefined
			? {}
			: {
					executorDrainStartupTimeoutMs: options.executorDrainStartupTimeoutMs,
				}),
		...(options.connectionInstallBootstrap
			? { connectionInstallBootstrap: options.connectionInstallBootstrap }
			: {}),
	})(
		{
			schemaVersion: 1,
			agentId: claim.agentId,
			sessionId: claim.sessionId,
			sandboxId: claim.sandboxId,
			generation: 1,
			resourceName: `sandbox-${claim.sandboxId}`,
			workspaceScope: claim.sandboxId,
		},
		claim.profile.policy,
		deployment,
		projection,
		"running",
		1,
		1,
	);
}

export function createSessionSandboxReserveResourceInputV1(
	options: SessionSandboxReserveAdapterOptionsV1,
	claim: SessionSandboxReserveObservationV1,
): SessionSandboxResourceInputV1 {
	const input = reserveResourceInput(options, claim);
	// Independent Codex executors require a business binding and promotion receipt.
	// Replace this guard when the #4248 option B promotion contract is implemented.
	if (
		input.runtime?.driver === "codex" &&
		options.workload.policy.codexSessionExecutor !== undefined
	)
		throw new WorkloadKubernetesError("policy");
	return input;
}

/** Testable non-business preparation path; never selected by production reserve admission. */
export function createSessionSandboxExecutorReserveResourceInputV1(
	options: SessionSandboxReserveAdapterOptionsV1,
	claim: SessionSandboxReserveObservationV1,
): SessionSandboxResourceInputV1 {
	const input = reserveResourceInput(options, claim);
	if (!input.runtime?.sessionExecutor) return input;
	const state = ExecutorInstanceStateV2Schema.parse(
		claim.executorStartup?.instance,
	);
	const approvals = options.workload.policy.executorInstanceStartupApprovals;
	if (
		!approvals ||
		approvals.length > 128 ||
		new Set(approvals.map((x) => x.imageDigest)).size !== approvals.length
	)
		throw new WorkloadKubernetesError("policy");
	const approval = approvals.find((x) => x.imageDigest === input.imageDigest);
	const required = sessionSandboxResourceCostsV1(options.workload.policy);
	if (
		!approval ||
		JSON.stringify(state.approval) !==
			JSON.stringify(
				ExecutorInstanceStateV2Schema.shape.approval.parse(approval),
			) ||
		state.sandboxId !== claim.sandboxId ||
		state.namespace !== input.namespace ||
		state.podName !== input.podName ||
		state.generation !== 1 ||
		state.resourceFence !== 1 ||
		state.configurationRevision !==
			claim.profile.policy.configurationRevision ||
		state.configurationVersion !==
			JSON.parse(input.runtime.modelConfiguration).configVersion ||
		state.bindingDigest !==
			codexSessionExecutorBindingDigestV1(
				input.runtime.sessionExecutor.binding,
			) ||
		state.startupRef !== claim.executorStartup?.startupRef ||
		state.expiresAt !== claim.executorStartup.deadlineMs ||
		(["cpuMillis", "memoryBytes", "storageBytes"] as const).some(
			(key) => claim.profile.resources[key] < required[key],
		)
	)
		throw new WorkloadKubernetesError("policy");
	return {
		...input,
		executorDrainIdentity: true,
		executorStartupDeadline: state.expiresAt,
		executorInstance: state,
	};
}

export function createSessionSandboxReserveAdapterV1(
	options: SessionSandboxReserveAdapterOptionsV1,
) {
	return assembleReserveAdapter(options, false);
}
/** No deployment flag selects this preparation seam; business adoption remains a separate gated step. */
export function createSessionSandboxExecutorReservePreparationAdapterV1(
	options: SessionSandboxReserveAdapterOptionsV1,
) {
	if (
		options.workload.policy.codexSessionExecutor !== undefined &&
		options.workload.policy.executorInstanceStartupApprovals === undefined
	)
		throw new Error("WORKER_EXECUTOR_V2_APPROVALS_REQUIRED");
	const issuer = options.executorIdentityIssuer;
	const auth = options.workload.policy.runtimeAuth;
	const timeout = options.executorDrainStartupTimeoutMs;
	if (
		!issuer ||
		issuer.asymmetricKeyType !== "ed25519" ||
		issuer.type !== "private" ||
		!auth ||
		createPublicKey(issuer)
			.export({ format: "pem", type: "spki" })
			.toString() !== auth.grantPublicKey ||
		!Number.isSafeInteger(timeout) ||
		!timeout ||
		timeout < 1000 ||
		timeout > 900000
	)
		throw new WorkloadKubernetesError("policy");
	return assembleReserveAdapter(options, true);
}
function assembleReserveAdapter(
	options: SessionSandboxReserveAdapterOptionsV1,
	preparation: boolean,
) {
	const fetcher = options.fetch ?? options.workload.fetch ?? globalThis.fetch;
	const client = options.workload.client;
	const inputFor = (claim: SessionSandboxReserveObservationV1) =>
		preparation
			? createSessionSandboxExecutorReserveResourceInputV1(options, claim)
			: createSessionSandboxReserveResourceInputV1(options, claim);
	const resourcesFor = (
		claim: SessionSandboxReserveObservationV1,
		input: SessionSandboxResourceInputV1,
	) =>
		input.runtime?.sessionExecutor
			? sessionSandboxExecutorReserveResourcesV1(
					input,
					claim.executorStartup ??
						(() => {
							throw new WorkloadKubernetesError("policy");
						})(),
				)
			: sessionSandboxReserveResourcesV1(input);
	function identityClaim(claim: SessionSandboxReserveObservationV1) {
		if (
			!claim.sandboxId ||
			!claim.sessionId ||
			!claim.agentId ||
			claim.generation !== 1 ||
			claim.resourceFence !== 1 ||
			claim.status === "claimed" ||
			claim.profile.policy.namespace !== client.namespace ||
			"principal" in claim ||
			"channelId" in claim ||
			"execution" in claim
		)
			throw new WorkloadKubernetesError("policy");
	}
	/**
	 * Spec §13.5.7: a startup-selected static or shared Consumer snapshot reaches a reserve
	 * Pod only while its Agent still has no persistent association. Only actual delivery
	 * (create and readiness) consults the current source; render, identity reads and
	 * removal keep the original inputs so existing reserves can always be removed.
	 * A source error throws and callers fail closed.
	 */
	const deliverable = async (
		claim: SessionSandboxReserveObservationV1,
	): Promise<boolean> => {
		identityClaim(claim);
		const current = options.workload.connectionDeliveryCurrent;
		if (!current) return true;
		const input = preparation
			? reserveResourceInput(options, claim)
			: inputFor(claim);
		if (typeof input.connectionConsumerSnapshot !== "string") return true;
		try {
			return await current(claim.agentId);
		} catch {
			throw new WorkloadKubernetesError("unavailable");
		}
	};
	const render = async (
		claim: SessionSandboxReserveObservationV1,
		signal?: AbortSignal,
	) => {
		signal?.throwIfAborted();
		identityClaim(claim);
		const input = inputFor(claim);
		const resources = resourcesFor(claim, input);
		if (input.skillHub) {
			const owner = workloadResourceNameV1(claim.agentId);
			const source = await client.read(
				"PersistentVolumeClaim",
				`${owner}-data`,
			);
			if (
				!source?.metadata?.uid ||
				!source.metadata.resourceVersion ||
				source.metadata.deletionTimestamp ||
				source.metadata.name !== `${owner}-data` ||
				source.metadata.namespace !== input.namespace ||
				source.metadata.labels?.[ownerLabel] !== owner ||
				source.metadata.annotations?.[agentAnnotation] !== claim.agentId
			)
				throw new WorkloadKubernetesError("conflict");
		}
		if (
			input.egress.nativeEgress &&
			hasAdditionalEgressPolicyV1(
				await client.list<V1NetworkPolicy>("NetworkPolicy", ""),
				resources[2] as V1NetworkPolicy,
			)
		)
			throw new WorkloadKubernetesError("policy");
		return resources;
	};
	const read = async (
		claim: SessionSandboxReserveObservationV1,
		kind: SessionSandboxReserveResourceKindV1,
		signal?: AbortSignal,
	): Promise<KubernetesObject | null> => {
		signal?.throwIfAborted();
		identityClaim(claim);
		const current = await client.read(kind, `sandbox-${claim.sandboxId}`);
		signal?.throwIfAborted();
		if (!current) return null;
		const identity = resourceIdentity(current);
		if (
			identity.kind !== kind ||
			identity.namespace !== client.namespace ||
			identity.name !== `sandbox-${claim.sandboxId}` ||
			!hasSessionSandboxIdentityV1(current, claim) ||
			current.metadata?.annotations?.["agent-infra.agora.io/managed"] !==
				"session-sandbox-v1" ||
			current.metadata?.annotations?.["agent-infra.agora.io/fence"] !== "1"
		)
			throw new WorkloadKubernetesError("conflict");
		const prior = claim.operations.find(
			(operation) =>
				operation.kind === kind && operation.operation === "create",
		);
		if (prior?.resource && prior.resource.uid !== identity.uid)
			throw new WorkloadKubernetesError("conflict");
		if (claim.status !== "retiring") {
			const input = inputFor(claim);
			const expected = resourcesFor(claim, input).find(
				(object) => object.kind === kind,
			);
			if (
				!expected ||
				!sessionSandboxResourceMatchesV1(current, expected, input)
			)
				throw new WorkloadKubernetesError("conflict");
		}
		return current;
	};
	const executor = preparation
		? createSessionReserveExecutorOperationsV1({
				options,
				resourceInput: reserveResourceInput,
				validatedInput: inputFor,
				read,
			})
		: undefined;
	return {
		...(executor ? { executor } : {}),
		render,
		read,
		deliverable,
		async create(
			claim: SessionSandboxReserveWorkerClaimV1,
			object: KubernetesObject,
			signal?: AbortSignal,
		): Promise<KubernetesObject> {
			signal?.throwIfAborted();
			identityClaim(claim);
			if (
				claim.status !== "preparing" ||
				!claim.leaseOwner ||
				!Number.isSafeInteger(claim.deliveryFence) ||
				claim.deliveryFence < 1
			)
				throw new WorkloadKubernetesError("conflict");
			const expected = (await render(claim)).find(
				(entry) => entry.kind === object.kind,
			);
			if (
				!expected ||
				sessionSandboxReserveDigestV1(expected) !==
					sessionSandboxReserveDigestV1(object)
			)
				throw new WorkloadKubernetesError("conflict");
			if (!(await deliverable(claim)))
				throw new WorkloadKubernetesError("policy");
			if (
				preparation &&
				claim.executorStartup &&
				Date.now() >= claim.executorStartup.deadlineMs
			)
				throw new WorkloadKubernetesError("conflict");
			const result = await client.create(expected);
			// Keep the actual response available even if cancellation follows it;
			// controller must commit the original write outcome before stopping.
			const input = inputFor(claim);
			if (!sessionSandboxResourceMatchesV1(result, expected, input))
				throw new WorkloadKubernetesError("conflict");
			return result;
		},
		async remove(
			claim: SessionSandboxReserveWorkerClaimV1,
			identity: SessionSandboxResourceIdentityV1,
			signal?: AbortSignal,
		): Promise<"acknowledged" | "absent"> {
			signal?.throwIfAborted();
			identityClaim(claim);
			if (
				claim.status !== "retiring" ||
				!claim.leaseOwner ||
				!Number.isSafeInteger(claim.deliveryFence) ||
				claim.deliveryFence < 1 ||
				identity.kind === "StatefulSet" ||
				identity.kind === "Sandbox" ||
				identity.namespace !== client.namespace ||
				identity.name !== `sandbox-${claim.sandboxId}`
			)
				throw new WorkloadKubernetesError("conflict");
			const original = claim.operations.find(
				(entry) => entry.operation === "create" && entry.kind === identity.kind,
			)?.resource;
			if (!original || original.uid !== identity.uid)
				throw new WorkloadKubernetesError("conflict");
			const current = await read(claim, identity.kind);
			if (!current) return "absent";
			const observed = resourceIdentity(current);
			if (
				observed.uid !== identity.uid ||
				observed.resourceVersion !== identity.resourceVersion
			)
				throw new WorkloadKubernetesError("conflict");
			// Only the conditional-result method distinguishes a DELETE response
			// from a 404 absence. A void delete can swallow that distinction.
			if (!client.deleteResult) throw new WorkloadKubernetesError("policy");
			return client.deleteResult(current);
		},
		async bootstrap(
			claim: SessionSandboxReserveObservationV1,
			resources: readonly KubernetesObject[],
			signal?: AbortSignal,
		): Promise<{
			bootstrapReady: boolean;
			businessStateAbsent: boolean;
			instanceEvidence?: import("@agent-infra/platform-core").SessionSandboxInstanceEvidenceV1;
		}> {
			signal?.throwIfAborted();
			const unavailable = { bootstrapReady: false, businessStateAbsent: false };
			identityClaim(claim);
			if (
				!["preparing", "ready"].includes(claim.status) ||
				resources.length !== 6 ||
				new Set(resources.map((r) => r.kind)).size !== 6
			)
				return unavailable;
			const input = inputFor(claim);
			// A reserve that would hand an old Consumer to a business Session is never ready.
			try {
				if (!(await deliverable(claim))) return unavailable;
			} catch {
				return unavailable;
			}
			const expected = await render(claim);
			const observed: KubernetesObject[] = [];
			for (const resource of expected) {
				const kind = resource.kind as SessionSandboxReserveResourceKindV1;
				const operation = claim.operations.find(
					(entry) => entry.operation === "create" && entry.kind === kind,
				);
				if (
					operation?.status !== "confirmed" ||
					operation?.writeCompletion !== "response" ||
					!operation.resource
				)
					return unavailable;
				const current = await read(claim, kind);
				if (!current || current.metadata?.uid !== operation.resource.uid)
					return unavailable;
				observed.push(current);
			}
			const pod = observed.find((r) => r.kind === "Pod") as V1Pod;
			const service = observed.find((r) => r.kind === "Service") as V1Service;
			const status = pod.status?.containerStatuses?.find(
				(entry) => entry.name === sessionSandboxRuntimeContainerName,
			);
			if (
				pod.status?.phase !== "Running" ||
				!pod.status.conditions?.some(
					(c) => c.type === "Ready" && c.status === "True",
				) ||
				!status?.imageID?.endsWith(
					input.runtime?.sessionExecutor
						? claim.profile.policy.imageDigest
						: `@${claim.profile.policy.imageDigest}`,
				) ||
				service.metadata?.name !== input.serviceName
			)
				return unavailable;
			const endpoints = await client.read<V1Endpoints>(
				"Endpoints",
				input.serviceName,
			);
			const subsets = endpoints?.subsets ?? [];
			const addresses = subsets.flatMap((subset) => subset.addresses ?? []);
			if (
				endpoints?.metadata?.namespace !== input.namespace ||
				endpoints.metadata.name !== input.serviceName ||
				addresses.length !== 1 ||
				addresses[0]?.targetRef?.uid !== pod.metadata?.uid ||
				addresses[0]?.targetRef?.kind !== "Pod" ||
				addresses[0]?.targetRef?.name !== input.podName ||
				addresses[0]?.targetRef?.namespace !== input.namespace ||
				addresses[0]?.ip !== pod.status.podIP ||
				subsets.some((subset) => (subset.notReadyAddresses?.length ?? 0) > 0) ||
				!subsets.some((subset) =>
					subset.ports?.some(
						(port) =>
							port.port === input.containerPort &&
							(port.protocol ?? "TCP") === "TCP",
					),
				)
			)
				return unavailable;
			let response: Response;
			if (input.runtime?.sessionExecutor) {
				if (!executor || (await executor.readProjection(claim, signal)))
					return unavailable;
				const instanceEvidence = await executor.readInstance(
					claim,
					observed,
					signal,
				);
				return instanceEvidence
					? {
							bootstrapReady: true,
							businessStateAbsent: true,
							instanceEvidence,
						}
					: unavailable;
			}
			try {
				response = await fetcher(
					`http://${input.serviceName}.${input.namespace}.svc:${input.containerPort}/healthz`,
					{
						signal: signal
							? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
							: AbortSignal.timeout(10_000),
						redirect: "error",
						credentials: "omit",
					},
				);
				await response.body?.cancel();
			} catch {
				return unavailable;
			}
			// Fresh PVC creation, six exact original UIDs, no prior business
			// calls, and the Store's final atomic absence check jointly prove
			// this reserve has never been handed to a business Conversation.
			return { bootstrapReady: response.ok, businessStateAbsent: response.ok };
		},
	};
}

export type SessionSandboxReserveAdapterV1 = ReturnType<
	typeof createSessionSandboxReserveAdapterV1
>;
