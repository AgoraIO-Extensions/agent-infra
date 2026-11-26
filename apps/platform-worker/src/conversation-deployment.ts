import { createPublicKey } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	codexSessionExecutorAttestationV1,
	codexSessionExecutorBindingDigestV1,
	createCodexSessionExecutorBindingV1,
	requestCorePodAdmission,
	selectProviderDeploymentBinding,
} from "@agent-infra/agent-runtime";
import {
	type ApprovedConnectionConsumerTargetV1,
	resolveApprovedConnectionConsumerProfileV1,
} from "@agent-infra/contracts/connection-consumer-profile";
import type { BrowserCapabilityBindingV1 } from "@agent-infra/contracts/runtime";
import {
	type ExecutorInstanceMutationV2,
	type ExecutorInstanceStateV2,
	ExecutorInstanceStateV2Schema,
} from "@agent-infra/contracts/runtime";
import {
	type AgentWorkloadDesiredV1,
	type PlatformSecretRecordV1,
	validateAgentWorkloadDesiredV1,
	validatePlatformSecretRecordV1,
} from "@agent-infra/contracts/workload";
import {
	type RuntimeModelProjectionV4,
	runtimeModelInjectionV4,
	validateRuntimeModelProjectionV4,
} from "@agent-infra/model-catalog";
import type {
	SessionSandboxDeletionProgressV1,
	SessionSandboxResourceIdentityV1,
	SessionSandboxStopReceiptV1,
} from "@agent-infra/platform-core";
import {
	ConversationRuntimeHostError,
	type SessionSandboxObservationV1,
	type SessionSandboxReconciliationClaimV1,
	sessionSandboxFileExchangeTokenV1,
} from "@agent-infra/platform-core";
import type {
	V1Pod,
	V1Secret,
	V1Service,
	V1ServicePort,
} from "@kubernetes/client-node";
import {
	sessionExecutorAttestationSecretKeyV1,
	sessionExecutorBindingSecretKeyV1,
	validateCodexSessionExecutorPolicyV1,
} from "./codex-session-executor.js";
import {
	runtimeConnectionConsumerSnapshotForAgentV1,
	runtimeConnectionInstallationOAuthPublicationForAgentV1,
	runtimeConnectionInstallationRevisionForAgentV1,
} from "./connection-consumer-projection.js";
import type { ConnectionInstallBootstrapDeploymentV1 } from "./connection-install-bootstrap.js";
import { sessionSandboxConnectionInstallTokenV1 } from "./connection-install-readback-server.js";
import {
	type ConnectionManualPublicationV1,
	connectionManualPublicationProofV1,
	withConnectionManualPublicationV1,
} from "./connection-manual-publication.js";
import {
	containerBoundaryAttestationV1,
	sessionScopeAttestationV1,
} from "./container-boundary-attestation.js";
import type { ConversationRuntimeOptionsV2 } from "./conversation-runtime.js";
import { createExecutorInstanceControlV2 } from "./executor-instance-startup.js";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import { workloadResourceNameV1 } from "./kubernetes-runtime-adapter.js";
import { skillHubRuntimeBindingV1 } from "./kubernetes-runtime-skill-mount.js";
import { selectSessionOAuthProvisioningV1 } from "./session-oauth-provisioning-selection.js";
import {
	bindSessionSandboxCustomSecretMaterializationV1,
	createSessionSandboxWorkloadAdapterV1,
	hasSessionSandboxIdentityV1,
	isNativeMetadataWorkerOriginV1,
	SessionExecutorStartupExpiredV1,
	type SessionSandboxAllocationV1,
	type SessionSandboxCustomSecretMaterializationV1,
	type SessionSandboxOAuthProvisioningV1,
	type SessionSandboxResourceInputV1,
	type SessionSandboxRuntimeInputV1,
	sessionSandboxContainerBoundaryAttestationSecretKey,
	sessionSandboxFileExchangeSecretKey,
	sessionSandboxIdentityAnnotationsV1,
	sessionSandboxLabelsMatchV1,
	sessionSandboxLabelsV1,
	sessionSandboxRuntimeContainerName,
	sessionSandboxSelectorMatchesV1,
	sessionSandboxServiceTokenV1,
	sessionSandboxSessionScopeAttestationSecretKey,
	sessionSnapshotSecretNameV1,
} from "./session-workload-adapter.js";
import {
	matchesSigCoreSdkTrialBinding,
	runtimeTextOnlyEnv,
	sigCoreSdkTrialImageFromDeployment,
} from "./sig-core-sdk-trial.js";
import { workloadEgressRulesV1 } from "./workload-network.js";
import {
	createWorkloadRuntimeV1,
	drainCacheableCommands,
	isWorkloadExecutionCapacityCurrentV1,
	resolveWorkloadExecutionCapacityV1,
	type WorkloadRuntimeOptionsV1,
	workloadResourceConfigurationHashV1,
} from "./workload-runtime.js";
import { validateWorkloadRuntimeAuthV1 } from "./workload-runtime-auth.js";

type ConnectionConsumerTargetV1 = ApprovedConnectionConsumerTargetV1;
type ConnectionConsumerRuntimeTargetV1 = ConnectionConsumerTargetV1 & {
	readonly oauthClientId?: string;
};

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

/**
 * A Session Service routes only its `runtime` port, plus (#4199) the single
 * install listener port the Adapter renders from deployment configuration
 * when the install receiver is enabled (Spec §13.5.6). Any other or extra
 * port, or the install port while the receiver is disabled, is drift.
 */
function sessionServicePortsMatchV1(
	ports: readonly V1ServicePort[] | undefined,
	runtimePort: number,
	installPort: number | undefined,
) {
	const tcp = (protocol: string | undefined) =>
		protocol === undefined || protocol === "TCP";
	const [runtime, install, ...extra] = ports ?? [];
	if (
		!runtime ||
		runtime.name !== "runtime" ||
		runtime.port !== runtimePort ||
		runtime.targetPort !== runtimePort ||
		!tcp(runtime.protocol) ||
		extra.length > 0
	)
		return false;
	return (
		install === undefined ||
		(installPort !== undefined &&
			install.name === "oauth" &&
			install.port === installPort &&
			install.targetPort === installPort &&
			tcp(install.protocol))
	);
}

/** Resolve only a currently observed Workload through the existing deployment adapter. */
function usesPaseoSdkRuntime(modelProjection: unknown): boolean {
	if (
		!modelProjection ||
		typeof modelProjection !== "object" ||
		!("schemaVersion" in modelProjection) ||
		modelProjection.schemaVersion !== 4
	)
		return false;
	return (
		validateRuntimeModelProjectionV4(modelProjection).standardTemplateBinding
			.transport !== undefined
	);
}

export function createProductionConversationRuntimeResolverV2(options: {
	readonly workload: WorkloadRuntimeOptionsV1;
	readonly signing: ConversationRuntimeOptionsV2["signing"];
	readonly serviceToken: string;
	readonly executorDrainStartupTimeoutMs?: number;
	readonly connectionConsumerProfile?: unknown;
	readonly connectionConsumerApproval?: unknown;
	readonly connectionConsumerProfilesByAgent?: Readonly<
		Record<
			string,
			{
				readonly profile: unknown;
				readonly approval: unknown;
				readonly oauthClientBinding?: unknown;
			}
		>
	>;
	readonly requireConnectionConsumerProfile?: boolean;
	/**
	 * #4199: the deployment's install receiver. Eligible Sessions carry its one
	 * listener port on their Service (Spec §13.5.6), so routing accepts exactly
	 * that port and the observed allocation renders the same receiver.
	 */
	readonly connectionInstallBootstrap?: ConnectionInstallBootstrapDeploymentV1;
}): ConversationRuntimeOptionsV2["resolveRuntimeHost"] {
	const { workload, signing, serviceToken } = options;
	const staticProfile = structuredClone(options.connectionConsumerProfile);
	const staticApproval = structuredClone(options.connectionConsumerApproval);
	const perAgentProfiles = options.connectionConsumerProfilesByAgent
		? structuredClone(options.connectionConsumerProfilesByAgent)
		: undefined;
	if (!perAgentProfiles) {
		approvedConnectionConsumerTarget(
			staticProfile,
			staticApproval,
			options.requireConnectionConsumerProfile,
		);
	}
	const connectionConsumerFor = (agentId: string) => {
		const perAgent = perAgentProfiles?.[agentId];
		const perAgentSnapshots =
			workload.policy?.connectionConsumerSnapshotsByAgent;
		if (
			(perAgentProfiles || perAgentSnapshots) &&
			!perAgent &&
			(perAgentSnapshots === undefined ||
				!Object.hasOwn(perAgentSnapshots, agentId))
		)
			throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
		let profile = perAgent?.profile;
		let approval = perAgent?.approval;
		if (!perAgent && perAgentSnapshots) {
			try {
				const parsed = JSON.parse(perAgentSnapshots[agentId] ?? "null");
				profile = parsed?.profile;
				approval = parsed?.approval;
			} catch {
				throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
			}
		}
		if (!perAgent && !perAgentSnapshots) {
			profile = staticProfile;
			approval = staticApproval;
		}
		const target = approvedConnectionConsumerTarget(
			profile,
			approval,
			options.requireConnectionConsumerProfile,
		);
		if (perAgent?.oauthClientBinding !== undefined) {
			const binding = perAgent.oauthClientBinding;
			if (
				!binding ||
				typeof binding !== "object" ||
				Array.isArray(binding) ||
				Object.keys(binding).sort().join(",") !==
					"clientId,profileFingerprint,source"
			)
				throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
			const value = binding as Record<string, unknown>;
			const source = value.source;
			if (
				!target ||
				typeof value.clientId !== "string" ||
				value.clientId.length === 0 ||
				value.profileFingerprint !== target.configFingerprint ||
				!source ||
				typeof source !== "object" ||
				Array.isArray(source) ||
				typeof (source as Record<string, unknown>).ref !== "string" ||
				typeof (source as Record<string, unknown>).revision !== "string" ||
				(source as Record<string, unknown>).ref !== target.source.ref ||
				(source as Record<string, unknown>).revision !== target.source.revision
			)
				throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
			return {
				...target,
				oauthClientId: value.clientId,
			} satisfies ConnectionConsumerRuntimeTargetV1;
		}
		return target;
	};
	const auth = workload.policy?.runtimeAuth;
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
	const installPort = options.connectionInstallBootstrap?.port;
	const allocationFor = createSessionSandboxAllocationResolverV1(workload, {
		serviceToken,
		executorDrainStartupTimeoutMs: options.executorDrainStartupTimeoutMs,
		...(options.connectionInstallBootstrap
			? { connectionInstallBootstrap: options.connectionInstallBootstrap }
			: {}),
	});
	const sandboxAdapter = createSessionSandboxWorkloadAdapterV1({
		fetch: workload.fetch,
		client: workload.client,
		...(options.connectionInstallBootstrap
			? { connectionPublicationProofKey: serviceToken }
			: {}),
	});
	const connectionDeliveryConfigured =
		workload.policy.connectionConsumerSnapshot !== undefined ||
		workload.policy.connectionInstallationRevision !== undefined ||
		workload.policy.connectionConsumerSnapshotsByAgent !== undefined ||
		workload.policy.connectionInstallationRevisionsByAgent !== undefined;
	const sessionTransport = async (
		name: string,
		namespace: string,
		port: number,
		sandboxId: string,
		nativeCore: boolean,
		podUid: string | undefined,
		signal: AbortSignal,
	) => {
		const baseUrl = `http://${name}.${namespace}.svc:${port}`;
		const key = sessionSandboxServiceTokenV1(
			serviceToken,
			namespace,
			sandboxId,
		);
		if (!nativeCore) return { baseUrl, serviceToken: key };
		if (!podUid) throw new Error("Missing Core Pod identity");
		return {
			baseUrl,
			corePodAdmission: true as const,
			serviceToken: await requestCorePodAdmission(
				baseUrl,
				key,
				podUid,
				workload.fetch ?? fetch,
				signal,
			),
		};
	};
	return async (input) => {
		try {
			const connectionConsumer = connectionConsumerFor(input.agentId);
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
					// 升级前创建的 Service 没有 managed 标签和 selector 项（#2691）。
					!sessionSandboxLabelsMatchV1(
						liveService.metadata?.labels,
						expectedLabels,
					) ||
					!sessionSandboxSelectorMatchesV1(
						liveService.spec?.selector,
						expectedLabels,
					) ||
					Object.entries(expectedIdentity).some(
						([key, value]) =>
							liveService.metadata?.annotations?.[key] !== value,
					) ||
					liveService.spec?.type !== "ClusterIP" ||
					!sessionServicePortsMatchV1(
						liveService.spec.ports,
						sourceDeployment.service.port,
						installPort,
					)
				)
					throw new Error();
				return {
					...(await sessionTransport(
						service.name,
						service.namespace,
						sourceDeployment.service.port,
						controlSource.sandbox.sandboxId,
						!!controlSource.policy.podController &&
							!usesPaseoSdkRuntime(controlSource.modelProjection),
						controlSource.observation?.resources.find((r) => r.kind === "Pod")
							?.uid,
						input.signal,
					)),
					workerId: signing.workerId,
					connectionConsumer,
				};
			}
			if (
				!state ||
				state.agentId !== input.agentId ||
				!state.identity ||
				(input.purpose === "business" &&
					(state.phase !== "ready" ||
						(workload.policy.sigCoreSdkTrialImage &&
							(!input.conversationId ||
								input.sandboxResource?.policy?.podController !==
									"sig-core-v1.0.12"))))
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
			let sessionBrowserBinding: BrowserCapabilityBindingV1 | undefined;
			const sessionResourcePolicy =
				input.conversationId && input.sandboxResource?.policy
					? originalSessionResourcePolicy(
							workload.policy,
							input.sandboxResource.policy.resourceConfigurationHash,
						)
					: undefined;
			if (input.purpose === "business" && input.conversationId) {
				const sandboxResource = input.sandboxResource;
				if (
					sandboxResource?.status !== "ready" ||
					sandboxResource.desiredState !== "running" ||
					!sandboxResource.policy ||
					sandboxResource.sandbox.sessionId !== input.conversationId ||
					sandboxResource.sandbox.agentId !== input.agentId ||
					sandboxResource.sandbox.generation !== input.sessionGeneration ||
					sandboxResource.sandbox.workspaceScope !==
						sandboxResource.sandbox.sandboxId ||
					sandboxResource.policy.imageDigest !== deployment.imageDigest ||
					sandboxResource.policy.configurationRevision !==
						state.sourceConfigurationRevision ||
					sandboxResource.policy.workloadRevision !==
						deployment.workloadRevision ||
					!sessionResourcePolicy
				)
					throw new Error();
				sessionBrowserBinding = {
					agentId: input.agentId,
					sessionId: input.conversationId,
					sessionGeneration: sandboxResource.sandbox.generation,
					resourceFence: sandboxResource.resourceFence,
					workloadRevision: deployment.workloadRevision,
					imageDigest: deployment.imageDigest,
				};
			}
			// observe checks actual ownership, UID/generation, Pod/spec/Secret/network
			// drift and health; the final control resolution adds signed Runtime readiness.
			// 排空路径（business purpose + events.persist/events.ack/execution.renew）
			// 与同一次准备内的前置解析复用最近一次通过的签名 readiness，仅核对 K8s 路由与
			// Pod 就绪；提交等命令和 control 用途的发送前最后一次解析做完整签名探测。
			const isDrainPath =
				input.purpose === "business" &&
				((drainCacheableCommands as ReadonlySet<string>).has(input.command) ||
					// 同一次准备内的前置解析；发送前最后一次解析仍做完整探测（#2134）。
					input.reuseSignedReadiness === true);
			const health = await (input.purpose === "control"
				? input.skipControlReadiness === true
					? runtime.observeVerifiedControlRoute(state)
					: runtime.observeVerifiedControl(state)
				: isDrainPath
					? runtime.observeForDrain(state, sessionBrowserBinding)
					: sessionBrowserBinding
						? runtime.observeSession(state, sessionBrowserBinding)
						: runtime.observe(state));
			if (health !== "healthy") throw new Error();
			if (input.purpose === "business" && input.command === "turn.submit") {
				const capacity = state.verified?.executionCapacity;
				const agentPolicy =
					capacity &&
					originalSessionResourcePolicy(
						workload.policy,
						capacity.resourceConfigurationHash,
					);
				if (
					!agentPolicy ||
					!isWorkloadExecutionCapacityCurrentV1(
						{ ...workload, policy: agentPolicy },
						state,
					)
				)
					throw new Error();
				// Admission reserves against the verified Agent's limit. A retained Session
				// on the other compute must still have an approval covering that many slots.
				if (
					sessionResourcePolicy &&
					input.sandboxResource?.policy?.resourceConfigurationHash !==
						capacity.resourceConfigurationHash
				) {
					const original = resolveWorkloadExecutionCapacityV1(
						{ ...workload, policy: sessionResourcePolicy },
						deployment.imageDigest,
					);
					if (
						!original ||
						original.maximumConcurrentExecutions <
							capacity.maximumConcurrentExecutions
					)
						throw new Error();
				}
			}
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
					// The verified Workload revision, not the lifecycle revision (#1480).
					sandboxResource.policy.workloadRevision !==
						deployment.workloadRevision ||
					!sessionResourcePolicy
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
					// 升级前创建的 Service 没有 managed 标签和 selector 项（#2691）。
					!sessionSandboxLabelsMatchV1(
						liveService.metadata?.labels,
						expectedLabels,
					) ||
					!sessionSandboxSelectorMatchesV1(
						liveService.spec?.selector,
						expectedLabels,
					) ||
					Object.entries(expectedIdentity).some(
						([key, value]) =>
							liveService.metadata?.annotations?.[key] !== value,
					) ||
					liveService.spec?.type !== "ClusterIP" ||
					!sessionServicePortsMatchV1(
						liveService.spec.ports,
						deployment.service.port,
						installPort,
					) ||
					liveService.spec.externalIPs?.length ||
					liveService.spec.externalName
				)
					throw new Error();
				const requireSandboxObservation =
					input.purpose === "control" &&
					input.requireSandboxObservation === true;
				if (
					(input.purpose === "business" &&
						(connectionDeliveryConfigured ||
							sandboxResource.policy.podController !== undefined ||
							sandboxResource.executorInstance !== undefined)) ||
					requireSandboxObservation
				) {
					// Both principal facts come from the server's original execution/Store.
					if (
						!input.principal ||
						input.principal.kind !== sandboxResource.sandbox.principal.kind ||
						input.principal.id !== sandboxResource.sandbox.principal.id
					)
						throw new Error();
					// A ready Store receipt does not attest today's Session Pod delivery.
					const resources = sandboxResource.observation?.resources;
					const pods = resources?.filter((resource) => resource.kind === "Pod");
					const pod = pods?.[0];
					if (
						pods?.length !== 1 ||
						!pod?.uid ||
						pod.namespace !== workload.policy.namespace ||
						pod.name !== sandboxResource.sandbox.resourceName
					)
						throw new Error();
					let observedAllocation = await allocationFor(
						sandboxResource.sandbox,
						sandboxResource.policy,
						deployment,
						// The verified projection the Sandbox was prepared from (#1466).
						requireSandboxObservation
							? state.verified?.modelProjection
							: state.candidate.modelProjection,
						"running",
						sandboxResource.sandbox.generation,
						sandboxResource.resourceFence,
						true,
						// The recorded Session Secret is re-checked by identity (#3938).
						resources?.find((resource) => resource.kind === "Secret"),
					);
					if (sandboxResource.executorInstance) {
						const instance = sandboxResource.executorInstance;
						if (
							instance.phase !== "adopted" ||
							!instance.adoption ||
							instance.cleanup !== "absent"
						)
							throw new Error();
						if (
							input.purpose === "business" &&
							[
								"turn.submit",
								"turn.supplement",
								"native-capability.invoke",
							].includes(input.command) &&
							!workload.policy.executorInstanceStartupApprovals?.some(
								(x) =>
									x.schemaVersion === 2 &&
									x.imageDigest.endsWith(`@${deployment.imageDigest}`) &&
									x.verificationRef,
							)
						)
							throw new Error();
						observedAllocation = {
							...observedAllocation,
							executorDrainIdentity: true,
							executorStartupDeadline: instance.expiresAt,
							executorInstance: instance,
						};
					}
					const observed = await sandboxAdapter.observe(
						observedAllocation,
						resources,
					);
					input.signal.throwIfAborted();
					if (observed.status !== "ready") throw new Error();
				}
				return {
					// Session sandboxes use their own Service contract; the bound Service
					// is consumed in-cluster over plaintext HTTP (ADR-0020).
					...(await sessionTransport(
						service.name,
						service.namespace,
						deployment.service.port,
						sandboxResource.sandbox.sandboxId,
						!!sandboxResource.policy.podController &&
							!usesPaseoSdkRuntime(
								input.purpose === "control"
									? state.verified?.modelProjection
									: state.candidate.modelProjection,
							),
						sandboxResource.observation?.resources.find((r) => r.kind === "Pod")
							?.uid,
						input.signal,
					)),
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
	standard: boolean,
	snapshotEnabled = false,
): SessionSandboxAllocationV1["egress"] {
	return {
		...(standard && policy.nativeEgress
			? { nativeEgress: policy.nativeEgress }
			: {}),
		...(policy.modelEgress ? { modelEgress: policy.modelEgress } : {}),
		...(policy.connectionEgress
			? { connectionEgress: policy.connectionEgress }
			: {}),
		...(policy.nativeMetadataWorkerEgress
			? { nativeMetadataWorkerEgress: policy.nativeMetadataWorkerEgress }
			: {}),
		// #3289：与 Agent Workload 同一条部署声明；只在配置了文件交换 origin 时存在。
		...(policy.fileExchangeEgress
			? { fileExchangeEgress: policy.fileExchangeEgress }
			: {}),
		...(policy.workspaceSnapshotEgress && snapshotEnabled
			? { workspaceSnapshotEgress: policy.workspaceSnapshotEgress }
			: {}),
		...(policy.dnsEgress ? { dnsEgress: policy.dnsEgress } : {}),
	};
}

/** A compute default changes new allocations; the verified hash retains old placement. */
function originalSessionResourcePolicy(
	policy: WorkloadRuntimeOptionsV1["policy"],
	hash: string,
): WorkloadRuntimeOptionsV1["policy"] | undefined {
	if (workloadResourceConfigurationHashV1(policy) === hash) return policy;
	const { sessionRuntimePlacement: _placement, ...base } = policy;
	for (const placement of [
		undefined,
		{ architecture: "amd64", compute: "acs" },
	] as const) {
		const candidate = {
			...base,
			...(placement ? { sessionRuntimePlacement: placement } : {}),
		};
		if (workloadResourceConfigurationHashV1(candidate) === hash)
			return candidate;
	}
	return undefined;
}

/** Shared immutable resource inputs for real Sessions and unclaimed reserves. */
export function createSessionSandboxResourceInputResolverV1(
	workload: Pick<WorkloadRuntimeOptionsV1, "policy" | "templateModelBindings">,
	options: {
		readonly serviceToken: string;
		readonly oauthProvisioning?: SessionSandboxOAuthProvisioningV1;
		readonly connectionInstallBootstrap?: ConnectionInstallBootstrapDeploymentV1;
		readonly executorDrainStartupTimeoutMs?: number;
	},
) {
	const trialImage = sigCoreSdkTrialImageFromDeployment(
		workload.policy.sigCoreSdkTrialImage,
		workload.policy.namespace,
	);
	const egressPolicy = structuredClone(workload.policy);
	const install = options.connectionInstallBootstrap;
	if (workload.policy.codexSessionExecutor !== undefined)
		validateCodexSessionExecutorPolicyV1(workload.policy.codexSessionExecutor);
	workloadEgressRulesV1(egressPolicy);
	const connection = structuredClone({
		snapshot: workload.policy.connectionConsumerSnapshot,
		snapshotsByAgent: workload.policy.connectionConsumerSnapshotsByAgent,
		revision: workload.policy.connectionInstallationRevision,
		revisionsByAgent: workload.policy.connectionInstallationRevisionsByAgent,
		publication: workload.policy.connectionInstallationOAuthPublication,
		publicationsByAgent:
			workload.policy.connectionInstallationOAuthPublicationsByAgent,
	});
	/**
	 * Session Runtime inputs come only from the Store-verified V4 projection and
	 * the Worker's runtime auth (#1466). Anything else fails before any write.
	 */
	const runtimeFor = (
		binding: Omit<
			SessionSandboxReconciliationClaimV1["sandbox"],
			"principal" | "channelId"
		>,
		policy: SessionSandboxReconciliationClaimV1["policy"],
		deployment: AgentWorkloadDesiredV1,
		modelProjection: unknown,
		requireCurrentTemplateTrust: boolean,
		generation: number,
		resourceFence: number,
	): SessionSandboxRuntimeInputV1 | null => {
		const auth = workload.policy.runtimeAuth;
		// #3276：文件交换 origin 与 Agent Workload 同源（policy.runtimeAuth，已合并固定环境的
		// PLATFORM_WORKER_FILE_EXCHANGE_ORIGIN）。Sandbox 不拿部署 token，只拿按本分配
		// （namespace、Sandbox、代次、resourceFence）派生的值；未配置 origin 时不注入。
		const fileExchange = () => {
			if (auth?.fileExchangeOrigin === undefined) return {};
			try {
				return {
					fileExchange: {
						origin: auth.fileExchangeOrigin,
						serviceToken: sessionSandboxFileExchangeTokenV1(
							options.serviceToken,
							{
								namespace: policy.namespace,
								sandboxId: binding.sandboxId,
								generation,
								resourceFence,
							},
						),
					},
				};
			} catch {
				throw new WorkloadKubernetesError("policy");
			}
		};
		// Custom platform-adapter runtimes deliberately have no standard V4 model
		// projection. Their Owner secrets are copied by the Session adapter into a
		// Session-specific Secret; the claim carries references only.
		if (
			!modelProjection &&
			deployment.runtimeManifest.interactionMode === "platform-adapter" &&
			deployment.secretRefs.length > 0 &&
			deployment.secretRefs.every(
				(ref) =>
					ref.ownerType === "agent-owner" && ref.agentId === deployment.agentId,
			)
		) {
			if (
				!auth ||
				deployment.agentId !== binding.agentId ||
				(workload.policy.nativeMetadataWorkerEgress !== undefined &&
					!isNativeMetadataWorkerOriginV1(auth.nativeMetadataWorkerOrigin)) ||
				!deployment.secretRefs.length
			)
				throw new WorkloadKubernetesError("policy");
			validateWorkloadRuntimeAuthV1(auth);
			return {
				driver: "acp",
				modelConfiguration: "",
				workerId: auth.workerId,
				grantKeyId: auth.grantKeyId,
				grantPublicKey: auth.grantPublicKey,
				grantIssuer: auth.grantIssuer,
				nativeMetadataWorkerOrigin: auth.nativeMetadataWorkerOrigin,
				serviceToken: sessionSandboxServiceTokenV1(
					options.serviceToken,
					policy.namespace,
					binding.sandboxId,
				),
				...fileExchange(),
				custom: { secretRefs: deployment.secretRefs },
			};
		}
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
			// 排空（drain）路径不要求当前模板信任，且原 payload 未保存 modelProjection
			// （旧 payload 形状）时，返回 null runtime；adapter 的 cleanup/observe
			// 在 stopped 状态下不依赖 runtime 字段，可按标签与 UID 完成资源删除。
			// 工程 Spec §10.1.1：模板撤销不得阻断已获管理授权的原资源回收。
			if (!requireCurrentTemplateTrust && !modelProjection) return null;
			throw new WorkloadKubernetesError("policy");
		}
		const templateBinding = projection.standardTemplateBinding;
		if (
			!auth ||
			projection.agentId !== deployment.agentId ||
			projection.agentId !== binding.agentId ||
			projection.configurationRevision !== deployment.configRevision ||
			templateBinding.imageDigest !== deployment.imageDigest ||
			deployment.runtimeManifest.interactionMode !== "platform-adapter" ||
			(workload.policy.nativeMetadataWorkerEgress !== undefined &&
				!isNativeMetadataWorkerOriginV1(auth.nativeMetadataWorkerOrigin)) ||
			(requireCurrentTemplateTrust &&
				!workload.templateModelBindings.some((trusted) =>
					isDeepStrictEqual({ ...trusted }, templateBinding),
				)) ||
			// Agent-level Secrets are never mounted into a Session Sandbox.
			deployment.secretRefs.length > 0
		)
			throw new WorkloadKubernetesError("policy");
		const serviceToken = sessionSandboxServiceTokenV1(
			options.serviceToken,
			policy.namespace,
			binding.sandboxId,
		);
		const executorBinding =
			templateBinding.driver === "codex" &&
			templateBinding.transport === undefined &&
			workload.policy.codexSessionExecutor !== undefined
				? createCodexSessionExecutorBindingV1({
						namespace: policy.namespace,
						podName: binding.resourceName,
						agentId: binding.agentId,
						conversationId: binding.sessionId,
						sessionGeneration: generation,
						sandboxId: binding.sandboxId,
						resourceFence,
						imageDigest: `${templateBinding.imageRepository ?? workload.policy.imageRepository}@${deployment.imageDigest}`,
					})
				: undefined;
		const providerBinding = selectProviderDeploymentBinding(
			workload.policy.providerCapabilityEvidence,
			templateBinding.driver,
			deployment.imageDigest,
			`configuration-${projection.configurationRevision}-${projection.fingerprint}`,
		);
		return {
			...(templateBinding.transport
				? { transport: templateBinding.transport }
				: providerBinding
					? { providerBinding }
					: {}),
			driver: templateBinding.driver,
			...(executorBinding
				? {
						sessionExecutor: {
							binding: executorBinding,
							attestation: codexSessionExecutorAttestationV1(
								executorBinding,
								serviceToken,
							),
						},
					}
				: {}),
			...(templateBinding.driver === "codex" &&
			templateBinding.transport === undefined &&
			!executorBinding &&
			!policy.podController
				? {
						codexContainerBoundaryEnabled:
							workload.policy.codexContainerBoundaryEnabled === true,
						...(workload.policy.codexContainerBoundaryEnabled === true
							? {
									codexContainerBoundaryAttestation:
										containerBoundaryAttestationV1(
											sessionSandboxServiceTokenV1(
												options.serviceToken,
												policy.namespace,
												binding.sandboxId,
											),
											`${deployment.agentId}:${binding.sessionId}`,
										),
								}
							: {}),
					}
				: {}),
			...(templateBinding.driver !== "codex" ||
			templateBinding.transport === "paseo-sdk-pod"
				? {
						sessionScopeAttestation: sessionScopeAttestationV1(
							serviceToken,
							`${deployment.agentId}:${binding.sessionId}`,
						),
					}
				: {}),
			modelConfiguration: runtimeModelInjectionV4(projection).configuration,
			workerId: auth.workerId,
			grantKeyId: auth.grantKeyId,
			grantPublicKey: auth.grantPublicKey,
			grantIssuer: auth.grantIssuer,
			nativeMetadataWorkerOrigin: auth.nativeMetadataWorkerOrigin,
			serviceToken,
			...fileExchange(),
		};
	};
	const resourceFor = (
		binding: Omit<
			SessionSandboxReconciliationClaimV1["sandbox"],
			"principal" | "channelId"
		>,
		policy: SessionSandboxReconciliationClaimV1["policy"],
		deployment: AgentWorkloadDesiredV1,
		modelProjection: unknown,
		desiredState: "running" | "stopped",
		generation: number,
		resourceFence: number,
		requireCurrentTemplateTrust = true,
	): SessionSandboxResourceInputV1 => {
		const projectedTemplateId =
			modelProjection &&
			typeof modelProjection === "object" &&
			"standardTemplateBinding" in modelProjection &&
			modelProjection.standardTemplateBinding &&
			typeof modelProjection.standardTemplateBinding === "object" &&
			"templateId" in modelProjection.standardTemplateBinding &&
			typeof modelProjection.standardTemplateBinding.templateId === "string"
				? modelProjection.standardTemplateBinding.templateId
				: undefined;
		const templateBinding = projectedTemplateId
			? workload.templateModelBindings.find(
					(candidate) =>
						candidate.templateId === projectedTemplateId &&
						candidate.imageDigest === deployment.imageDigest,
				)
			: undefined;
		const trialBinding =
			trialImage !== undefined &&
			matchesSigCoreSdkTrialBinding(
				trialImage,
				workload.policy.imageRepository,
				templateBinding,
			);
		if (
			trialImage &&
			requireCurrentTemplateTrust &&
			desiredState === "running" &&
			(!trialBinding ||
				workload.templateModelBindings.length !== 1 ||
				policy.namespace !== workload.policy.namespace ||
				policy.podController !== "sig-core-v1.0.12")
		)
			throw new WorkloadKubernetesError("policy");
		const skillHub = skillHubRuntimeBindingV1(deployment);
		if (
			skillHub &&
			deployment.persistentVolume.name !==
				`${workloadResourceNameV1(binding.agentId)}-data`
		)
			throw new WorkloadKubernetesError("policy");
		const runtime = runtimeFor(
			binding,
			policy,
			deployment,
			modelProjection,
			requireCurrentTemplateTrust,
			generation,
			resourceFence,
		);
		const originalPolicy = originalSessionResourcePolicy(
			workload.policy,
			policy.resourceConfigurationHash,
		);
		if (
			!originalPolicy &&
			desiredState === "running" &&
			requireCurrentTemplateTrust
		)
			throw new Error("SessionSandbox verified policy is unavailable");
		const allocation: SessionSandboxResourceInputV1 = {
			...(originalPolicy?.sessionRuntimePlacement
				? { sessionRuntimePlacement: originalPolicy.sessionRuntimePlacement }
				: {}),
			...(runtime &&
			!runtime.custom &&
			runtime.transport === "paseo-sdk-pod" &&
			workload.policy.piSessionPlacement
				? { piSessionPlacement: workload.policy.piSessionPlacement }
				: {}),
			...(policy.podController
				? {
						podController: policy.podController,
						corePlacement: workload.policy.agentWorkloadPlacement,
					}
				: {}),
			...(install && runtime && templateBinding && !runtime.custom
				? {
						connectionInstallBootstrap: {
							port: install.port,
							workerOrigin: install.workerOrigin,
							apiSelector: install.apiSelector,
							clientName: install.clientName,
							configuration: install.configuration,
							approval: install.approval,
							tlsSecretRef: install.tlsSecretForSandbox(binding.resourceName),
							callbackAuthSecretRef: install.callbackAuthSecretRef,
							workerCaSecretRef: install.workerCaSecretRef,
							installToken: sessionSandboxConnectionInstallTokenV1(
								options.serviceToken,
								policy.namespace,
								binding.sandboxId,
							),
							// #4199 C2: this Pod declares no dynamic tools unless the claim-time
							// decision replaces this proof (withConnectionManualPublicationV1).
							publicationProof: connectionManualPublicationProofV1(
								options.serviceToken,
								{
									namespace: policy.namespace,
									sandboxId: binding.sandboxId,
									generation,
									resourceFence,
								},
							),
							templateBinding: {
								driver: templateBinding.driver,
								templateId: templateBinding.templateId,
							},
						},
					}
				: {}),
			...(runtime?.sessionExecutor &&
			workload.policy.codexSessionExecutor !== undefined
				? {
						codexSessionExecutor: workload.policy.codexSessionExecutor,
						...(options.executorDrainStartupTimeoutMs === undefined
							? {}
							: { executorDrainIdentity: true as const }),
					}
				: {}),
			...(skillHub ? { skillHub } : {}),
			...(deployment.skillDeliveryImage
				? { skillDeliveryImage: deployment.skillDeliveryImage }
				: {}),
			schemaVersion: binding.schemaVersion,
			agentId: binding.agentId,
			sessionId: binding.sessionId,
			sandboxId: binding.sandboxId,
			resourceName: binding.resourceName,
			workspaceScope: binding.workspaceScope,
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
			egress: sessionSandboxEgressPolicyV1(
				egressPolicy,
				templateBinding !== undefined,
				Boolean(deployment.workspaceSnapshots?.length),
			),
			imageDigest:
				runtime?.sessionExecutor?.binding.imageDigest ??
				`${templateBinding?.imageRepository ?? workload.policy.imageRepository}@${deployment.imageDigest}`,
			imagePullSecretName: workload.policy.imagePullSecretName,
			containerPort: deployment.service.port,
			env: deployment.env,
			// V4-only: a static-key or missing projection fails before any write.
			runtime:
				runtime?.transport === "paseo-sdk-pod" && trialBinding
					? { ...runtime, textOnly: true }
					: runtime,
			connectionConsumerSnapshot: runtimeConnectionConsumerSnapshotForAgentV1(
				connection.snapshot,
				connection.snapshotsByAgent,
				binding.agentId,
			),
			connectionInstallationRevision:
				runtimeConnectionInstallationRevisionForAgentV1(
					connection.revision,
					connection.revisionsByAgent,
					binding.agentId,
				),
			connectionInstallationOAuthPublication:
				runtimeConnectionInstallationOAuthPublicationForAgentV1(
					connection.publication,
					connection.publicationsByAgent,
					binding.agentId,
				),
			authorizedIngressSelector: workload.policy.workerSelector,
			resources: workload.policy.resources,
			storageSize: workload.policy.storageSize,
			storageClassName: workload.policy.storageClassName,
			workspaceMountPath: "/workspace",
			desiredState,
		};
		return allocation;
	};
	return resourceFor;
}

const ownerSecretNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const sessionPlatformSecretKeys: ReadonlySet<string> = new Set([
	"token",
	"model-config",
	sessionSandboxFileExchangeSecretKey,
	sessionSandboxContainerBoundaryAttestationSecretKey,
	sessionSandboxSessionScopeAttestationSecretKey,
	sessionExecutorBindingSecretKeyV1,
	sessionExecutorAttestationSecretKeyV1,
]);

function ownerSecretRecordMatches(
	record: PlatformSecretRecordV1,
	reference: AgentWorkloadDesiredV1["secretRefs"][number] | undefined,
): boolean {
	return (
		reference !== undefined &&
		record.ownerType === "agent-owner" &&
		reference.ownerType === "agent-owner" &&
		record.ownerId === reference.ownerId &&
		record.agentId === reference.agentId &&
		record.secretId === reference.secretId &&
		record.secretVersion === reference.secretVersion &&
		record.configRevision === reference.configRevision &&
		record.crypto.algorithmVersion === reference.algorithmVersion &&
		record.crypto.wrappingAlgorithmVersion ===
			reference.wrappingAlgorithmVersion &&
		record.crypto.wrappingKeyVersion === reference.wrappingKeyVersion
	);
}

/**
 * Owner values for one custom Session Secret (Engineering Spec §10.1.1, #3938).
 * Values come only from Platform DB ciphertext decrypted with the Worker
 * keyring; every decryption is audited and its plaintext buffer is zeroed. A
 * Session Secret already recorded for this Sandbox keeps its immutable
 * values, so steady-state observation re-checks the binding without
 * decrypting again.
 */
async function sessionOwnerSecretMaterializationV1(
	workload: WorkloadRuntimeOptionsV1,
	allocation: SessionSandboxAllocationV1,
	deployment: AgentWorkloadDesiredV1,
	recordedSecret: SessionSandboxResourceIdentityV1 | undefined,
): Promise<SessionSandboxCustomSecretMaterializationV1> {
	const references = allocation.runtime?.custom?.secretRefs ?? [];
	const store = workload.sessionOwnerSecrets;
	if (!store || !references.length) throw new WorkloadKubernetesError("policy");
	const audit = (
		target: { readonly secretId: string; readonly wrappingKeyVersion: string },
		outcome: "succeeded" | "rejected",
	) =>
		store.auditDecryption({
			agentId: deployment.agentId,
			secretId: target.secretId,
			wrappingKeyVersion: target.wrappingKeyVersion,
			outcome,
			traceId: deployment.traceId,
			requestId: deployment.requestId,
			workerId: workload.workerId,
		});
	const reject = async (
		targets: readonly {
			readonly secretId: string;
			readonly wrappingKeyVersion: string;
		}[],
	): Promise<never> => {
		// The rejection stands even when its audit cannot be written.
		await Promise.allSettled(
			targets.map((target) => audit(target, "rejected")),
		);
		throw new WorkloadKubernetesError("policy");
	};
	let records: PlatformSecretRecordV1[];
	try {
		records = (
			await store.resolve({ agentId: deployment.agentId, references })
		).map((record) => validatePlatformSecretRecordV1(record));
		if (
			records.length !== references.length ||
			records.some(
				(record, index) =>
					record.agentId !== deployment.agentId ||
					!ownerSecretRecordMatches(record, references[index]),
			)
		)
			throw new Error();
	} catch {
		return reject(references);
	}
	const names = records.map((record) => record.name);
	if (
		new Set(names).size !== names.length ||
		names.some(
			(name) =>
				!ownerSecretNamePattern.test(name) ||
				name.startsWith("AGENT_INFRA_") ||
				sessionPlatformSecretKeys.has(name),
		)
	)
		return reject(references);
	const environmentNames = names.toSorted();
	if (
		recordedSecret?.kind === "Secret" &&
		recordedSecret.namespace === allocation.namespace &&
		recordedSecret.name === allocation.secretName
	) {
		const live = await workload.client.read<V1Secret>(
			"Secret",
			allocation.secretName,
		);
		if (
			live?.metadata?.uid === recordedSecret.uid &&
			live.metadata.namespace === allocation.namespace &&
			live.metadata.name === allocation.secretName &&
			!live.metadata.deletionTimestamp &&
			live.immutable === true &&
			hasSessionSandboxIdentityV1(live, allocation)
		) {
			const data: Record<string, string> = {};
			for (const name of names) {
				const encoded = live.data?.[name];
				const decoded =
					typeof encoded === "string" ? Buffer.from(encoded, "base64") : null;
				if (!decoded || decoded.toString("base64") !== encoded) break;
				data[name] = decoded.toString("utf8");
			}
			if (Object.keys(data).length === names.length)
				return { data, environmentNames };
		}
	}
	const data: Record<string, string> = {};
	for (const record of records) {
		const target = {
			secretId: record.secretId,
			wrappingKeyVersion: record.crypto.wrappingKeyVersion,
		};
		const decryption = await workload.decryptor.decrypt({
			encryptedRecord: record,
			traceId: deployment.traceId,
		});
		if (decryption.outcome !== "decrypted") return reject([target]);
		try {
			let plaintext: string;
			try {
				plaintext = new TextDecoder("utf-8", { fatal: true }).decode(
					decryption.plaintext,
				);
			} catch {
				// Unusable plaintext is a rejected decryption, never a success.
				return await reject([target]);
			}
			await audit(target, "succeeded");
			data[record.name] = plaintext;
		} catch {
			throw new WorkloadKubernetesError("policy");
		} finally {
			decryption.plaintext.fill(0);
		}
	}
	return { data, environmentNames };
}

function createSessionSandboxAllocationResolverV1(
	workload: WorkloadRuntimeOptionsV1,
	options: {
		readonly serviceToken: string;
		readonly oauthProvisioning?: SessionSandboxOAuthProvisioningV1;
		readonly connectionInstallBootstrap?: ConnectionInstallBootstrapDeploymentV1;
		readonly connectionManualPublication?: ConnectionManualPublicationV1;
		readonly executorDrainStartupTimeoutMs?: number;
	},
) {
	const provisioning =
		options.oauthProvisioning === undefined
			? undefined
			: structuredClone(options.oauthProvisioning);
	const resourceFor = createSessionSandboxResourceInputResolverV1(
		workload,
		options,
	);
	return async (
		binding: SessionSandboxReconciliationClaimV1["sandbox"],
		policy: SessionSandboxReconciliationClaimV1["policy"],
		deployment: AgentWorkloadDesiredV1,
		modelProjection: unknown,
		desiredState: "running" | "stopped",
		generation: number,
		resourceFence: number,
		requireCurrentTemplateTrust = true,
		/** Store-recorded identity of this Sandbox's Session Secret, if any. */
		recordedSecret?: SessionSandboxResourceIdentityV1,
	): Promise<SessionSandboxAllocationV1> => {
		const snapshots = deployment.workspaceSnapshots ?? [];
		let snapshotProjection: Awaited<
			ReturnType<
				NonNullable<WorkloadRuntimeOptionsV1["workspaceSnapshotResolver"]>
			>
		>["projection"];
		if (
			snapshots.length &&
			desiredState === "running" &&
			requireCurrentTemplateTrust
		) {
			if (!workload.workspaceSnapshotResolver)
				throw new WorkloadKubernetesError("policy");
			const resolved = await workload.workspaceSnapshotResolver({
				agentId: binding.agentId,
				configurationRevision: deployment.configRevision,
				workloadRevision: deployment.workloadRevision,
				fence: deployment.fence,
				bindings: snapshots.map((x) => ({
					snapshotId: x.snapshotId,
					name: x.name,
				})),
			});
			const metadata = resolved.inputs.map((x) => ({
				snapshotId: x.snapshotId,
				name: x.name,
				digest: x.digest,
				sizeBytes: x.sizeBytes,
				objectRef: x.objectRef,
				mountPath: `/opt/agent/workspaces/${x.name}`,
			}));
			const sort = (items: typeof metadata) =>
				[...items].sort((a, b) => a.name.localeCompare(b.name));
			if (
				!resolved.projection ||
				!isDeepStrictEqual(sort(metadata), sort([...snapshots]))
			)
				throw new WorkloadKubernetesError("policy");
			snapshotProjection = {
				...resolved.projection,
				volumes: resolved.projection.volumes.map((v) =>
					v.name === "workspace-snapshot-credentials"
						? {
								...v,
								secret: {
									...v.secret,
									secretName: sessionSnapshotSecretNameV1({
										sandboxId: binding.sandboxId,
										generation,
										resourceFence,
									}),
								},
							}
						: v,
				),
			};
		}
		if (snapshots.length && !requireCurrentTemplateTrust) {
			const project = workload.workspaceSnapshotResolver?.project;
			if (!project) throw new WorkloadKubernetesError("policy");
			const shape = project(snapshots, {
				agentId: binding.agentId,
				configurationRevision: deployment.configRevision,
			});
			snapshotProjection = {
				...shape,
				volumes: shape.volumes.map((v) =>
					v.name === "workspace-snapshot-credentials"
						? {
								...v,
								secret: {
									...v.secret,
									secretName: sessionSnapshotSecretNameV1({
										sandboxId: binding.sandboxId,
										generation,
										resourceFence,
									}),
								},
							}
						: v,
				),
			};
		}

		const selectedProvisioning = selectSessionOAuthProvisioningV1(
			binding,
			policy.namespace,
			desiredState,
			provisioning,
		);
		const allocation: SessionSandboxAllocationV1 =
			await withConnectionManualPublicationV1(
				{
					...(selectedProvisioning
						? { oauthProvisioning: structuredClone(selectedProvisioning) }
						: {}),
					...(snapshotProjection
						? { workspaceSnapshotProjection: snapshotProjection }
						: {}),
					...resourceFor(
						binding,
						policy,
						deployment,
						modelProjection,
						desiredState,
						generation,
						resourceFence,
						requireCurrentTemplateTrust,
					),
					principal: binding.principal,
					channelId: binding.channelId,
				},
				options.connectionManualPublication,
				{ desiredState, requireCurrentTemplateTrust },
				() => {
					throw new WorkloadKubernetesError("unavailable");
				},
				options.serviceToken,
			);
		if (
			allocation.runtime?.custom &&
			desiredState === "running" &&
			requireCurrentTemplateTrust
		)
			bindSessionSandboxCustomSecretMaterializationV1(
				allocation,
				await sessionOwnerSecretMaterializationV1(
					workload,
					allocation,
					deployment,
					recordedSecret,
				),
			);
		// A cached static or shared Consumer snapshot reaches a new running Sandbox only while
		// the Agent still has no persistent association (Spec §13.5.7). Drain, stop and
		// cleanup renders keep their original inputs so existing resources can be removed.
		if (
			desiredState === "running" &&
			requireCurrentTemplateTrust &&
			typeof allocation.connectionConsumerSnapshot === "string" &&
			workload.connectionDeliveryCurrent
		) {
			let current: boolean;
			try {
				current = await workload.connectionDeliveryCurrent(binding.agentId);
			} catch {
				throw new WorkloadKubernetesError("unavailable");
			}
			if (!current) throw new WorkloadKubernetesError("policy");
		}
		// Drain and stopped renders never carry Owner values: the Session Secret
		// is an absent kind there and is deleted by recorded identity.
		return allocation;
	};
}

/** 停止回执保留的资源：从未记录 PVC 的部分准备来源没有（#2918）。 */
function retainedResources(receipt: SessionSandboxStopReceiptV1) {
	return receipt.retainedPVC ? [receipt.retainedPVC] : [];
}

/** Production resource receiver; invoked only under the original Store lease. */
export function createProductionSessionSandboxReceiverV1(
	workload: WorkloadRuntimeOptionsV1,
	options: {
		readonly serviceToken: string;
		readonly oauthProvisioning?: SessionSandboxOAuthProvisioningV1;
		readonly connectionInstallBootstrap?: ConnectionInstallBootstrapDeploymentV1;
		/** #4199 C2: the approved publication contract and the per-Agent association read. */
		readonly connectionManualPublication?: ConnectionManualPublicationV1;
		readonly executorDrainStartupTimeoutMs?: number;
		readonly executorIdentityIssuer?: ConversationRuntimeOptionsV2["signing"]["privateKey"];
	},
) {
	if (
		workload.policy.codexSessionExecutor !== undefined &&
		options.executorDrainStartupTimeoutMs !== undefined &&
		workload.policy.executorInstanceStartupApprovals === undefined
	)
		throw new Error("WORKER_EXECUTOR_V2_APPROVALS_REQUIRED");
	const adapter = createSessionSandboxWorkloadAdapterV1({
		fetch: workload.fetch,
		client: workload.client,
		executorIdentityIssuer: options.executorIdentityIssuer,
		connectionPublicationProofKey: options.serviceToken,
	});
	const allocationFor = createSessionSandboxAllocationResolverV1(
		workload,
		options,
	);
	return async (
		claim: SessionSandboxReconciliationClaimV1,
		signal: AbortSignal,
		recordDeletionProgress?: (
			progress: SessionSandboxDeletionProgressV1,
		) => Promise<"committed" | "stale" | "unknown">,
		recordExecutorStartup?: (
			startupRef: string,
			timeoutMs: number,
		) => Promise<number | null>,
		recordExecutorRetirement?: (
			resources: readonly SessionSandboxResourceIdentityV1[],
		) => Promise<readonly SessionSandboxResourceIdentityV1[] | null>,
		readExecutorRetirement?: () => Promise<boolean>,
		executorInstances?: (
			mutation: ExecutorInstanceMutationV2,
		) => Promise<{ state: ExecutorInstanceStateV2; permit: boolean } | null>,
	): Promise<SessionSandboxObservationV1> => {
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
			let sourceAllocation = await allocationFor(
				source.sandbox,
				source.policy,
				sourceDeployment,
				source.modelProjection,
				"running",
				source.sandbox.generation,
				source.resourceFence,
				// Drain validates the captured source, not today's preparation allowlist.
				false,
			);
			// Reconstruct the text restriction on the original Core template for
			// drain observation only. A rollout can change it between prepare and
			// stop. The adapter still checks the original ownership, PVC and spec.
			if (
				sourceAllocation.podController &&
				sourceAllocation.runtime?.driver === "codex" &&
				sourceAllocation.runtime.transport === "paseo-sdk-pod"
			) {
				const sandbox = await workload.client.read<{
					kind?: string;
					spec?: { podTemplate?: V1Pod };
				}>("Sandbox", sourceAllocation.podName);
				const runtimeHost = sandbox?.spec?.podTemplate?.spec?.containers.find(
					(c) => c.name === sessionSandboxRuntimeContainerName,
				);
				const textOnly = runtimeHost?.env?.some(
					(entry) =>
						entry.name === runtimeTextOnlyEnv && entry.value === "true",
				);
				sourceAllocation = {
					...sourceAllocation,
					runtime: {
						...sourceAllocation.runtime,
						textOnly: textOnly || undefined,
					},
				};
			}
			const sourceInstance = executorInstances
				? await executorInstances({ kind: "read" })
				: null;
			if (sourceInstance)
				sourceAllocation = {
					...sourceAllocation,
					executorDrainIdentity: true,
					executorStartupDeadline: sourceInstance.state.expiresAt,
					executorInstance: sourceInstance.state,
				};
			const closeSourceInstance = async () => {
				if (!sourceInstance) return;
				if (sourceInstance.state.phase === "retired") {
					if (
						!workload.client.readMetadata ||
						(await workload.client.readMetadata(
							"Secret",
							sourceInstance.state.startupRef,
						))
					)
						throw new WorkloadKubernetesError("unavailable");
					return;
				}
				if (
					!executorInstances ||
					!options.executorIdentityIssuer ||
					!claim.drainComputeAllowed
				)
					throw new WorkloadKubernetesError("unavailable");
				await createExecutorInstanceControlV2({
					client: workload.client,
					issuer: options.executorIdentityIssuer,
					allocation: sourceAllocation,
					ledger: executorInstances,
					signal,
				}).retire();
			};
			const sourceResources = source.observation?.resources ?? [];
			if (lifecycle.stopReceipt) {
				await closeSourceInstance();
				return {
					status: "stopped" as const,
					sourceStop: lifecycle.stopReceipt,
					resources: retainedResources(lifecycle.stopReceipt),
				};
			}
			// #2917：上一轮排空已完成、只剩 PVC 的沙箱被管理转换重新当作来源。没有可删除的资源，
			// 只读证明停止；与正常排空一样，执行未终态或已进入准备时不下结论。
			if (source.observation?.status === "stopped") {
				if (!claim.drainComputeAllowed || lifecycle.preparation)
					return { status: "unknown" as const, resources: sourceResources };
				// #2995：停止发生在替换准备期间时，准备可能已在来源 fence 下建出资源（PVC 也被改写到
				// 该 fence），但观测没来得及提交，来源仍是上一轮的停止观测。读到这些归属资源、且仍包含
				// 记录的同一 PVC 时，交给 Core 补全来源证据（只是证据，不是停止证明），下一次按完整或
				// 部分来源逐个删除。fence 不符、不归属本沙箱的同名资源不算，仍由下面失败关闭。
				const owned = await adapter.observe(
					sourceAllocation,
					sourceResources,
					"control",
				);
				signal.throwIfAborted();
				if (
					owned.resources.some(
						(resource) => resource.kind !== "PersistentVolumeClaim",
					) &&
					sourceResources.every((recorded) =>
						owned.resources.some(
							(resource) =>
								resource.kind === recorded.kind &&
								resource.namespace === recorded.namespace &&
								resource.name === recorded.name &&
								resource.uid === recorded.uid,
						),
					)
				)
					return { status: "observed" as const, resources: owned.resources };
				await closeSourceInstance();
				const stopReceipt = await adapter.confirmStoppedSource(
					await allocationFor(
						claim.sandbox,
						source.policy,
						sourceDeployment,
						source.modelProjection,
						"stopped",
						source.sandbox.generation,
						source.resourceFence,
						false,
					),
					sourceResources,
					{
						sourceGeneration: source.sandbox.generation,
						sourceResourceFence: source.resourceFence,
						targetGeneration: claim.sandbox.generation,
						targetResourceFence: claim.resourceFence,
					},
				);
				signal.throwIfAborted();
				return {
					status: "stopped" as const,
					sourceStop: stopReceipt,
					resources: retainedResources(stopReceipt),
				};
			}
			// #1481（按 Sandbox 投影 Runtime 输入）之前准备的来源没有模型投影（runtime 为 null），
			// 当时也不创建 Runtime Secret：其余 5 种资源就是完整来源（#2885）。
			const sourceKinds = [
				...(sourceAllocation.podController ? ["Sandbox"] : []),
				"Pod",
				"Service",
				"ServiceAccount",
				"PersistentVolumeClaim",
				"NetworkPolicy",
				...(sourceAllocation.runtime === null ? [] : ["Secret"]),
			];
			const completeSource =
				sourceResources.length >= sourceKinds.length &&
				sourceKinds.every((kind) =>
					sourceResources.some((resource) => resource.kind === kind),
				);
			if (!completeSource) {
				const observed = await adapter.observe(
					sourceAllocation,
					sourceResources,
					"control",
				);
				signal.throwIfAborted();
				// #2918：准备中断留下的部分来源（未就绪、只记录了部分资源）。
				if (
					source.observation &&
					source.observation.status !== "ready" &&
					observed.status === "unknown"
				) {
					const same = (
						left: readonly SessionSandboxResourceIdentityV1[],
						right: SessionSandboxResourceIdentityV1,
						version: boolean,
					) =>
						left.some(
							(item) =>
								item.kind === right.kind &&
								item.uid === right.uid &&
								(!version || item.resourceVersion === right.resourceVersion),
						);
					const keepsRecorded = sourceResources.every((resource) =>
						same(observed.resources, resource, false),
					);
					const unchanged =
						keepsRecorded &&
						observed.resources.length === sourceResources.length &&
						observed.resources.every((resource) =>
							same(sourceResources, resource, true),
						);
					// 读到了新的归属资源，或记录的资源版本已前进：交给 Core 补全来源证据
					// （只是证据，不是就绪或停止证明）。
					if (keepsRecorded && !unchanged)
						return {
							status: "observed" as const,
							resources: observed.resources,
						};
					// 证据稳定：按记录的 UID 删除，未记录且不存在的种类视为从未创建。
					if (unchanged) {
						if (!claim.drainComputeAllowed || lifecycle.preparation)
							return { status: "unknown" as const, resources: sourceResources };
						if (!recordDeletionProgress)
							throw new Error("Session Sandbox deletion CAS is unavailable");
						await closeSourceInstance();
						const stopReceipt = await adapter.cleanup(
							await allocationFor(
								claim.sandbox,
								source.policy,
								sourceDeployment,
								source.modelProjection,
								"stopped",
								source.sandbox.generation,
								source.resourceFence,
								false,
							),
							sourceResources,
							{
								sourceGeneration: source.sandbox.generation,
								sourceResourceFence: source.resourceFence,
								targetGeneration: claim.sandbox.generation,
								targetResourceFence: claim.resourceFence,
								managementFence: lifecycle.authority.managementFence,
								deletionProgress: lifecycle.deletionProgress,
								recordDeletionProgress,
								partialSource: true,
							},
						);
						signal.throwIfAborted();
						return {
							status: "stopped" as const,
							sourceStop: stopReceipt,
							resources: retainedResources(stopReceipt),
						};
					}
				}
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
			if (!claim.drainComputeAllowed || lifecycle.preparation)
				return {
					status: "unknown" as const,
					resources: sourceResources,
				};
			// A Pod's resourceVersion advances with each status update after its
			// ready observation, and a delete precondition must be an observed
			// version. Refresh the captured source once before the first delete;
			// the Store refines it and the next attempt deletes (#1523).
			if (!lifecycle.deletionProgress?.length) {
				const observed = await adapter.observe(
					sourceAllocation,
					sourceResources,
					"control",
				);
				signal.throwIfAborted();
				// A same-name replacement can be created by the formal lifecycle
				// recovery path after the captured source Pod was removed. The
				// allocation identity (labels/annotations and policy) is still the
				// authority, while the old UID is only a stale observation. Re-read
				// without the stale resource identities so ownership/spec checks can
				// refresh the source before cleanup; foreign or drifted resources still
				// remain unknown because the adapter keeps its ownership/spec guards.
				if (observed.status === "unknown") {
					const refreshed = await adapter.observe(
						sourceAllocation,
						[],
						"control",
					);
					signal.throwIfAborted();
					const sameResourceSet =
						refreshed.resources.length === sourceResources.length &&
						refreshed.resources.every((resource) =>
							sourceResources.some(
								(prior) =>
									prior.kind === resource.kind &&
									prior.namespace === resource.namespace &&
									prior.name === resource.name,
							),
						) &&
						sourceResources.every((prior) =>
							refreshed.resources.some(
								(resource) =>
									resource.kind === prior.kind &&
									resource.namespace === prior.namespace &&
									resource.name === prior.name,
							),
						);
					if (
						refreshed.status !== "unknown" &&
						sameResourceSet &&
						sourceAllocation.podController &&
						sourceAllocation.runtime?.transport === undefined
					) {
						const pod = refreshed.resources.find((r) => r.kind === "Pod");
						if (!pod || !sourceAllocation.runtime)
							throw new WorkloadKubernetesError("conflict");
						await requestCorePodAdmission(
							`http://${sourceAllocation.serviceName}.${sourceAllocation.namespace}.svc:${sourceAllocation.containerPort}`,
							sourceAllocation.runtime.serviceToken,
							pod.uid,
							workload.fetch ?? fetch,
							signal,
						);
					}
					if (refreshed.status !== "unknown" && sameResourceSet)
						return {
							status: "observed" as const,
							resources: refreshed.resources,
						};
				}
				if (
					observed.status !== "unknown" &&
					observed.resources.length === sourceResources.length &&
					observed.resources.every((resource) =>
						sourceResources.some(
							(prior) =>
								prior.kind === resource.kind && prior.uid === resource.uid,
						),
					) &&
					observed.resources.some(
						(resource) =>
							!sourceResources.some(
								(prior) =>
									prior.kind === resource.kind &&
									prior.resourceVersion === resource.resourceVersion,
							),
					)
				)
					return { status: "observed" as const, resources: observed.resources };
			}
			const allocation = await allocationFor(
				claim.sandbox,
				source.policy,
				sourceDeployment,
				source.modelProjection,
				"stopped",
				source.sandbox.generation,
				source.resourceFence,
				false,
			);
			if (!recordDeletionProgress)
				throw new Error("Session Sandbox deletion CAS is unavailable");
			await closeSourceInstance();
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
				resources: retainedResources(stopReceipt),
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
			!originalSessionResourcePolicy(
				workload.policy,
				claim.policy.resourceConfigurationHash,
			)
		)
			throw new Error("SessionSandbox verified policy is unavailable");
		const previous = claim.previousObservation?.resources ?? [];
		const allocation = await allocationFor(
			claim.sandbox,
			claim.policy,
			deployment,
			claim.modelProjection,
			claim.desiredState,
			claim.sandbox.generation,
			claim.resourceFence,
			claim.desiredState === "running",
			previous.find((resource) => resource.kind === "Secret"),
		);
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
				resources: retainedResources(stopReceipt),
			};
		}
		const existingInstance =
			allocation.executorDrainIdentity && executorInstances
				? await executorInstances({ kind: "read" })
				: null;
		const approvals = workload.policy.executorInstanceStartupApprovals;
		if (
			allocation.executorDrainIdentity &&
			(existingInstance || approvals !== undefined)
		) {
			if (
				!executorInstances ||
				!options.executorIdentityIssuer ||
				!options.executorDrainStartupTimeoutMs ||
				!allocation.runtime?.sessionExecutor ||
				!approvals
			)
				throw new WorkloadKubernetesError("policy");
			if (
				!Array.isArray(approvals) ||
				approvals.length > 128 ||
				new Set(approvals.map((x) => x.imageDigest)).size !== approvals.length
			)
				throw new WorkloadKubernetesError("policy");
			const approval = approvals
				.map((x) => ExecutorInstanceStateV2Schema.shape.approval.parse(x))
				.find(
					(x) =>
						x.imageDigest ===
						allocation.runtime?.sessionExecutor?.binding.imageDigest,
				);
			if (!approval) throw new WorkloadKubernetesError("policy");
			const live = await workload.client.read<V1Pod>("Pod", allocation.podName);
			if (!existingInstance && live)
				throw new WorkloadKubernetesError("conflict");
			if (existingInstance?.state.phase === "retired") {
				if (
					live ||
					!workload.client.readMetadata ||
					(await workload.client.readMetadata(
						"Secret",
						existingInstance.state.startupRef,
					))
				)
					throw new WorkloadKubernetesError("conflict");
			}
			const prepared = await executorInstances({
				kind: "prepare",
				bindingDigest: codexSessionExecutorBindingDigestV1(
					allocation.runtime.sessionExecutor.binding,
				),
				configurationVersion: JSON.parse(allocation.runtime.modelConfiguration)
					.configVersion,
				timeoutMs: options.executorDrainStartupTimeoutMs,
				approval,
			});
			if (!prepared) throw new WorkloadKubernetesError("conflict");
			let instanceAllocation = {
				...allocation,
				executorInstance: prepared.state,
				executorStartupDeadline: prepared.state.expiresAt,
			};
			const control = createExecutorInstanceControlV2({
				client: workload.client,
				issuer: options.executorIdentityIssuer,
				allocation: instanceAllocation,
				ledger: executorInstances,
				signal,
			});
			if (
				live &&
				prepared.state.podUid &&
				live.metadata?.uid !== prepared.state.podUid
			)
				throw new WorkloadKubernetesError("conflict");
			if (
				prepared.state.phase === "closing" ||
				(prepared.state.podUid && !live) ||
				(!prepared.state.adoption && Date.now() >= prepared.state.expiresAt)
			) {
				if (live && !prepared.state.podUid) await control.bindForCleanup(live);
				await control.retire();
				return {
					status: "unknown",
					failureCode: "runtime.executor_identity_timeout",
					resources: previous.filter((r) => r.kind === "PersistentVolumeClaim"),
				};
			}
			if (claim.lifecycle?.stopReceipt?.retainedPVC)
				await adapter.prepareRetainedPVC(allocation, claim.lifecycle, previous);
			await adapter.apply(instanceAllocation, previous, control);
			const current = control.current();
			if (!current) throw new WorkloadKubernetesError("unavailable");
			instanceAllocation = { ...instanceAllocation, executorInstance: current };
			if (!current.adoption && Date.now() >= current.expiresAt) {
				await control.retire();
				return {
					status: "unknown",
					failureCode: "runtime.executor_identity_timeout",
					resources: previous.filter((r) => r.kind === "PersistentVolumeClaim"),
				};
			}
			return adapter.observe(instanceAllocation, previous);
		}

		const recordedPod = previous.find((resource) => resource.kind === "Pod");
		// A ready replacement owns its current UIDs; an older stop receipt cannot replace them again.
		const preparedReplacement =
			claim.previousObservation?.status === "ready" &&
			claim.lifecycle?.preparation?.generation === claim.sandbox.generation &&
			claim.lifecycle.preparation.resourceFence === claim.resourceFence &&
			!claim.lifecycle.stopReceipt?.removed.some(
				({ resource }) =>
					resource.kind === "Pod" && resource.uid === recordedPod?.uid,
			);
		if (
			(!claim.lifecycle || preparedReplacement) &&
			recordedPod &&
			(!allocation.executorDrainIdentity ||
				claim.previousObservation?.status === "ready")
		) {
			const livePod = await workload.client.read("Pod", recordedPod.name);
			if (
				!livePod ||
				(allocation.podController && livePod.metadata?.uid !== recordedPod.uid)
			) {
				signal.throwIfAborted();
				return {
					status: "unknown" as const,
					failureCode: "sandbox.pod_lost" as const,
					resources: previous,
				};
			}
			signal.throwIfAborted();
		}
		let previousForApply = previous;
		let deploymentAllocation = allocation;
		if (allocation.executorDrainIdentity) {
			const timeout = options.executorDrainStartupTimeoutMs;
			if (!timeout || !recordExecutorStartup)
				throw new WorkloadKubernetesError("policy");
			const executorStartupDeadline = await recordExecutorStartup(
				`${allocation.podName}-executor-${allocation.resourceFence}`,
				timeout,
			);
			signal.throwIfAborted();
			if (executorStartupDeadline === null)
				throw new WorkloadKubernetesError("conflict");
			deploymentAllocation = { ...allocation, executorStartupDeadline };
		}
		const retireExpired = async () => {
			if (
				!recordExecutorRetirement ||
				claim.previousObservation?.status === "ready"
			)
				throw new WorkloadKubernetesError("conflict");
			const resources = await adapter.retireExpiredExecutorStartup(
				deploymentAllocation,
				previousForApply,
				recordExecutorRetirement,
				signal,
			);
			signal.throwIfAborted();
			return {
				status: "unknown" as const,
				failureCode: "runtime.executor_identity_timeout" as const,
				resources,
			};
		};
		const firstExecutorDeadline =
			claim.previousObservation?.status === "ready"
				? undefined
				: deploymentAllocation.executorStartupDeadline;
		if (firstExecutorDeadline !== undefined) {
			const retirementPending = await readExecutorRetirement?.();
			signal.throwIfAborted();
			if (retirementPending || Date.now() >= firstExecutorDeadline)
				return retireExpired();
			const pod = await workload.client.read<V1Pod>("Pod", allocation.podName);
			if (recordedPod && !pod)
				return {
					status: "unknown" as const,
					failureCode: "sandbox.pod_lost" as const,
					resources: previous,
				};
		}
		// 没有保留 PVC 的回执（#2918）按新建准备；旧来源 UID 只在首次替换时排除。
		if (claim.lifecycle?.stopReceipt?.retainedPVC) {
			await adapter.prepareRetainedPVC(allocation, claim.lifecycle, previous);
			signal.throwIfAborted();
			previousForApply = preparedReplacement ? previous : [];
		}

		try {
			await adapter.apply(deploymentAllocation, previousForApply);
		} catch (error) {
			if (!(error instanceof SessionExecutorStartupExpiredV1)) throw error;
			return retireExpired();
		}

		signal.throwIfAborted();
		// One complete observe per claim; normal prepare pacing is durable in Store.
		// Keep the lease/abort/CAS boundary here and let the next claim use the
		// persisted generation/fence audit anchor instead of a hot in-lease loop.
		const observed = await adapter.observe(
			deploymentAllocation,
			previousForApply,
		);
		if (
			firstExecutorDeadline !== undefined &&
			Date.now() >= firstExecutorDeadline
		)
			return retireExpired();
		return observed;
	};
}
