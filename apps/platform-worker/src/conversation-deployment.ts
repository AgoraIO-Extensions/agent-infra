import { createPublicKey } from "node:crypto";
import {
	type AgentWorkloadDesiredV1,
	validateAgentWorkloadDesiredV1,
} from "@agent-infra/contracts/workload";
import {
	ConversationRuntimeHostError,
	type SessionSandboxReconciliationClaimV1,
} from "@agent-infra/platform-core";
import type { ConversationRuntimeOptionsV2 } from "./conversation-runtime.js";
import { workloadResourceNameV1 } from "./kubernetes-runtime-adapter.js";
import {
	createSessionSandboxWorkloadAdapterV1,
	type SessionSandboxAllocationV1,
} from "./session-workload-adapter.js";
import {
	createWorkloadRuntimeV1,
	isWorkloadExecutionCapacityCurrentV1,
	type WorkloadRuntimeOptionsV1,
	workloadResourceConfigurationHashV1,
} from "./workload-runtime.js";
import { validateWorkloadRuntimeAuthV1 } from "./workload-runtime-auth.js";

/** Resolve only a currently observed Workload through the existing deployment adapter. */
export function createProductionConversationRuntimeResolverV2(options: {
	readonly workload: WorkloadRuntimeOptionsV1;
	readonly signing: ConversationRuntimeOptionsV2["signing"];
	readonly serviceToken: string;
}): ConversationRuntimeOptionsV2["resolveRuntimeHost"] {
	const { workload, signing, serviceToken } = options;
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
				return {
					baseUrl: `http://${service.name}.${service.namespace}.svc:${sourceDeployment.service.port}`,
					serviceToken,
					workerId: signing.workerId,
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
				return {
					// Session sandboxes use their own Service contract; Agent runtime TLS
					// policy does not imply that sandbox resources expose TLS.
					baseUrl: `http://${service.name}.${service.namespace}.svc:${deployment.service.port}`,
					serviceToken,
					workerId: signing.workerId,
				};
			}
			input.signal.throwIfAborted();
			const service = `${workloadResourceNameV1(input.agentId)}${input.purpose === "control" ? "-probe" : ""}`;
			return {
				baseUrl: `${workload.policy.runtimeTls?.some((binding) => binding.agentId === input.agentId) ? "https" : "http"}://${service}.${workload.policy.namespace}.svc:${deployment.service.port}`,
				serviceToken,
				workerId: signing.workerId,
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

/** Production resource receiver; invoked only under the original Store lease. */
export function createProductionSessionSandboxReceiverV1(
	workload: WorkloadRuntimeOptionsV1,
) {
	const adapter = createSessionSandboxWorkloadAdapterV1({
		client: workload.client,
	});
	const allocationFor = (
		binding: SessionSandboxReconciliationClaimV1["sandbox"],
		policy: SessionSandboxReconciliationClaimV1["policy"],
		deployment: AgentWorkloadDesiredV1,
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
		imageDigest: `${workload.policy.imageRepository}@${deployment.imageDigest}`,
		containerPort: deployment.service.port,
		env: deployment.env,
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
			const sourceAllocation = allocationFor(
				source.sandbox,
				source.policy,
				sourceDeployment,
				"running",
				source.sandbox.generation,
				source.resourceFence,
			);
			const sourceResources = source.observation?.resources ?? [];
			const completeSource =
				sourceResources.length >= 5 &&
				[
					"Pod",
					"Service",
					"ServiceAccount",
					"PersistentVolumeClaim",
					"NetworkPolicy",
				].every((kind) =>
					sourceResources.some((resource) => resource.kind === kind),
				);
			if (!completeSource) {
				const observed = await adapter.observe(
					sourceAllocation,
					sourceResources,
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
				"stopped",
				source.sandbox.generation,
				source.resourceFence,
			);
			const stopReceipt = await adapter.cleanup(allocation, sourceResources, {
				sourceGeneration: source.sandbox.generation,
				sourceResourceFence: source.resourceFence,
				targetGeneration: claim.sandbox.generation,
				targetResourceFence: claim.resourceFence,
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
		const resourceName = claim.sandbox.resourceName;
		const allocation: SessionSandboxAllocationV1 = {
			...claim.sandbox,
			resourceFence: claim.resourceFence,
			namespace: workload.policy.namespace,
			podName: resourceName,
			serviceName: resourceName,
			serviceAccountName: resourceName,
			pvcName: resourceName,
			networkPolicyName: resourceName,
			imageDigest: `${workload.policy.imageRepository}@${deployment.imageDigest}`,
			containerPort: deployment.service.port,
			env: deployment.env,
			authorizedIngressSelector: workload.policy.workerSelector,
			resources: workload.policy.resources,
			storageSize: workload.policy.storageSize,
			storageClassName: workload.policy.storageClassName,
			workspaceMountPath: "/workspace",
			desiredState: claim.desiredState,
		};
		const previous = claim.previousObservation?.resources ?? [];
		if (claim.desiredState === "stopped") {
			const stopReceipt = await adapter.cleanup(allocation, previous, {
				sourceGeneration: claim.sandbox.generation,
				sourceResourceFence: claim.resourceFence,
				targetGeneration: claim.sandbox.generation,
				targetResourceFence: claim.resourceFence,
			});
			signal.throwIfAborted();
			return {
				status: "stopped" as const,
				sourceStop: stopReceipt,
				resources: [stopReceipt.retainedPVC],
			};
		}
		await adapter.apply(allocation, previous);
		signal.throwIfAborted();
		return adapter.observe(allocation, previous);
	};
}
