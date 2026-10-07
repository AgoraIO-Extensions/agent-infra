import { createPublicKey } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type ApprovedConnectionConsumerTargetV1,
	resolveApprovedConnectionConsumerProfileV1,
} from "@agent-infra/contracts/connection-consumer-profile";
import {
	type AgentWorkloadDesiredV1,
	validateAgentWorkloadDesiredV1,
} from "@agent-infra/contracts/workload";
import {
	type RuntimeModelProjectionV4,
	runtimeModelInjectionV4,
	validateRuntimeModelProjectionV4,
} from "@agent-infra/model-catalog";
import type { SessionSandboxDeletionProgressV1 } from "@agent-infra/platform-core";
import {
	ConversationRuntimeHostError,
	type SessionSandboxReconciliationClaimV1,
} from "@agent-infra/platform-core";
import type { V1Service } from "@kubernetes/client-node";
import type { ConversationRuntimeOptionsV2 } from "./conversation-runtime.js";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import { workloadResourceNameV1 } from "./kubernetes-runtime-adapter.js";
import {
	createSessionSandboxWorkloadAdapterV1,
	type SessionSandboxAllocationV1,
	type SessionSandboxRuntimeInputV1,
	sessionSandboxIdentityAnnotationsV1,
	sessionSandboxLabelsV1,
	sessionSandboxServiceTokenV1,
} from "./session-workload-adapter.js";
import {
	createWorkloadRuntimeV1,
	isWorkloadExecutionCapacityCurrentV1,
	type WorkloadRuntimeOptionsV1,
	workloadResourceConfigurationHashV1,
} from "./workload-runtime.js";
import { validateWorkloadRuntimeAuthV1 } from "./workload-runtime-auth.js";

type ConnectionConsumerTargetV1 = ApprovedConnectionConsumerTargetV1;

function approvedConnectionConsumerTarget(
	profile: unknown,
	approval: unknown,
	required = false,
): ConnectionConsumerTargetV1 | undefined {
	const hasProfile = profile !== undefined;
	const hasApproval = approval !== undefined;
	if (!hasProfile && !hasApproval) {
		if (!required) return undefined;
		throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
	}
	if (!hasProfile || !hasApproval)
		throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
	const result = resolveApprovedConnectionConsumerProfileV1(profile, approval);
	if (result.status !== "available")
		throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
	return {
		...result,
		url: result.profile.publicOrigin + result.profile.mcpPath,
	};
}

/** Resolve the immutable target prepared from a deployment-owned profile. */
export function resolveApprovedConnectionConsumerTargetV1(
	profile: unknown,
	approval: unknown,
): ConnectionConsumerTargetV1 | undefined {
	return approvedConnectionConsumerTarget(profile, approval);
}

/** Resolve only a currently observed Workload through the existing deployment adapter. */
export function createProductionConversationRuntimeResolverV2(options: {
	readonly workload: WorkloadRuntimeOptionsV1;
	readonly signing: ConversationRuntimeOptionsV2["signing"];
	readonly serviceToken: string;
	readonly connectionConsumerProfile?: unknown;
	readonly connectionConsumerApproval?: unknown;
	readonly requireConnectionConsumerProfile?: boolean;
}): ConversationRuntimeOptionsV2["resolveRuntimeHost"] {
	const { workload, signing, serviceToken } = options;
	const connectionConsumer = approvedConnectionConsumerTarget(
		options.connectionConsumerProfile,
		options.connectionConsumerApproval,
		options.requireConnectionConsumerProfile,
	);
	const auth = workload.policy.runtimeAuth;
	try {
		if (!auth) throw new Error();
		validateWorkloadRuntimeAuthV1(auth);
		if (
			auth.workerId !== signing.workerId ||
			auth.grantIssuer !== signing.issuer ||
			auth.grantKeyId !== signing.keyId ||
			createPublicKey(signing.privateKey)
				.export({ type: "spki", format: "pem" })
				.toString()
				.trim() !== auth.grantPublicKey.trim() ||
			typeof serviceToken !== "string" ||
			!/^[\x21-\x7e]{1,8192}$/.test(serviceToken)
		)
			throw new Error();
	} catch {
		throw new TypeError(
			"Conversation Runtime deployment authorization is invalid",
		);
	}
	const runtime = createWorkloadRuntimeV1(workload);
	return async (input) => {
		try {
			input.signal.throwIfAborted();
			const state = input.workload;
			const controlSource = input.sandboxResource?.controlSource;
			if (
				input.purpose === "control" &&
				input.conversationId &&
				controlSource
			) {
				const sourceDeployment = validateAgentWorkloadDesiredV1(
					controlSource.deployment,
				);
				const service = controlSource.observation?.resources.find(
					(resource) => resource.kind === "Service",
				);
				if (
					sourceDeployment.agentId !== input.agentId ||
					controlSource.sandbox.sessionId !== input.conversationId ||
					controlSource.sandbox.agentId !== input.agentId ||
					controlSource.sandbox.generation !== input.sessionGeneration ||
					controlSource.sandbox.workspaceScope !==
						controlSource.sandbox.sandboxId ||
					!controlSource.policy ||
					controlSource.policy.namespace !== workload.policy.namespace ||
					controlSource.policy.imageDigest !== sourceDeployment.imageDigest ||
					controlSource.policy.configurationRevision !==
						sourceDeployment.configRevision ||
					controlSource.policy.workloadRevision !==
						sourceDeployment.workloadRevision ||
					controlSource.resourceFence >= input.sandboxResource.resourceFence ||
					!service ||
					service.name !== controlSource.sandbox.resourceName ||
					service.namespace !== controlSource.policy.namespace ||
					input.sandboxResource.status === "ready" ||
					input.sandboxResource.desiredState !== "stopped"
				)
					throw new Error();
				const liveService = await workload.client.read<V1Service>(
					"Service",
					service.name,
				);
				input.signal.throwIfAborted();
				const expectedLabels = sessionSandboxLabelsV1(controlSource.sandbox);
				const expectedIdentity = sessionSandboxIdentityAnnotationsV1(
					controlSource.sandbox,
				);
				const port = liveService?.spec?.ports?.[0];
				if (
					workload.client.namespace !== service.namespace ||
					!service.uid ||
					liveService?.metadata?.uid !== service.uid ||
					!liveService.metadata.resourceVersion ||
					liveService.metadata.namespace !== service.namespace ||
					liveService.metadata.name !== service.name ||
					liveService.metadata.deletionTimestamp ||
					liveService.metadata.annotations?.["agent-infra.agora.io/managed"] !==
						"session-sandbox-v1" ||
					liveService.metadata.annotations?.["agent-infra.agora.io/fence"] !==
						String(controlSource.resourceFence) ||
					Object.entries(expectedLabels).some(
						([key, value]) =>
							liveService.metadata?.labels?.[key] !== value ||
							liveService.spec?.selector?.[key] !== value,
					) ||
					Object.entries(expectedIdentity).some(
						([key, value]) =>
							liveService.metadata?.annotations?.[key] !== value,
					) ||
					Object.keys(liveService.spec?.selector ?? {}).length !==
						Object.keys(expectedLabels).length ||
					liveService.spec?.type !== "ClusterIP" ||
					liveService.spec.ports?.length !== 1 ||
					port?.name !== "runtime" ||
					port.port !== sourceDeployment.service.port ||
					port.targetPort !== sourceDeployment.service.port ||
					(port.protocol !== undefined && port.protocol !== "TCP")
				)
					throw new Error();
				return {
					baseUrl: `http://${service.name}.${service.namespace}.svc:${sourceDeployment.service.port}`,
					// The source Sandbox's own token; the deployment token is never sent.
					serviceToken: sessionSandboxServiceTokenV1(
						serviceToken,
						service.namespace,
						controlSource.sandbox.sandboxId,
					),
					workerId: signing.workerId,
					connectionConsumer,
				};
			}
			if (
				!state ||
				state.agentId !== input.agentId ||
				!state.identity ||
				(input.purpose === "business" && state.phase !== "ready")
			)
				throw new Error();
			const deployment = validateAgentWorkloadDesiredV1(
				input.purpose === "control"
					? state.verified?.deployment
					: state.candidate.deployment,
			);
			if (
				deployment.agentId !== input.agentId ||
				deployment.runtimeManifest.interactionMode !== "platform-adapter"
			)
				throw new Error();
			// observe checks actual ownership, UID/generation, Pod/spec/Secret/network
			// drift, health and signed Runtime readiness; it never changes resources.
			const health = await (input.purpose === "control"
				? runtime.observeVerifiedControl(state)
				: runtime.observe(state));
			if (health !== "healthy") throw new Error();
			if (
				input.purpose === "business" &&
				input.command === "turn.submit" &&
				!isWorkloadExecutionCapacityCurrentV1(workload, state)
			)
				throw new Error();
			// Session runtime routing consumes the Store's locked, ready resource
			// receipt. This resolver never mutates Kubernetes or trusts request fields.
			const sandboxResource = input.sandboxResource;
			if (input.conversationId) {
				const service = sandboxResource?.observation?.resources.find(
					(resource) => resource.kind === "Service",
				);
				if (
					sandboxResource?.status !== "ready" ||
					sandboxResource.desiredState !== "running" ||
					sandboxResource.sandbox.sessionId !== input.conversationId ||
					sandboxResource.sandbox.agentId !== input.agentId ||
					sandboxResource.sandbox.generation !== input.sessionGeneration ||
					sandboxResource.sandbox.workspaceScope !==
						sandboxResource.sandbox.sandboxId ||
					!service ||
					service.name !== sandboxResource.sandbox.resourceName ||
					service.namespace !== workload.policy.namespace ||
					!sandboxResource.policy ||
					sandboxResource.policy.imageDigest !== deployment.imageDigest ||
					sandboxResource.policy.configurationRevision !==
						state.sourceConfigurationRevision ||
					sandboxResource.policy.workloadRevision !==
						state.sourceLifecycleRevision ||
					sandboxResource.policy.resourceConfigurationHash !==
						workloadResourceConfigurationHashV1(workload.policy)
				)
					throw new Error();
				const liveService = await workload.client.read<V1Service>(
					"Service",
					service.name,
				);
				input.signal.throwIfAborted();
				const expectedLabels = sessionSandboxLabelsV1(sandboxResource.sandbox);
				const expectedIdentity = sessionSandboxIdentityAnnotationsV1(
					sandboxResource.sandbox,
				);
				const livePort = liveService?.spec?.ports?.[0];
				if (
					!service.uid ||
					liveService?.metadata?.uid !== service.uid ||
					!liveService.metadata.resourceVersion ||
					liveService.metadata.deletionTimestamp ||
					liveService.metadata.namespace !== service.namespace ||
					liveService.metadata.name !== service.name ||
					liveService.metadata.annotations?.["agent-infra.agora.io/managed"] !==
						"session-sandbox-v1" ||
					liveService.metadata.annotations?.["agent-infra.agora.io/fence"] !==
						String(sandboxResource.resourceFence) ||
					Object.entries(expectedLabels).some(
						([key, value]) =>
							liveService.metadata?.labels?.[key] !== value ||
							liveService.spec?.selector?.[key] !== value,
					) ||
					Object.entries(expectedIdentity).some(
						([key, value]) =>
							liveService.metadata?.annotations?.[key] !== value,
					) ||
					Object.keys(liveService.spec?.selector ?? {}).length !==
						Object.keys(expectedLabels).length ||
					liveService.spec?.type !== "ClusterIP" ||
					liveService.spec.ports?.length !== 1 ||
					livePort?.name !== "runtime" ||
					livePort.port !== deployment.service.port ||
					livePort.targetPort !== deployment.service.port ||
					(livePort.protocol !== undefined && livePort.protocol !== "TCP") ||
					liveService.spec.externalIPs?.length ||
					liveService.spec.externalName
				)
					throw new Error();
				return {
					// Session sandboxes use their own Service contract; the bound Service
					// is consumed in-cluster over plaintext HTTP (ADR-0020).
					baseUrl: `http://${service.name}.${service.namespace}.svc:${deployment.service.port}`,
					// Bound to this Sandbox (#1466); Agent-level routes keep the deployment token.
					serviceToken: sessionSandboxServiceTokenV1(
						serviceToken,
						service.namespace,
						sandboxResource.sandbox.sandboxId,
					),
					workerId: signing.workerId,
					connectionConsumer,
				};
			}
			input.signal.throwIfAborted();
			const service = `${workloadResourceNameV1(input.agentId)}${input.purpose === "control" ? "-probe" : ""}`;
			return {
				baseUrl: `http://${service}.${workload.policy.namespace}.svc:${deployment.service.port}`,
				serviceToken,
				workerId: signing.workerId,
				connectionConsumer,
			};
		} catch {
			input.signal.throwIfAborted();
			throw new ConversationRuntimeHostError(
				"RUNTIME_WORKLOAD_UNAVAILABLE",
				true,
			);
		}
	};
}

/** Picks the deployment-approved egress fields; other policy fields never widen it. */
function sessionSandboxEgressPolicyV1(
	policy: WorkloadRuntimeOptionsV1["policy"],
): SessionSandboxAllocationV1["egress"] {
	return {
		...(policy.modelEgress ? { modelEgress: policy.modelEgress } : {}),
		...(policy.connectionEgress
			? { connectionEgress: policy.connectionEgress }
			: {}),
		...(policy.dnsEgress ? { dnsEgress: policy.dnsEgress } : {}),
	};
}

/** Production resource receiver; invoked only under the original Store lease. */
export function createProductionSessionSandboxReceiverV1(
	workload: WorkloadRuntimeOptionsV1,
	options: { readonly serviceToken: string },
) {
	const adapter = createSessionSandboxWorkloadAdapterV1({
		client: workload.client,
	});
	const connectionInstallationRevision =
		workload.policy.connectionInstallationRevision;
	/**
	 * Session Runtime inputs come only from the Store-verified V4 projection and
	 * the Worker's runtime auth (#1466). Anything else fails before any write.
	 */
	const runtimeFor = (
		binding: SessionSandboxReconciliationClaimV1["sandbox"],
		policy: SessionSandboxReconciliationClaimV1["policy"],
		deployment: AgentWorkloadDesiredV1,
		modelProjection: unknown,
	): SessionSandboxRuntimeInputV1 => {
		const auth = workload.policy.runtimeAuth;
		let projection: RuntimeModelProjectionV4;
		try {
			if (
				!auth ||
				!modelProjection ||
				typeof modelProjection !== "object" ||
				(modelProjection as { schemaVersion?: unknown }).schemaVersion !== 4
			)
				throw new Error();
			validateWorkloadRuntimeAuthV1(auth);
			projection = validateRuntimeModelProjectionV4(modelProjection);
		} catch {
			throw new WorkloadKubernetesError("policy");
		}
		const templateBinding = projection.standardTemplateBinding;
		if (
			!auth ||
			projection.agentId !== deployment.agentId ||
			projection.agentId !== binding.agentId ||
			projection.configurationRevision !== deployment.configRevision ||
			templateBinding.imageDigest !== deployment.imageDigest ||
			templateBinding.driver !== "codex" ||
			deployment.runtimeManifest.interactionMode !== "platform-adapter" ||
			!workload.templateModelBindings.some((trusted) =>
				isDeepStrictEqual({ ...trusted }, templateBinding),
			) ||
			// Agent-level Secrets are never mounted into a Session Sandbox.
			deployment.secretRefs.length > 0
		)
			throw new WorkloadKubernetesError("policy");
		return {
			driver: "codex",
			modelConfiguration: runtimeModelInjectionV4(projection).configuration,
			workerId: auth.workerId,
			grantKeyId: auth.grantKeyId,
			grantPublicKey: auth.grantPublicKey,
			grantIssuer: auth.grantIssuer,
			serviceToken: sessionSandboxServiceTokenV1(
				options.serviceToken,
				policy.namespace,
				binding.sandboxId,
			),
		};
	};
	const allocationFor = (
		binding: SessionSandboxReconciliationClaimV1["sandbox"],
		policy: SessionSandboxReconciliationClaimV1["policy"],
		deployment: AgentWorkloadDesiredV1,
		runtime: SessionSandboxRuntimeInputV1,
		desiredState: "running" | "stopped",
		generation: number,
		resourceFence: number,
	): SessionSandboxAllocationV1 => ({
		...binding,
		generation,
		resourceFence,
		namespace: policy.namespace,
		podName: binding.resourceName,
		serviceName: binding.resourceName,
		serviceAccountName: binding.resourceName,
		pvcName: binding.resourceName,
		networkPolicyName: binding.resourceName,
		secretName: binding.resourceName,
		// Only the reviewed deployment egress, identical to the Agent Workload's.
		egress: sessionSandboxEgressPolicyV1(workload.policy),
		imageDigest: `${workload.policy.imageRepository}@${deployment.imageDigest}`,
		containerPort: deployment.service.port,
		env: deployment.env,
		runtime,
		connectionConsumerSnapshot: workload.policy.connectionConsumerSnapshot,
		connectionInstallationRevision,
		authorizedIngressSelector: workload.policy.workerSelector,
		resources: workload.policy.resources,
		storageSize: workload.policy.storageSize,
		storageClassName: workload.policy.storageClassName,
		workspaceMountPath: "/workspace",
		desiredState,
	});
	return async (
		claim: SessionSandboxReconciliationClaimV1,
		signal: AbortSignal,
		recordDeletionProgress?: (
			progress: SessionSandboxDeletionProgressV1,
		) => Promise<"committed" | "stale" | "unknown">,
	) => {
		signal.throwIfAborted();
		if (claim.execution !== null)
			throw new Error("Sandbox reconcile has no execution");
		if (claim.purpose === "drain") {
			const lifecycle = claim.lifecycle;
			const source = lifecycle?.source;
			if (!lifecycle || !source?.policy || !source.deployment)
				throw new Error("Sandbox drain source is unavailable");
			const sourceDeployment = validateAgentWorkloadDesiredV1(
				source.deployment,
			);
			// The source keeps the projection it was prepared with (#1466).
			const sourceRuntime = runtimeFor(
				source.sandbox,
				source.policy,
				sourceDeployment,
				source.modelProjection,
			);
			const sourceAllocation = allocationFor(
				source.sandbox,
				source.policy,
				sourceDeployment,
				sourceRuntime,
				"running",
				source.sandbox.generation,
				source.resourceFence,
			);
			const sourceResources = source.observation?.resources ?? [];
			const completeSource =
				sourceResources.length >= 6 &&
				[
					"Pod",
					"Service",
					"ServiceAccount",
					"PersistentVolumeClaim",
					"NetworkPolicy",
					"Secret",
				].every((kind) =>
					sourceResources.some((resource) => resource.kind === kind),
				);
			if (!completeSource) {
				const observed = await adapter.observe(
					sourceAllocation,
					sourceResources,
					"control",
				);
				signal.throwIfAborted();
				return {
					status:
						observed.status === "unknown"
							? ("unknown" as const)
							: ("observed" as const),
					resources:
						observed.status === "unknown" && source.observation
							? sourceResources
							: observed.resources,
				};
			}
			if (
				!claim.drainComputeAllowed ||
				lifecycle.stopReceipt ||
				lifecycle.preparation
			)
				return {
					status: "unknown" as const,
					resources: sourceResources,
				};
			const allocation = allocationFor(
				claim.sandbox,
				source.policy,
				sourceDeployment,
				sourceRuntime,
				"stopped",
				source.sandbox.generation,
				source.resourceFence,
			);
			if (!recordDeletionProgress)
				throw new Error("Session Sandbox deletion CAS is unavailable");
			const stopReceipt = await adapter.cleanup(allocation, sourceResources, {
				sourceGeneration: source.sandbox.generation,
				sourceResourceFence: source.resourceFence,
				targetGeneration: claim.sandbox.generation,
				targetResourceFence: claim.resourceFence,
				managementFence: lifecycle.authority.managementFence,
				deletionProgress: lifecycle.deletionProgress,
				recordDeletionProgress,
			});
			signal.throwIfAborted();
			return {
				status: "stopped" as const,
				sourceStop: stopReceipt,
				resources: [stopReceipt.retainedPVC],
			};
		}
		const deployment = validateAgentWorkloadDesiredV1(claim.deployment);
		if (
			claim.operation !== "conversation.sandbox.reconcile.v1" ||
			deployment.agentId !== claim.sandbox.agentId ||
			deployment.configRevision !== claim.policy.configurationRevision ||
			deployment.workloadRevision !== claim.policy.workloadRevision ||
			deployment.imageDigest !== claim.policy.imageDigest ||
			claim.policy.namespace !== workload.policy.namespace ||
			claim.policy.resourceConfigurationHash !==
				workloadResourceConfigurationHashV1(workload.policy)
		)
			throw new Error("SessionSandbox verified policy is unavailable");
		// V4-only: a static-key or missing projection fails before any write.
		const runtime = runtimeFor(
			claim.sandbox,
			claim.policy,
			deployment,
			claim.modelProjection,
		);
		const allocation = allocationFor(
			claim.sandbox,
			claim.policy,
			deployment,
			runtime,
			claim.desiredState,
			claim.sandbox.generation,
			claim.resourceFence,
		);
		const previous = claim.previousObservation?.resources ?? [];
		if (claim.desiredState === "stopped") {
			if (!recordDeletionProgress)
				throw new Error("Session Sandbox deletion CAS is unavailable");
			const stopReceipt = await adapter.cleanup(allocation, previous, {
				sourceGeneration: claim.sandbox.generation,
				sourceResourceFence: claim.resourceFence,
				targetGeneration: claim.sandbox.generation,
				targetResourceFence: claim.resourceFence,
				managementFence: claim.lifecycle?.authority.managementFence,
				deletionProgress: claim.lifecycle?.deletionProgress,
				recordDeletionProgress,
			});
			signal.throwIfAborted();
			return {
				status: "stopped" as const,
				sourceStop: stopReceipt,
				resources: [stopReceipt.retainedPVC],
			};
		}
		let previousForApply = previous;
		if (claim.lifecycle?.stopReceipt) {
			await adapter.prepareRetainedPVC(allocation, claim.lifecycle, previous);
			signal.throwIfAborted();
			// The retained PVC was just rebound by the authorized CAS above; its
			// target identity is checked by the normal apply readback below.
			previousForApply = previous.filter(
				(resource) => resource.kind !== "PersistentVolumeClaim",
			);
		}
		await adapter.apply(allocation, previousForApply);
		signal.throwIfAborted();
		return adapter.observe(allocation, previous);
	};
}
