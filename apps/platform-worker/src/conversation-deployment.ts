import { createPublicKey } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type ApprovedConnectionConsumerTargetV1,
	resolveApprovedConnectionConsumerProfileV1,
} from "@agent-infra/contracts/connection-consumer-profile";
import type { BrowserCapabilityBindingV1 } from "@agent-infra/contracts/runtime";
import {
	type AgentWorkloadDesiredV1,
	validateAgentWorkloadDesiredV1,
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
	type SessionSandboxReconciliationClaimV1,
	sessionSandboxFileExchangeTokenV1,
} from "@agent-infra/platform-core";
import type { V1Secret, V1Service } from "@kubernetes/client-node";
import { containerBoundaryAttestationV1 } from "./container-boundary-attestation.js";
import type { ConversationRuntimeOptionsV2 } from "./conversation-runtime.js";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import { workloadResourceNameV1 } from "./kubernetes-runtime-adapter.js";
import {
	bindSessionSandboxCustomSecretMaterializationV1,
	createSessionSandboxWorkloadAdapterV1,
	hasSessionSandboxIdentityV1,
	isNativeMetadataWorkerOriginV1,
	type SessionSandboxAllocationV1,
	type SessionSandboxCustomSecretMaterializationV1,
	type SessionSandboxRuntimeInputV1,
	sessionSandboxIdentityAnnotationsV1,
	sessionSandboxLabelsMatchV1,
	sessionSandboxLabelsV1,
	sessionSandboxSelectorMatchesV1,
	sessionSandboxServiceTokenV1,
} from "./session-workload-adapter.js";
import {
	createWorkloadRuntimeV1,
	drainCacheableCommands,
	isWorkloadExecutionCapacityCurrentV1,
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

/** Resolve only a currently observed Workload through the existing deployment adapter. */
export function createProductionConversationRuntimeResolverV2(options: {
	readonly workload: WorkloadRuntimeOptionsV1;
	readonly signing: ConversationRuntimeOptionsV2["signing"];
	readonly serviceToken: string;
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
				!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.clientId) ||
				value.profileFingerprint !== target.configFingerprint ||
				!source ||
				typeof source !== "object" ||
				Array.isArray(source) ||
				JSON.stringify(source) !== JSON.stringify(target.source)
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
	const allocationFor = createSessionSandboxAllocationResolverV1(workload, {
		serviceToken,
	});
	const sandboxAdapter = createSessionSandboxWorkloadAdapterV1({
		client: workload.client,
	});
	const connectionDeliveryConfigured =
		workload.policy.connectionConsumerSnapshot !== undefined ||
		workload.policy.connectionInstallationRevision !== undefined ||
		workload.policy.connectionConsumerSnapshotsByAgent !== undefined ||
		workload.policy.connectionInstallationRevisionsByAgent !== undefined;
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
			let sessionBrowserBinding: BrowserCapabilityBindingV1 | undefined;
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
					sandboxResource.policy.resourceConfigurationHash !==
						workloadResourceConfigurationHashV1(workload.policy)
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
			// drift, health and signed Runtime readiness; it never changes resources.
			// 排空路径（business purpose + events.persist/events.ack/execution.renew）
			// 与同一次准备内的前置解析复用最近一次通过的签名 readiness，仅核对 K8s 路由与
			// Pod 就绪；提交等命令在发送前最后一次解析、以及 control 用途始终做完整签名探测。
			const isDrainPath =
				input.purpose === "business" &&
				((drainCacheableCommands as ReadonlySet<string>).has(input.command) ||
					// 同一次准备内的前置解析；发送前最后一次解析仍做完整探测（#2134）。
					input.reuseSignedReadiness === true);
			const health = await (input.purpose === "control"
				? runtime.observeVerifiedControl(state)
				: isDrainPath
					? runtime.observeForDrain(state, sessionBrowserBinding)
					: sessionBrowserBinding
						? runtime.observeSession(state, sessionBrowserBinding)
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
					// The verified Workload revision, not the lifecycle revision (#1480).
					sandboxResource.policy.workloadRevision !==
						deployment.workloadRevision ||
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
					liveService.spec.ports?.length !== 1 ||
					livePort?.name !== "runtime" ||
					livePort.port !== deployment.service.port ||
					livePort.targetPort !== deployment.service.port ||
					(livePort.protocol !== undefined && livePort.protocol !== "TCP") ||
					liveService.spec.externalIPs?.length ||
					liveService.spec.externalName
				)
					throw new Error();
				const requireSandboxObservation =
					input.purpose === "control" &&
					input.requireSandboxObservation === true;
				if (
					(input.purpose === "business" && connectionDeliveryConfigured) ||
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
					const observed = await sandboxAdapter.observe(
						await allocationFor(
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
						),
						resources,
					);
					input.signal.throwIfAborted();
					if (observed.status !== "ready") throw new Error();
				}
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
		...(policy.nativeMetadataWorkerEgress
			? { nativeMetadataWorkerEgress: policy.nativeMetadataWorkerEgress }
			: {}),
		// #3289：与 Agent Workload 同一条部署声明；只在配置了文件交换 origin 时存在。
		...(policy.fileExchangeEgress
			? { fileExchangeEgress: policy.fileExchangeEgress }
			: {}),
		...(policy.dnsEgress ? { dnsEgress: policy.dnsEgress } : {}),
	};
}

/** One deployment capture shared by Session reception and read-only route checks. */
function createSessionSandboxAllocationResolverV1(
	workload: WorkloadRuntimeOptionsV1,
	options: { readonly serviceToken: string },
) {
	const connectionConsumerSnapshot = workload.policy.connectionConsumerSnapshot;
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
		return {
			driver: templateBinding.driver,
			...(templateBinding.driver === "codex"
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
											`${deployment.agentId}\0${binding.sessionId}`,
										),
								}
							: {}),
					}
				: {}),
			modelConfiguration: runtimeModelInjectionV4(projection).configuration,
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
		};
	};
	const allocationFor = async (
		binding: SessionSandboxReconciliationClaimV1["sandbox"],
		policy: SessionSandboxReconciliationClaimV1["policy"],
		deployment: AgentWorkloadDesiredV1,
		modelProjection: unknown,
		desiredState: "running" | "stopped",
		generation: number,
		resourceFence: number,
		requireCurrentTemplateTrust = true,
	): Promise<SessionSandboxAllocationV1> => {
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
		const allocation: SessionSandboxAllocationV1 = {
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
			imageDigest: `${templateBinding?.imageRepository ?? workload.policy.imageRepository}@${deployment.imageDigest}`,
			containerPort: deployment.service.port,
			env: deployment.env,
			// V4-only: a static-key or missing projection fails before any write.
			runtime: runtimeFor(
				binding,
				policy,
				deployment,
				modelProjection,
				requireCurrentTemplateTrust,
				generation,
				resourceFence,
			),
			connectionConsumerSnapshot,
			connectionInstallationRevision,
			authorizedIngressSelector: workload.policy.workerSelector,
			resources: workload.policy.resources,
			storageSize: workload.policy.storageSize,
			storageClassName: workload.policy.storageClassName,
			workspaceMountPath: "/workspace",
			desiredState,
		};
		if (
			allocation.runtime?.custom &&
			(desiredState === "running" || !requireCurrentTemplateTrust)
		) {
			const data: Record<string, string> = {};
			const sourceSecret = !requireCurrentTemplateTrust
				? await workload.client.read<V1Secret>("Secret", allocation.secretName)
				: null;
			const refs = requireCurrentTemplateTrust
				? allocation.runtime.custom.secretRefs
				: [];
			if (
				!requireCurrentTemplateTrust &&
				sourceSecret?.data &&
				hasSessionSandboxIdentityV1(sourceSecret, allocation)
			) {
				for (const [name, encoded] of Object.entries(sourceSecret.data)) {
					if (["token", "model-config"].includes(name)) continue;
					if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
						throw new WorkloadKubernetesError("policy");
					const decoded = Buffer.from(encoded, "base64");
					if (decoded.toString("base64") !== encoded)
						throw new WorkloadKubernetesError("policy");
					data[name] = decoded.toString("utf8");
				}
			}
			for (const ref of refs) {
				const secret = await workload.client.read<V1Secret>("Secret", ref.name);
				const annotations = secret?.metadata?.annotations;
				if (
					!secret ||
					secret.metadata?.namespace !== allocation.namespace ||
					secret.immutable !== true ||
					annotations?.["agent-infra.agora.io/secret-id"] !== ref.secretId ||
					annotations?.["agent-infra.agora.io/secret-version"] !==
						String(ref.secretVersion) ||
					annotations?.["agent-infra.agora.io/config-revision"] !==
						String(ref.configRevision) ||
					!secret.data
				)
					throw new WorkloadKubernetesError("policy");
				for (const [name, encoded] of Object.entries(secret.data)) {
					if (
						!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
						name.startsWith("AGENT_INFRA_") ||
						["token", "model-config"].includes(name) ||
						data[name] !== undefined
					)
						throw new WorkloadKubernetesError("policy");
					try {
						const decoded = Buffer.from(encoded, "base64");
						if (decoded.toString("base64") !== encoded) throw new Error();
						data[name] = decoded.toString("utf8");
					} catch {
						throw new WorkloadKubernetesError("policy");
					}
				}
			}
			const materialization: SessionSandboxCustomSecretMaterializationV1 = {
				data,
				environmentNames: Object.keys(data).toSorted(),
			};
			bindSessionSandboxCustomSecretMaterializationV1(
				allocation,
				materialization,
			);
		}
		return allocation;
	};
	return allocationFor;
}

/** 停止回执保留的资源：从未记录 PVC 的部分准备来源没有（#2918）。 */
function retainedResources(receipt: SessionSandboxStopReceiptV1) {
	return receipt.retainedPVC ? [receipt.retainedPVC] : [];
}

/** Production resource receiver; invoked only under the original Store lease. */
export function createProductionSessionSandboxReceiverV1(
	workload: WorkloadRuntimeOptionsV1,
	options: { readonly serviceToken: string },
) {
	const adapter = createSessionSandboxWorkloadAdapterV1({
		client: workload.client,
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
			const sourceAllocation = await allocationFor(
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
			const sourceResources = source.observation?.resources ?? [];
			if (lifecycle.stopReceipt)
				return {
					status: "stopped" as const,
					sourceStop: lifecycle.stopReceipt,
					resources: retainedResources(lifecycle.stopReceipt),
				};
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
			claim.policy.resourceConfigurationHash !==
				workloadResourceConfigurationHashV1(workload.policy)
		)
			throw new Error("SessionSandbox verified policy is unavailable");
		const allocation = await allocationFor(
			claim.sandbox,
			claim.policy,
			deployment,
			claim.modelProjection,
			claim.desiredState,
			claim.sandbox.generation,
			claim.resourceFence,
			claim.desiredState === "running",
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
				resources: retainedResources(stopReceipt),
			};
		}
		let previousForApply = previous;
		// 没有保留 PVC 的回执（#2918）按新建准备：apply 会创建 PVC，同名的未归属对象仍判冲突。
		if (claim.lifecycle?.stopReceipt?.retainedPVC) {
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
		let observed = await adapter.observe(allocation, previous);
		// Keep the lease while a just-created Pod crosses the kubelet readiness
		// edge. If it remains unready, return to the paced outbox retry instead of
		// releasing the lease into a commit-wakeup hot loop.
		if (observed.status === "observed") {
			const deadline = Date.now() + 750;
			while (Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				signal.throwIfAborted();
				observed = await adapter.observe(allocation, observed.resources);
				if (observed.status !== "observed") break;
			}
		}
		return observed;
	};
}
