import { createHash, createHmac, randomUUID } from "node:crypto";
import { posix } from "node:path";
import {
	RuntimeModelConfigurationV4Schema,
	type RuntimeSkillHubBindingV1,
	RuntimeSkillHubBindingV1Schema,
	runtimeSkillHubBindingEnvironmentNameV1,
} from "@agent-infra/contracts/runtime";
import type { AgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import {
	decideSessionSandboxDrainObservationV1,
	type SessionSandboxDeletionProgressV1,
	type SessionSandboxLifecycleV1,
	type SessionSandboxObservationV1,
	type SessionSandboxResourceIdentityV1,
	type SessionSandboxStopReceiptV1,
	type TaskPrincipalV1,
} from "@agent-infra/platform-core";
import type {
	KubernetesObject,
	V1Container,
	V1EnvVar,
	V1NetworkPolicy,
	V1PersistentVolumeClaim,
	V1Pod,
	V1Secret,
	V1Service,
	V1ServiceAccount,
} from "@kubernetes/client-node";
import {
	isRuntimeConnectionEnvironmentV1,
	runtimeConnectionConsumerAnnotation,
	runtimeConnectionConsumerControlPodV1,
	runtimeConnectionConsumerProjectionV1,
} from "./connection-consumer-projection.js";
import type { WorkerKubernetesClientV1 } from "./kubernetes-client.js";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import {
	agentAnnotation,
	agentContainerSecurityContext,
	agentPodSecurityContext,
	ownerLabel,
	workloadResourceNameV1,
} from "./kubernetes-runtime-comparison.js";
import { skillHubVolumeMountV1 } from "./kubernetes-runtime-skill-mount.js";
import {
	hasAdditionalEgressPolicyV1,
	nativeEgressPolicyAnnotationsV1,
	nativeEgressPolicyAnnotationV1,
	type WorkloadEgressPolicyV1,
	workloadEgressRulesV1,
} from "./workload-network.js";
import {
	isFileExchangeOriginV1,
	isWorkloadFileExchangeEgressCurrentV1,
} from "./workload-runtime-auth.js";

/**
 * Runtime inputs for one Session Sandbox (#1466). `modelConfiguration` and
 * `serviceToken` are written only to that Sandbox's own Secret; the Pod refers
 * to them by key and never receives a deployment-level credential.
 */
export interface SessionSandboxRuntimeInputV1 {
	readonly driver: "codex" | "claude" | "acp" | "pi";
	/** Non-sensitive keyless V4 configuration from the verified projection. */
	readonly modelConfiguration: string;
	readonly workerId: string;
	readonly grantKeyId: string;
	readonly grantPublicKey: string;
	readonly grantIssuer: string;
	/** Per-Sandbox transport token from {@link sessionSandboxServiceTokenV1}. */
	readonly serviceToken: string;
	/** Explicit deployment approval for the Codex container-boundary mode. */
	readonly codexContainerBoundaryEnabled?: boolean;
	readonly codexContainerBoundaryAttestation?: string;
	/** Deployment-approved in-cluster Worker origin for native metadata callbacks. */
	readonly nativeMetadataWorkerOrigin?: string;
	/**
	 * Runtime 文件交换（#3276）：origin 与 Agent Workload 取同一部署配置；token 是
	 * `sessionSandboxFileExchangeTokenV1` 按本分配派生的值，只写进本 Sandbox 的 Secret，
	 * Pod 以 secretKeyRef 引用。缺失时两个变量都不注入，Runtime FileBridge 保持关闭。
	 */
	readonly fileExchange?: {
		readonly origin: string;
		readonly serviceToken: string;
	};
	/** Custom platform-adapter Secret references copied into this Session only. */
	readonly custom?: {
		readonly secretRefs: readonly AgentWorkloadDesiredV1["secretRefs"][number][];
	};
}

export interface SessionSandboxCustomSecretMaterializationV1 {
	/** Plaintext exists only during the Worker -> Session Secret write. */
	readonly data: Readonly<Record<string, string>>;
	readonly environmentNames: readonly string[];
}

const customSecretMaterializations = new WeakMap<
	SessionSandboxAllocationV1,
	SessionSandboxCustomSecretMaterializationV1
>();

/** Bind ephemeral custom Secret material to one in-memory allocation object. */
export function bindSessionSandboxCustomSecretMaterializationV1(
	allocation: SessionSandboxAllocationV1,
	materialization: SessionSandboxCustomSecretMaterializationV1,
): void {
	customSecretMaterializations.set(allocation, materialization);
}

/**
 * Transport token bound to one Sandbox. The Worker recomputes it for each
 * route, so nothing extra is stored and rotating the deployment token rotates
 * every Sandbox token. It is not valid for another Sandbox or an Agent Workload.
 */
export function sessionSandboxServiceTokenV1(
	deploymentServiceToken: string,
	namespace: string,
	sandboxId: string,
): string {
	if (!deploymentServiceToken || !namespace || !sandboxId)
		throw new WorkloadKubernetesError("policy");
	return createHmac("sha256", deploymentServiceToken)
		.update(`session-sandbox-v1\0${namespace}\0${sandboxId}`)
		.digest("base64url");
}

const sessionSandboxTokenPattern = /^[A-Za-z0-9_-]{43}$/;
/** 本 Sandbox Secret 中文件交换派生 token 的键（#3276）。 */
export const sessionSandboxFileExchangeSecretKey = "file-exchange-token";
export const sessionSandboxContainerBoundaryAttestationSecretKey =
	"container-boundary-attestation";
const runtimeTextPattern = /^[\x21-\x7e]{1,256}$/;
export function isNativeMetadataWorkerOriginV1(
	value: unknown,
): value is string {
	if (typeof value !== "string") return false;
	try {
		const origin = new URL(value);
		const releaseScopedService =
			/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?-platform-worker-native-metadata$/.test(
				origin.hostname,
			);
		return (
			origin.protocol === "http:" &&
			origin.username === "" &&
			origin.password === "" &&
			(origin.hostname === "platform-worker-native-metadata" ||
				releaseScopedService) &&
			(origin.port === "" || origin.port === "80") &&
			(origin.pathname === "/" || origin.pathname === "") &&
			origin.search === "" &&
			origin.hash === ""
		);
	} catch {
		return false;
	}
}
const runtimeTmpVolume = {
	name: "runtime-tmp",
	emptyDir: { medium: "Memory", sizeLimit: "128Mi" },
} as const;

/** Typed handoff for the #1250 Store allocation authority. */
export interface SessionSandboxAllocationV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly sessionId: string;
	readonly sandboxId: string;
	readonly principal: SessionSandboxPrincipalV1;
	readonly channelId: string;
	readonly resourceName: string;
	readonly workspaceScope: string;
	readonly generation: number;
	readonly resourceFence: number;
	readonly namespace: string;
	readonly podName: string;
	readonly serviceName: string;
	readonly serviceAccountName: string;
	readonly pvcName: string;
	readonly networkPolicyName: string;
	/** This Sandbox's own credential Secret; never shared with another Sandbox. */
	readonly secretName: string;
	/**
	 * Deployment-approved egress (Spec §10.1.1), assembled by the Worker from its
	 * reviewed policy; never from Store claims, requests or Runtime replies.
	 */
	readonly egress: WorkloadEgressPolicyV1;
	readonly imageDigest: string;
	readonly authorizedIngressSelector: Readonly<Record<string, string>>;
	readonly containerPort: number;
	readonly workspaceMountPath: string;
	readonly env?: Readonly<Record<string, string>>;
	/**
	 * Verified V4 projection and Worker runtime auth, assembled by the Worker.
	 * 排空（drain）路径若原 payload 未保存 modelProjection（旧 payload 形状），
	 * 此字段为 null；只有 desiredState === "running" 的准备操作才强制要求非 null。
	 */
	readonly runtime: SessionSandboxRuntimeInputV1 | null;
	/** Frozen Hub package input from the Store's verified deployment. */
	readonly skillHub?: RuntimeSkillHubBindingV1;
	readonly connectionConsumerSnapshot?: string | null;
	readonly connectionInstallationRevision?: string | null;
	readonly resources: {
		readonly requests: { readonly cpu: string; readonly memory: string };
		readonly limits: { readonly cpu: string; readonly memory: string };
	};
	readonly storageSize: string;
	readonly storageClassName?: string;
	readonly desiredState: "running" | "stopped";
}

export type SessionSandboxResourceSetV1 = readonly [
	V1ServiceAccount,
	V1PersistentVolumeClaim,
	V1NetworkPolicy,
	V1Service,
	V1Secret,
	V1Pod,
];

/** Kinds that hold compute, routing or credentials; absent once stopped. */
const stoppedAbsentKinds = new Set(["Pod", "Service", "Secret"]);

export type SessionSandboxPrincipalV1 = TaskPrincipalV1;

interface SessionSandboxLabelIdentityV1 {
	readonly agentId: string;
	readonly sessionId: string;
	readonly sandboxId: string;
	readonly generation: number;
}

const labelValuePattern = /^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const boundedRef = (prefix: string, value: string) =>
	`${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;

/**
 * Selector labels for one Session Sandbox. Kubernetes label values are at most
 * 63 characters, so Agent and Session IDs are bounded hashes; the exact IDs live
 * in {@link sessionSandboxIdentityAnnotationsV1}. The key differs from the
 * Agent Workload's `agent-infra.agora.io/agent` so Agent selectors never match.
 */
export function sessionSandboxLabelsV1(
	identity: SessionSandboxLabelIdentityV1,
): Readonly<Record<string, string>> {
	const labels = {
		// This Worker-owned marker is also available to NetworkPolicy selectors;
		// the exact Sandbox identity remains bound by the four labels below.
		"agent-infra.agora.io/managed": "session-sandbox-v1",
		"agent-infra.agora.io/agent-ref": boundedRef("agent", identity.agentId),
		"agent-infra.agora.io/session-ref": boundedRef(
			"session",
			identity.sessionId,
		),
		"agent-infra.agora.io/sandbox-id": identity.sandboxId,
		"agent-infra.agora.io/generation": String(identity.generation),
	};
	if (Object.values(labels).some((value) => !labelValuePattern.test(value)))
		throw new WorkloadKubernetesError("policy");
	return labels;
}

/** Exact identity verified alongside the bounded selector labels. */
export function sessionSandboxIdentityAnnotationsV1(
	identity: Pick<SessionSandboxLabelIdentityV1, "agentId" | "sessionId">,
): Readonly<Record<string, string>> {
	return {
		"agent-infra.agora.io/agent-id": identity.agentId,
		"agent-infra.agora.io/session-id": identity.sessionId,
	};
}

/** True when an object carries this Sandbox's labels and exact identity. */
export function hasSessionSandboxIdentityV1(
	object: KubernetesObject | null | undefined,
	identity: SessionSandboxLabelIdentityV1,
): boolean {
	const labels = object?.metadata?.labels ?? {};
	const annotations = object?.metadata?.annotations ?? {};
	return (
		sessionSandboxLabelsMatchV1(labels, sessionSandboxLabelsV1(identity)) &&
		Object.entries(sessionSandboxIdentityAnnotationsV1(identity)).every(
			([key, value]) => annotations[key] === value,
		)
	);
}

const sessionSandboxManagedLabel = "agent-infra.agora.io/managed";

/**
 * 实际标签（或 selector）是否包含全部期望项。`managed` 标签只是给 NetworkPolicy 用的标记
 * （#2684），不是 Sandbox 身份：#2684 之前创建的资源没有它（只有同名注解），所以允许它缺失，
 * 但不允许取别的值；其余标签照旧严格匹配（#2691）。
 */
export function sessionSandboxLabelsMatchV1(
	actual: Readonly<Record<string, string>> | undefined,
	expected: Readonly<Record<string, string>>,
): boolean {
	return Object.entries(expected).every(
		([key, value]) =>
			actual?.[key] === value ||
			(key === sessionSandboxManagedLabel && actual?.[key] === undefined),
	);
}

/** selector 与期望完全相同；#2684 之前创建的对象可以少 managed 这一项（#2691）。 */
export function sessionSandboxSelectorMatchesV1(
	actual: Readonly<Record<string, string>> | undefined,
	expected: Readonly<Record<string, string>>,
): boolean {
	// 没有 selector 的 Service 不是任何 Sandbox 的路由，不论期望里还剩哪些键。
	if (!actual) return false;
	const comparable = legacyComparableLabels(actual, expected) ?? {};
	return (
		Object.keys(actual).length === Object.keys(comparable).length &&
		Object.entries(comparable).every(([key, value]) => actual[key] === value)
	);
}

/** 期望的 selector/matchLabels；实际对象是 #2684 之前创建的（没有 managed 项）时去掉这一项（#2691）。 */
function legacyComparableLabels(
	actual: Readonly<Record<string, string>> | undefined,
	expected: Readonly<Record<string, string>> | undefined,
) {
	if (
		!expected ||
		expected[sessionSandboxManagedLabel] === undefined ||
		actual?.[sessionSandboxManagedLabel] !== undefined
	)
		return expected;
	const { [sessionSandboxManagedLabel]: _marker, ...legacy } = expected;
	return legacy;
}

const labels = (allocation: SessionSandboxAllocationV1) =>
	sessionSandboxLabelsV1(allocation);

function metadata(allocation: SessionSandboxAllocationV1, name: string) {
	return {
		namespace: allocation.namespace,
		name,
		labels: { ...labels(allocation) },
		annotations: {
			...sessionSandboxIdentityAnnotationsV1(allocation),
			"agent-infra.agora.io/fence": String(allocation.resourceFence),
			"agent-infra.agora.io/managed": "session-sandbox-v1",
		},
	};
}

function validateAllocation(value: SessionSandboxAllocationV1) {
	if (value.skillHub !== undefined) {
		const parsed = RuntimeSkillHubBindingV1Schema.safeParse(value.skillHub);
		if (
			!parsed.success ||
			parsed.data.agentId !== value.agentId ||
			parsed.data.projections.length === 0
		)
			throw new WorkloadKubernetesError("policy");
	}
	if (
		value.schemaVersion !== 1 ||
		!value.agentId ||
		!value.sessionId ||
		!value.sandboxId ||
		!value.principal?.id ||
		(value.principal.kind !== "user" &&
			value.principal.kind !== "application") ||
		!value.channelId ||
		value.resourceName !== `sandbox-${value.sandboxId}` ||
		value.workspaceScope !== value.sandboxId ||
		!Number.isSafeInteger(value.generation) ||
		value.generation < 1 ||
		!Number.isSafeInteger(value.resourceFence) ||
		value.resourceFence < 1 ||
		!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(value.namespace) ||
		!value.podName ||
		!value.serviceName ||
		!value.serviceAccountName ||
		!value.pvcName ||
		!value.networkPolicyName ||
		[
			value.podName,
			value.serviceName,
			value.serviceAccountName,
			value.pvcName,
			value.networkPolicyName,
			value.secretName,
		].some((name) => name !== value.resourceName) ||
		!/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(value.imageDigest) ||
		Object.keys(value.authorizedIngressSelector).length === 0 ||
		Object.values(value.authorizedIngressSelector).some((item) => !item) ||
		!Number.isSafeInteger(value.containerPort) ||
		value.containerPort < 1 ||
		value.containerPort > 65535 ||
		!value.workspaceMountPath.startsWith("/") ||
		// The Host requires a normalized data directory below this mount.
		value.workspaceMountPath === "/" ||
		posix.normalize(value.workspaceMountPath) !== value.workspaceMountPath ||
		value.workspaceMountPath.endsWith("/") ||
		value.workspaceMountPath === "/tmp" ||
		value.workspaceMountPath.startsWith("/tmp/") ||
		!value.egress ||
		typeof value.egress !== "object" ||
		Array.isArray(value.egress) ||
		Object.keys(value.egress).some(
			(key) =>
				![
					"nativeEgress",
					"modelEgress",
					"connectionEgress",
					"nativeMetadataWorkerEgress",
					"fileExchangeEgress",
					"dnsEgress",
				].includes(key),
		)
	)
		throw new WorkloadKubernetesError("policy");
	validateNativeMetadataWorkerEgressV1(
		value.egress.nativeMetadataWorkerEgress,
		value.namespace,
	);
	if (
		value.egress.nativeMetadataWorkerEgress !== undefined &&
		// 排空（drain-only）allocation 的 runtime 为 null，无需检查 nativeMetadata 原点。
		value.runtime !== null &&
		!isNativeMetadataWorkerOriginV1(value.runtime.nativeMetadataWorkerOrigin)
	)
		throw new WorkloadKubernetesError("policy");
	// #3289：文件交换 egress 只随部署 origin 出现，只有一条且端口等于 origin 端口；
	// Runtime 输入不能在没有该规则时注入 origin，也不能借另一个端口扩大规则。
	if (
		value.runtime !== null &&
		!isWorkloadFileExchangeEgressCurrentV1(
			value.runtime.fileExchange?.origin,
			value.egress.fileExchangeEgress,
		)
	)
		throw new WorkloadKubernetesError("policy");
	if (
		value.egress.nativeEgress &&
		(value.runtime?.custom ||
			(value.desiredState === "running" && value.runtime === null))
	)
		throw new WorkloadKubernetesError("policy");
	// Rejects any destination the shared Agent-level compiler would reject.
	workloadEgressRulesV1(value.egress);
	// 排空（drain-only）allocation 的 runtime 允许为 null（旧 payload 形状）：
	// cleanup 和 control-mode observe 在 stopped 状态下只需沙箱身份标签，
	// 不依赖模型配置字段。创建资源的入口另行要求 runtime 非空。
	if (value.runtime !== null) {
		validateRuntimeInput(value.runtime);
	}
}

const requiredRuntimeInputKeys = [
	"driver",
	"grantIssuer",
	"grantKeyId",
	"grantPublicKey",
	"modelConfiguration",
	"serviceToken",
	"workerId",
];
const optionalRuntimeInputKeys = [
	"codexContainerBoundaryEnabled",
	"codexContainerBoundaryAttestation",
	"custom",
	"fileExchange",
	"nativeMetadataWorkerOrigin",
];

function validateRuntimeInput(runtime: SessionSandboxRuntimeInputV1) {
	try {
		const keys = Object.keys(runtime);
		if (
			!runtime ||
			typeof runtime !== "object" ||
			!requiredRuntimeInputKeys.every((key) => keys.includes(key)) ||
			keys.some(
				(key) =>
					!requiredRuntimeInputKeys.includes(key) &&
					!optionalRuntimeInputKeys.includes(key),
			) ||
			!["codex", "claude", "acp", "pi"].includes(runtime.driver) ||
			![runtime.workerId, runtime.grantKeyId, runtime.grantIssuer].every(
				(item) => typeof item === "string" && runtimeTextPattern.test(item),
			) ||
			typeof runtime.grantPublicKey !== "string" ||
			!runtime.grantPublicKey.startsWith("-----BEGIN PUBLIC KEY-----") ||
			// Only the derived per-Sandbox token shape (32-byte HMAC, base64url).
			typeof runtime.serviceToken !== "string" ||
			!sessionSandboxTokenPattern.test(runtime.serviceToken) ||
			typeof runtime.modelConfiguration !== "string" ||
			(runtime.nativeMetadataWorkerOrigin !== undefined &&
				!isNativeMetadataWorkerOriginV1(runtime.nativeMetadataWorkerOrigin)) ||
			(runtime.codexContainerBoundaryEnabled !== undefined &&
				typeof runtime.codexContainerBoundaryEnabled !== "boolean") ||
			(runtime.codexContainerBoundaryAttestation !== undefined &&
				(!runtime.codexContainerBoundaryEnabled ||
					typeof runtime.codexContainerBoundaryAttestation !== "string" ||
					!/^[A-Za-z0-9_-]{43}$/.test(
						runtime.codexContainerBoundaryAttestation,
					))) ||
			(runtime.codexContainerBoundaryEnabled === true &&
				(typeof runtime.codexContainerBoundaryAttestation !== "string" ||
					!/^[A-Za-z0-9_-]{43}$/.test(
						runtime.codexContainerBoundaryAttestation,
					))) ||
			(runtime.fileExchange !== undefined &&
				(!runtime.fileExchange ||
					typeof runtime.fileExchange !== "object" ||
					Object.keys(runtime.fileExchange).sort().join(",") !==
						"origin,serviceToken" ||
					!isFileExchangeOriginV1(runtime.fileExchange.origin) ||
					// 只接受本 Sandbox 派生值的形状（32 字节 HMAC，base64url），且不能复用传输 token。
					typeof runtime.fileExchange.serviceToken !== "string" ||
					!sessionSandboxTokenPattern.test(runtime.fileExchange.serviceToken) ||
					runtime.fileExchange.serviceToken === runtime.serviceToken))
		)
			throw new Error();
		if (runtime.custom !== undefined) {
			if (
				!Array.isArray(runtime.custom.secretRefs) ||
				runtime.custom.secretRefs.length === 0 ||
				new Set(runtime.custom.secretRefs.map((ref) => ref.name)).size !==
					runtime.custom.secretRefs.length ||
				runtime.custom.secretRefs.some(
					(ref) =>
						ref.ownerType !== "agent-owner" ||
						!ref.agentId ||
						!ref.secretId ||
						!ref.name,
				)
			)
				throw new Error();
			return;
		}
		// Keyless V4 only: static model credentials are never projected here.
		const configuration = RuntimeModelConfigurationV4Schema.parse(
			JSON.parse(runtime.modelConfiguration),
		);
		const protocol =
			runtime.driver === "codex"
				? "openai-responses-v1"
				: "anthropic-messages-v1";
		if (
			configuration.modelOptions.some((option) => option.protocol !== protocol)
		)
			throw new Error();
	} catch {
		throw new WorkloadKubernetesError("policy");
	}
}

/**
 * Session Sandboxes may reach native metadata only through the deployment-owned
 * Worker Service selector. IP/CIDR destinations are rejected so a Store claim
 * or generic model egress cannot widen this callback path.
 */
function validateNativeMetadataWorkerEgressV1(
	egress: SessionSandboxAllocationV1["egress"]["nativeMetadataWorkerEgress"],
	namespace: SessionSandboxAllocationV1["namespace"],
) {
	if (egress === undefined) return;
	if (
		!Array.isArray(egress) ||
		egress.length !== 1 ||
		!egress.every((entry) => {
			const destination = entry?.destination;
			const labels =
				destination &&
				typeof destination === "object" &&
				!Array.isArray(destination) &&
				"podLabels" in destination
					? destination.podLabels
					: undefined;
			return (
				entry?.port === 3004 &&
				destination !== null &&
				typeof destination === "object" &&
				!Array.isArray(destination) &&
				Object.keys(destination).sort().join(",") === "namespace,podLabels" &&
				"namespace" in destination &&
				destination.namespace === namespace &&
				labels !== null &&
				typeof labels === "object" &&
				!Array.isArray(labels) &&
				Object.keys(labels).every(
					(key) =>
						key === "app.kubernetes.io/component" ||
						key === "app.kubernetes.io/instance",
				) &&
				Object.keys(labels).length >= 1 &&
				Object.keys(labels).length <= 2 &&
				labels["app.kubernetes.io/component"] === "platform-worker" &&
				(labels["app.kubernetes.io/instance"] === undefined ||
					typeof labels["app.kubernetes.io/instance"] === "string") &&
				(labels["app.kubernetes.io/instance"] === undefined ||
					labels["app.kubernetes.io/instance"].length <= 63) &&
				(labels["app.kubernetes.io/instance"] === undefined ||
					/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(
						labels["app.kubernetes.io/instance"],
					))
			);
		})
	)
		throw new WorkloadKubernetesError("policy");
}

/** Runtime Host inputs; both credentials are references into this Sandbox's Secret. */
function runtimeEnvironment(
	allocation: SessionSandboxAllocationV1,
	custom?: SessionSandboxCustomSecretMaterializationV1,
): V1EnvVar[] {
	// 排空（drain-only）allocation 的 runtime 为 null：stopped 状态不创建资源，无需环境变量。
	if (!allocation.runtime) return [];
	const { runtime } = allocation;
	const secretRef = (key: string) => ({
		secretKeyRef: { name: allocation.secretName, key, optional: false },
	});
	const platform = [
		...(allocation.skillHub
			? [
					{
						name: runtimeSkillHubBindingEnvironmentNameV1,
						value: JSON.stringify(allocation.skillHub),
					},
				]
			: []),
		{ name: "AGENT_INFRA_RUNTIME_AGENT_ID", value: allocation.agentId },
		{ name: "AGENT_INFRA_RUNTIME_WORKER_ID", value: runtime.workerId },
		{
			name: "AGENT_INFRA_RUNTIME_DATA_DIR",
			value: `${allocation.workspaceMountPath}/runtime`,
		},
		{ name: "PORT", value: String(allocation.containerPort) },
		{ name: "AGENT_INFRA_RUNTIME_GRANT_KEY_ID", value: runtime.grantKeyId },
		{
			name: "AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY",
			value: runtime.grantPublicKey,
		},
		{ name: "AGENT_INFRA_RUNTIME_GRANT_ISSUER", value: runtime.grantIssuer },
		{
			name: "AGENT_INFRA_RUNTIME_SERVICE_TOKEN",
			valueFrom: secretRef("token"),
		},
		// #3276：origin 是非敏感字面量；token 只引用本 Sandbox Secret 中的派生值。
		...(runtime.fileExchange === undefined
			? []
			: [
					{
						name: "AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN",
						value: runtime.fileExchange.origin,
					},
					{
						name: "AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN",
						valueFrom: secretRef(sessionSandboxFileExchangeSecretKey),
					},
				]),
	];
	if (runtime.custom) {
		return [
			{ name: "AGENT_INFRA_RUNTIME_DRIVER", value: runtime.driver },
			...platform,
			...(runtime.nativeMetadataWorkerOrigin === undefined
				? []
				: [
						{
							name: "AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_ORIGIN",
							value: runtime.nativeMetadataWorkerOrigin,
						},
						{
							name: "AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_SERVICE_TOKEN",
							valueFrom: secretRef("token"),
						},
					]),
			...(custom?.environmentNames ?? []).map((name) => ({
				name,
				valueFrom: secretRef(name),
			})),
		];
	}
	if (!runtime.modelConfiguration) throw new WorkloadKubernetesError("policy");
	return [
		{
			name: "AGENT_INFRA_RUNTIME_MODEL_CONFIG",
			valueFrom: secretRef("model-config"),
		},
		{ name: "AGENT_INFRA_RUNTIME_DRIVER", value: runtime.driver },
		...(runtime.driver === "codex" &&
		runtime.codexContainerBoundaryEnabled === true
			? [
					{
						name: "AGENT_INFRA_RUNTIME_ISOLATION_MODE",
						value: "container-boundary",
					},
					{
						name: "AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_ENABLED",
						value: "worker-v1",
					},
					{
						name: "AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_SCOPE",
						// Kubernetes rejects NUL bytes in environment values. Keep the
						// scope injective while using only printable characters; the
						// same value is used when deriving the attestation.
						value: `${allocation.agentId}:${allocation.sessionId}`,
					},
					{
						name: "AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_ATTESTATION",
						valueFrom: secretRef(
							sessionSandboxContainerBoundaryAttestationSecretKey,
						),
					},
				]
			: []),
		...platform,
		...(runtime.nativeMetadataWorkerOrigin === undefined
			? []
			: [
					{
						name: "AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_ORIGIN",
						value: runtime.nativeMetadataWorkerOrigin,
					},
					{
						name: "AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_SERVICE_TOKEN",
						valueFrom: secretRef("token"),
					},
				]),
	];
}

export function sessionSandboxResourcesV1(
	allocation: SessionSandboxAllocationV1,
): SessionSandboxResourceSetV1 {
	validateAllocation(allocation);
	const skillMount = allocation.skillHub
		? skillHubVolumeMountV1({
				skillGenerationId: allocation.skillHub.generationId,
			})
		: null;
	const custom = customSecretMaterializations.get(allocation);
	if (
		allocation.desiredState === "running" &&
		allocation.runtime?.custom &&
		!custom
	)
		throw new WorkloadKubernetesError("policy");
	if (
		custom &&
		(Object.keys(custom.data).some(
			(name) =>
				!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
				name.startsWith("AGENT_INFRA_") ||
				["token", "model-config", sessionSandboxFileExchangeSecretKey].includes(
					name,
				),
		) ||
			!custom.environmentNames.every((name) =>
				Object.hasOwn(custom.data, name),
			) ||
			new Set(custom.environmentNames).size !== custom.environmentNames.length)
	)
		throw new WorkloadKubernetesError("policy");
	const runtimeEnv = runtimeEnvironment(allocation, custom);
	if (
		allocation.desiredState === "running" &&
		(allocation.connectionConsumerSnapshot === null ||
			allocation.connectionInstallationRevision === null ||
			Object.keys(allocation.env ?? {}).some(
				isRuntimeConnectionEnvironmentV1,
			) ||
			// Owner env cannot shadow or add platform Runtime inputs.
			Object.keys(allocation.env ?? {}).some(
				(name) =>
					name.startsWith("AGENT_INFRA_") ||
					runtimeEnv.some((entry) => entry.name === name),
			))
	)
		throw new WorkloadKubernetesError("policy");
	const connection = runtimeConnectionConsumerProjectionV1(
		allocation.desiredState === "running"
			? allocation.connectionConsumerSnapshot
			: undefined,
		allocation.desiredState === "running"
			? allocation.connectionInstallationRevision
			: undefined,
	);
	const resourceLabels = { ...labels(allocation) };
	const account: V1ServiceAccount = {
		apiVersion: "v1",
		kind: "ServiceAccount",
		metadata: metadata(allocation, allocation.serviceAccountName),
		automountServiceAccountToken: false,
	};
	const pvc: V1PersistentVolumeClaim = {
		apiVersion: "v1",
		kind: "PersistentVolumeClaim",
		metadata: metadata(allocation, allocation.pvcName),
		spec: {
			accessModes: ["ReadWriteOnce"],
			resources: { requests: { storage: allocation.storageSize } },
			storageClassName: allocation.storageClassName,
		},
	};
	const policy: V1NetworkPolicy = {
		apiVersion: "networking.k8s.io/v1",
		kind: "NetworkPolicy",
		metadata: {
			...metadata(allocation, allocation.networkPolicyName),
			annotations: {
				...metadata(allocation, allocation.networkPolicyName).annotations,
				...nativeEgressPolicyAnnotationsV1(allocation.egress.nativeEgress),
			},
		},
		spec: {
			podSelector: { matchLabels: resourceLabels },
			policyTypes: ["Ingress", "Egress"],
			ingress: [
				{
					_from: [
						{
							podSelector: {
								matchLabels: allocation.authorizedIngressSelector,
							},
						},
					],
					ports: [{ protocol: "TCP", port: allocation.containerPort }],
				},
			],
			// Same compiled allowlist as the Agent-level Workload; empty denies all.
			egress: workloadEgressRulesV1(allocation.egress),
		},
	};
	const pod: V1Pod = {
		apiVersion: "v1",
		kind: "Pod",
		metadata: {
			...metadata(allocation, allocation.podName),
			annotations: {
				...metadata(allocation, allocation.podName).annotations,
				...connection.annotations,
			},
		},
		spec: {
			serviceAccountName: allocation.serviceAccountName,
			automountServiceAccountToken: false,
			// Other Sandboxes' Service addresses are not injected into this one.
			enableServiceLinks: false,
			restartPolicy: "Always",
			// Same non-root identity as the Agent-level Workload (#1466).
			securityContext: agentPodSecurityContext(),
			containers: [
				{
					name: "runtime",
					image: allocation.imageDigest,
					imagePullPolicy: "IfNotPresent",
					resources: structuredClone(allocation.resources),
					ports: [{ containerPort: allocation.containerPort }],
					env: [
						...Object.entries(allocation.env ?? {}).map(([name, value]) => ({
							name,
							value,
						})),
						...runtimeEnv,
						...connection.env,
					],
					volumeMounts: [
						...(skillMount ? [{ ...skillMount, name: "skill-hub" }] : []),
						...connection.volumeMounts,
						{ name: "workspace", mountPath: allocation.workspaceMountPath },
						{ name: runtimeTmpVolume.name, mountPath: "/tmp" },
					],
					// In-cluster plaintext (ADR-0020); NetworkPolicy admits only the Worker.
					readinessProbe: {
						httpGet: {
							scheme: "HTTP",
							path: "/healthz",
							port: allocation.containerPort,
						},
						// A one-second probe bounds the kubelet readiness edge without
						// weakening the health contract. Existing Pods with the former
						// five-second period are accepted by podSpecMatches below and
						// remain under the existing fenced lifecycle.
						periodSeconds: 1,
					},
					securityContext: agentContainerSecurityContext(),
				},
			],
			volumes: [
				...(skillMount
					? [
							{
								name: "skill-hub",
								persistentVolumeClaim: {
									claimName: `${workloadResourceNameV1(allocation.agentId)}-data`,
									readOnly: true,
								},
							},
						]
					: []),
				...connection.volumes,
				{
					name: "workspace",
					persistentVolumeClaim: { claimName: allocation.pvcName },
				},
				structuredClone(runtimeTmpVolume),
			],
		},
	};
	const secret: V1Secret = {
		apiVersion: "v1",
		kind: "Secret",
		metadata: metadata(allocation, allocation.secretName),
		type: "Opaque",
		immutable: true,
		// runtime 为 null 只出现在排空 #1481（按 Sandbox 投影 Runtime 输入）之前准备的来源：
		// 当时不创建 Runtime Secret。这里的无数据 Secret 只保持资源集合的形状，不会被创建；
		// observe（control）与 cleanup 对这类来源允许 Secret 不存在（#2885）。
		...(allocation.runtime
			? {
					data: {
						token: Buffer.from(allocation.runtime.serviceToken).toString(
							"base64",
						),
						...(allocation.runtime.modelConfiguration
							? {
									"model-config": Buffer.from(
										allocation.runtime.modelConfiguration,
									).toString("base64"),
								}
							: {}),
						...(allocation.runtime.fileExchange
							? {
									[sessionSandboxFileExchangeSecretKey]: Buffer.from(
										allocation.runtime.fileExchange.serviceToken,
									).toString("base64"),
								}
							: {}),
						...(allocation.runtime.codexContainerBoundaryAttestation
							? {
									[sessionSandboxContainerBoundaryAttestationSecretKey]:
										Buffer.from(
											allocation.runtime.codexContainerBoundaryAttestation,
										).toString("base64"),
								}
							: {}),
						...(custom
							? Object.fromEntries(
									Object.entries(custom.data).map(([name, value]) => [
										name,
										Buffer.from(value).toString("base64"),
									]),
								)
							: {}),
					},
				}
			: {}),
	};
	const service: V1Service = {
		apiVersion: "v1",
		kind: "Service",
		metadata: metadata(allocation, allocation.serviceName),
		spec: {
			type: "ClusterIP",
			selector: resourceLabels,
			ports: [
				{
					name: "runtime",
					port: allocation.containerPort,
					targetPort: allocation.containerPort,
				},
			],
		},
	};
	// The Secret precedes the Pod that references it; cleanup runs in reverse.
	return [account, pvc, policy, service, secret, pod];
}

function pvcSpecMatches(
	current: KubernetesObject,
	expected: V1PersistentVolumeClaim,
) {
	const spec = (current as V1PersistentVolumeClaim).spec;
	const expectedStorageClass = expected.spec?.storageClassName;
	return (
		JSON.stringify(spec?.accessModes ?? []) ===
			JSON.stringify(expected.spec?.accessModes ?? []) &&
		spec?.resources?.requests?.storage ===
			expected.spec?.resources?.requests?.storage &&
		(expectedStorageClass === undefined ||
			spec?.storageClassName === expectedStorageClass)
	);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function podSpecMatches(current: KubernetesObject, expected: V1Pod) {
	if (
		current.metadata?.annotations?.[runtimeConnectionConsumerAnnotation] !==
		expected.metadata?.annotations?.[runtimeConnectionConsumerAnnotation]
	)
		return false;
	const currentSpec = (current as V1Pod).spec;
	const expectedSpec = expected.spec;
	const currentContainer = currentSpec?.containers?.[0];
	const expectedContainer = expectedSpec?.containers?.[0];
	if (!currentSpec || !expectedSpec || !currentContainer || !expectedContainer)
		return false;
	if (
		currentSpec.containers.length !== expectedSpec.containers.length ||
		(currentSpec.initContainers?.length ?? 0) !==
			(expectedSpec.initContainers?.length ?? 0) ||
		(currentSpec.ephemeralContainers?.length ?? 0) !==
			(expectedSpec.ephemeralContainers?.length ?? 0)
	)
		return false;
	const normalizeEnv = (env: typeof expectedContainer.env) =>
		(env ?? [])
			.map(({ name, value, valueFrom }) => ({ name, value, valueFrom }))
			.sort((left, right) => left.name.localeCompare(right.name));
	return (
		currentSpec.serviceAccountName === expectedSpec.serviceAccountName &&
		currentSpec.automountServiceAccountToken ===
			expectedSpec.automountServiceAccountToken &&
		currentSpec.enableServiceLinks === expectedSpec.enableServiceLinks &&
		stableJson(currentSpec.securityContext ?? {}) ===
			stableJson(expectedSpec.securityContext ?? {}) &&
		currentSpec.restartPolicy === expectedSpec.restartPolicy &&
		currentSpec.hostNetwork === expectedSpec.hostNetwork &&
		currentSpec.hostPID === expectedSpec.hostPID &&
		currentSpec.hostIPC === expectedSpec.hostIPC &&
		currentContainer.name === expectedContainer.name &&
		currentContainer.image === expectedContainer.image &&
		currentContainer.imagePullPolicy === expectedContainer.imagePullPolicy &&
		stableJson(currentContainer.resources) ===
			stableJson(expectedContainer.resources) &&
		currentContainer.workingDir === expectedContainer.workingDir &&
		stableJson(
			(currentContainer.ports ?? []).map((port) => ({
				...port,
				protocol: port.protocol ?? "TCP",
			})),
		) ===
			stableJson(
				(expectedContainer.ports ?? []).map((port) => ({
					...port,
					protocol: port.protocol ?? "TCP",
				})),
			) &&
		stableJson(normalizeEnv(currentContainer.env)) ===
			stableJson(normalizeEnv(expectedContainer.env)) &&
		stableJson(currentContainer.volumeMounts ?? []) ===
			stableJson(expectedContainer.volumeMounts ?? []) &&
		stableJson(currentContainer.securityContext ?? {}) ===
			stableJson(expectedContainer.securityContext ?? {}) &&
		readinessProbeMatches(
			currentContainer.readinessProbe,
			expectedContainer.readinessProbe,
		) &&
		stableJson(currentSpec.volumes ?? []) ===
			stableJson(expectedSpec.volumes ?? [])
	);
}

function readinessProbeShape(probe: V1Container["readinessProbe"]) {
	return probe
		? {
				...probe,
				httpGet: probe.httpGet
					? {
							...probe.httpGet,
							scheme: probe.httpGet.scheme ?? "HTTP",
						}
					: undefined,
				initialDelaySeconds: probe.initialDelaySeconds ?? 0,
				timeoutSeconds: probe.timeoutSeconds ?? 1,
				periodSeconds: probe.periodSeconds ?? 10,
				successThreshold: probe.successThreshold ?? 1,
				failureThreshold: probe.failureThreshold ?? 3,
			}
		: undefined;
}

/**
 * The probe period changed from five to one second for newly-created Pods.
 * Keep the previous exact shape valid during rollout so an already-owned Pod
 * is not misclassified as drift or conflict merely because kubelet has not
 * rebuilt it. All other probe fields remain exact and fail closed.
 */
function readinessProbeMatches(
	current: V1Container["readinessProbe"],
	expected: V1Container["readinessProbe"],
) {
	const actualShape = readinessProbeShape(current);
	const expectedShape = readinessProbeShape(expected);
	if (stableJson(actualShape) === stableJson(expectedShape)) return true;
	if (expectedShape?.periodSeconds !== 1 || actualShape?.periodSeconds !== 5)
		return false;
	return (
		stableJson({ ...actualShape, periodSeconds: 1 }) ===
		stableJson(expectedShape)
	);
}

function resourceSpecMatches(
	current: KubernetesObject,
	expected: KubernetesObject,
) {
	switch (expected.kind) {
		case "Pod":
			return podSpecMatches(current, expected as V1Pod);
		case "PersistentVolumeClaim":
			return pvcSpecMatches(current, expected as V1PersistentVolumeClaim);
		case "ServiceAccount":
			return (
				(current as V1ServiceAccount).automountServiceAccountToken === false
			);
		case "Secret": {
			// Immutable: any data drift is a replaced object, never an update.
			const actual = current as V1Secret;
			const wanted = expected as V1Secret;
			return (
				actual.type === wanted.type &&
				actual.immutable === true &&
				actual.stringData === undefined &&
				stableJson(actual.data ?? {}) === stableJson(wanted.data ?? {})
			);
		}
		case "NetworkPolicy": {
			if (
				current.metadata?.annotations?.[nativeEgressPolicyAnnotationV1] !==
				expected.metadata?.annotations?.[nativeEgressPolicyAnnotationV1]
			)
				return false;
			const actual = (current as V1NetworkPolicy).spec;
			const wanted = (expected as V1NetworkPolicy).spec;
			const matchLabels = legacyComparableLabels(
				actual?.podSelector?.matchLabels,
				wanted?.podSelector?.matchLabels,
			);
			return (
				stableJson(normalizeNetworkPolicySpec(actual)) ===
				stableJson(
					normalizeNetworkPolicySpec(
						wanted && matchLabels !== wanted.podSelector?.matchLabels
							? {
									...wanted,
									podSelector: { ...wanted.podSelector, matchLabels },
								}
							: wanted,
					),
				)
			);
		}
		case "Service": {
			const actual = (current as V1Service).spec;
			const wanted = (expected as V1Service).spec;
			const ports = (spec: V1Service["spec"]) =>
				spec?.ports?.map((port) => ({
					name: port.name,
					port: port.port,
					targetPort: port.targetPort,
					protocol: port.protocol ?? "TCP",
				}));
			return (
				actual?.type === wanted?.type &&
				stableJson(actual?.selector) ===
					stableJson(
						legacyComparableLabels(actual?.selector, wanted?.selector),
					) &&
				stableJson(ports(actual)) === stableJson(ports(wanted)) &&
				!actual?.externalIPs?.length &&
				!actual?.externalName
			);
		}
		default:
			return false;
	}
}

function normalizeNetworkPolicySpec(spec: V1NetworkPolicy["spec"]) {
	return {
		...spec,
		egress: (spec?.egress ?? []).map((rule) => ({
			...rule,
			ports: rule.ports?.map((port) => ({ protocol: "TCP", ...port })),
		})),
		ingress: spec?.ingress?.map((rule) => ({
			...rule,
			_from:
				rule._from ?? (rule as typeof rule & { from?: typeof rule._from }).from,
			from: undefined,
		})),
	};
}

function owned(
	current: KubernetesObject,
	expected: KubernetesObject,
	allocation: SessionSandboxAllocationV1,
) {
	const currentLabels = current.metadata?.labels ?? {};
	const expectedLabels = expected.metadata?.labels ?? {};
	const currentFence =
		current.metadata?.annotations?.["agent-infra.agora.io/fence"];
	const managed =
		current.metadata?.annotations?.["agent-infra.agora.io/managed"];
	return (
		managed === "session-sandbox-v1" &&
		sessionSandboxLabelsMatchV1(currentLabels, expectedLabels) &&
		hasSessionSandboxIdentityV1(current, allocation) &&
		currentFence === String(allocation.resourceFence)
	);
}

/**
 * 与 owned() 相同，但 fence 注解与 generation 标签只要求不高于 allocation 的值。只用于已被
 * 来源记录钉住 UID 的保留 PVC：沙箱停止后 PVC 不会被改写，它的 fence 与 generation 停在
 * 最初准备时的值；更高的值说明有更新的写入方，仍失败关闭（#2917）。
 */
function ownedAtOrBefore(
	current: KubernetesObject,
	allocation: SessionSandboxAllocationV1,
) {
	if (current.kind !== "PersistentVolumeClaim") return false;
	const counter = (value: string | undefined) => {
		const parsed = Number(value);
		return value !== undefined &&
			String(parsed) === value &&
			Number.isSafeInteger(parsed) &&
			parsed >= 1
			? parsed
			: undefined;
	};
	const resourceFence = counter(
		current.metadata?.annotations?.["agent-infra.agora.io/fence"],
	);
	const generation = counter(
		current.metadata?.labels?.["agent-infra.agora.io/generation"],
	);
	if (
		resourceFence === undefined ||
		generation === undefined ||
		resourceFence > allocation.resourceFence ||
		generation > allocation.generation
	)
		return false;
	const earlier = { ...allocation, generation, resourceFence };
	return owned(
		current,
		{ metadata: metadata(earlier, earlier.pvcName) },
		earlier,
	);
}

export function createSessionSandboxWorkloadAdapterV1(options: {
	readonly client: WorkerKubernetesClientV1;
}) {
	const validateSkillSource = async (
		allocation: SessionSandboxAllocationV1,
	) => {
		if (!allocation.skillHub || allocation.desiredState !== "running") return;
		const owner = workloadResourceNameV1(allocation.agentId);
		const name = `${owner}-data`;
		const source = await options.client.read("PersistentVolumeClaim", name);
		if (
			!source?.metadata?.uid ||
			!source.metadata.resourceVersion ||
			source.metadata.name !== name ||
			source.metadata.namespace !== allocation.namespace ||
			source.metadata.deletionTimestamp ||
			source.metadata.labels?.[ownerLabel] !== owner ||
			source.metadata.annotations?.[agentAnnotation] !== allocation.agentId
		)
			throw new WorkloadKubernetesError("conflict");
	};
	return {
		/**
		 * #2917：来源本身已停止（只记录了保留的 PVC）时，不删除任何资源，只读证明停止：
		 * 其余资源按名称都不存在（任何同名对象都失败关闭，不删除也不接管），PVC 是来源
		 * 记录的同一个（UID、身份一致，fence 不高于来源 fence）。
		 */
		async confirmStoppedSource(
			allocation: SessionSandboxAllocationV1,
			previous: readonly SessionSandboxResourceIdentityV1[],
			context: {
				readonly sourceGeneration: number;
				readonly sourceResourceFence: number;
				readonly targetGeneration: number;
				readonly targetResourceFence: number;
			},
		): Promise<SessionSandboxStopReceiptV1> {
			if (options.client.namespace !== allocation.namespace)
				throw new WorkloadKubernetesError("policy");
			validateAllocation(allocation);
			const [prior] = previous;
			if (
				previous.length !== 1 ||
				prior?.kind !== "PersistentVolumeClaim" ||
				prior.namespace !== allocation.namespace ||
				prior.name !== allocation.pvcName
			)
				throw new WorkloadKubernetesError("conflict");
			const expectedResources = sessionSandboxResourcesV1({
				...allocation,
				desiredState: "stopped",
			});
			for (const expected of expectedResources) {
				if (expected.kind === "PersistentVolumeClaim") continue;
				const kind = expected.kind as SessionSandboxResourceIdentityV1["kind"];
				if (await options.client.read(kind, expected.metadata?.name ?? ""))
					throw new WorkloadKubernetesError("conflict");
			}
			const pvc = await options.client.read(
				"PersistentVolumeClaim",
				allocation.pvcName,
			);
			if (
				!pvc?.metadata?.resourceVersion ||
				pvc.metadata.uid !== prior.uid ||
				pvc.metadata.deletionTimestamp ||
				!ownedAtOrBefore(pvc, allocation)
			)
				throw new WorkloadKubernetesError("conflict");
			return {
				schemaVersion: 1,
				sandboxId: allocation.sandboxId,
				sessionId: allocation.sessionId,
				...context,
				removed: [],
				retainedPVC: {
					...prior,
					resourceVersion: pvc.metadata.resourceVersion,
				},
			};
		},
		async prepareRetainedPVC(
			allocation: SessionSandboxAllocationV1,
			lifecycle: SessionSandboxLifecycleV1,
			previous: readonly SessionSandboxResourceIdentityV1[],
		) {
			validateAllocation(allocation);
			const { source, stopReceipt: receipt, preparation } = lifecycle;
			const prior = previous.find(
				(resource) => resource.kind === "PersistentVolumeClaim",
			);
			if (
				options.client.namespace !== allocation.namespace ||
				allocation.desiredState !== "running" ||
				lifecycle.authority.targetDesiredState !== "running" ||
				!receipt ||
				!receipt.retainedPVC ||
				!preparation ||
				preparation.generation !== allocation.generation ||
				preparation.resourceFence !== allocation.resourceFence ||
				source.sandbox.sandboxId !== allocation.sandboxId ||
				source.sandbox.sessionId !== allocation.sessionId ||
				source.sandbox.agentId !== allocation.agentId ||
				source.sandbox.channelId !== allocation.channelId ||
				source.sandbox.principal.kind !== allocation.principal.kind ||
				source.sandbox.principal.id !== allocation.principal.id ||
				source.sandbox.resourceName !== allocation.resourceName ||
				source.sandbox.workspaceScope !== allocation.workspaceScope ||
				source.sandbox.generation > allocation.generation ||
				source.resourceFence >= allocation.resourceFence ||
				receipt.targetGeneration > allocation.generation ||
				receipt.targetResourceFence > allocation.resourceFence ||
				!decideSessionSandboxDrainObservationV1({
					sandbox: { ...source.sandbox, generation: receipt.targetGeneration },
					resourceFence: receipt.targetResourceFence,
					lifecycle,
					observation: {
						status: "stopped",
						resources: [receipt.retainedPVC],
						sourceStop: receipt,
					},
				}).finished ||
				!prior ||
				prior.uid !== receipt.retainedPVC.uid ||
				prior.namespace !== allocation.namespace ||
				prior.name !== allocation.pvcName ||
				prior.namespace !== receipt.retainedPVC.namespace ||
				prior.name !== receipt.retainedPVC.name
			)
				throw new WorkloadKubernetesError("conflict");
			const expected = sessionSandboxResourcesV1(allocation).find(
				(resource): resource is V1PersistentVolumeClaim =>
					resource.kind === "PersistentVolumeClaim",
			);
			if (!expected) throw new WorkloadKubernetesError("policy");
			const current = await options.client.read<V1PersistentVolumeClaim>(
				"PersistentVolumeClaim",
				allocation.pvcName,
			);
			if (
				!current ||
				current.metadata?.uid !== prior.uid ||
				!current.metadata.resourceVersion ||
				current.metadata.deletionTimestamp ||
				current.metadata.name !== prior.name ||
				current.metadata.namespace !== prior.namespace ||
				!pvcSpecMatches(current, expected)
			)
				throw new WorkloadKubernetesError("conflict");
			if (owned(current, expected, allocation)) return;
			const sourceAllocation = {
				...allocation,
				generation: source.sandbox.generation,
				resourceFence: source.resourceFence,
			};
			// 来源 PVC 的身份校验不依赖已销毁的 Session Secret 物化（#3305）。
			const sourceExpected = {
				...expected,
				metadata: metadata(sourceAllocation, sourceAllocation.pvcName),
			};
			// 来源已停止（#2917）时 PVC 的 fence 与 generation 停在最初准备时的值，UID 已被回执钉住。
			if (
				!(source.observation?.status === "stopped"
					? ownedAtOrBefore(current, sourceAllocation)
					: owned(current, sourceExpected, sourceAllocation))
			)
				throw new WorkloadKubernetesError("conflict");
			// Preserve the volume and use the observed UID/resourceVersion for this
			// single Store-authorized ownership transition, never an unfenced adoption.
			await options.client.replace({
				...current,
				metadata: {
					...current.metadata,
					labels: { ...current.metadata.labels, ...expected.metadata?.labels },
					annotations: {
						...current.metadata.annotations,
						...expected.metadata?.annotations,
					},
				},
			});
			const rebound = await options.client.read(
				"PersistentVolumeClaim",
				allocation.pvcName,
			);
			if (
				!rebound ||
				rebound.metadata?.uid !== prior.uid ||
				!rebound.metadata.resourceVersion ||
				!owned(rebound, expected, allocation) ||
				!pvcSpecMatches(rebound, expected)
			)
				throw new WorkloadKubernetesError("conflict");
		},
		async apply(
			allocation: SessionSandboxAllocationV1,
			previous: readonly SessionSandboxResourceIdentityV1[] = [],
		) {
			if (options.client.namespace !== allocation.namespace)
				throw new WorkloadKubernetesError("policy");
			// 只有排空（stopped）允许 runtime 为 null；运行中的 allocation 缺 runtime 会建出
			// 缺 Secret / env 的 Pod，必须在任何写入之前拒绝（#2885）。
			if (allocation.desiredState === "running" && allocation.runtime === null)
				throw new WorkloadKubernetesError("policy");
			const resources = sessionSandboxResourcesV1(allocation);
			await validateSkillSource(allocation);
			if (
				allocation.desiredState === "running" &&
				allocation.egress.nativeEgress &&
				hasAdditionalEgressPolicyV1(
					await options.client.list<V1NetworkPolicy>("NetworkPolicy", ""),
					resources.find((r) => r.kind === "NetworkPolicy") as V1NetworkPolicy,
				)
			)
				throw new WorkloadKubernetesError("policy");
			// Check the complete previous set before any write. A vanished or replaced
			// instance needs Store-authorized recovery, not implicit allocation here.
			for (const prior of previous) {
				const expected = resources.find(
					(resource) => resource.kind === prior.kind,
				);
				if (
					!expected ||
					prior.namespace !== allocation.namespace ||
					prior.name !== expected.metadata?.name
				)
					throw new WorkloadKubernetesError("conflict");
				const current = await options.client.read(prior.kind, prior.name);
				if (
					!current ||
					current.metadata?.uid !== prior.uid ||
					!owned(current, expected, allocation)
				)
					throw new WorkloadKubernetesError("conflict");
			}
			const ensure = async (expected: KubernetesObject) => {
				if (
					allocation.desiredState === "stopped" &&
					stoppedAbsentKinds.has(expected.kind ?? "")
				) {
					const kind =
						expected.kind as SessionSandboxResourceIdentityV1["kind"];
					const current = await options.client.read(
						kind,
						expected.metadata?.name ?? "",
					);
					if (current) {
						if (!owned(current, expected, allocation))
							throw new WorkloadKubernetesError("conflict");
						await options.client.delete(current);
						if (await options.client.read(kind, expected.metadata?.name ?? ""))
							throw new WorkloadKubernetesError("unavailable");
					}
					return;
				}
				const kind = expected.kind as SessionSandboxResourceIdentityV1["kind"];
				const current = await options.client.read(
					kind,
					expected.metadata?.name ?? "",
				);
				// observation deliberately validates every owned resource before readiness.
				if (current && !owned(current, expected, allocation))
					throw new WorkloadKubernetesError("conflict");
				if (!current) await options.client.create(expected);
				else if (expected.kind === "PersistentVolumeClaim") {
					if (
						!pvcSpecMatches(
							current as V1PersistentVolumeClaim,
							expected as V1PersistentVolumeClaim,
						)
					)
						throw new WorkloadKubernetesError("conflict");
				} else if (expected.kind === "Pod") {
					if (!podSpecMatches(current, expected as V1Pod))
						throw new WorkloadKubernetesError("conflict");
				} else if (expected.kind === "Service") {
					// Keep the API-assigned address and version on lawful retries.
					// An owned Service with a different route is drift, not an update.
					if (!resourceSpecMatches(current, expected))
						throw new WorkloadKubernetesError("conflict");
				} else if (
					expected.kind === "ServiceAccount" ||
					expected.kind === "NetworkPolicy" ||
					expected.kind === "Secret"
				) {
					// Kube may add defaulted fields to these owned resources. A
					// matching object is already converged; replacing it can turn a
					// harmless retry into a 409 on immutable/defaulted fields.
					if (!resourceSpecMatches(current, expected))
						throw new WorkloadKubernetesError("conflict");
				} else
					await options.client.replace({
						...expected,
						metadata: {
							...expected.metadata,
							resourceVersion: current.metadata?.resourceVersion,
							uid: current.metadata?.uid,
						},
					});
			};
			if (allocation.desiredState === "stopped") {
				for (const expected of resources) await ensure(expected);
			} else {
				const pod = resources.find((resource) => resource.kind === "Pod");
				if (!pod) throw new WorkloadKubernetesError("policy");
				// PVC, identity, policy, route and Secret are independent. The Pod
				// is the only resource that consumes all of them, so keep it in a
				// second wave while collapsing the control-plane round trips.
				// 成功的兄弟资源已经收敛；失败时要等这一波全部结束再抛，重试不会与
				// 仍在进行的 create / delete / replace 重叠（#3338 review）。
				const settled = await Promise.allSettled(
					resources
						.filter((resource) => resource.kind !== "Pod")
						.map((resource) => ensure(resource)),
				);
				const failure = settled.find(
					(result): result is PromiseRejectedResult =>
						result.status === "rejected",
				);
				if (failure) throw failure.reason;
				await ensure(pod);
			}
			return {
				sandboxId: allocation.sandboxId,
				generation: allocation.generation,
				resourceFence: allocation.resourceFence,
			};
		},
		async observe(
			allocation: SessionSandboxAllocationV1,
			previous: readonly SessionSandboxResourceIdentityV1[] = [],
			purpose: "business" | "control" = "business",
		): Promise<SessionSandboxObservationV1> {
			if (options.client.namespace !== allocation.namespace)
				throw new WorkloadKubernetesError("policy");
			validateAllocation(allocation);
			if (purpose === "business") await validateSkillSource(allocation);
			const resources: SessionSandboxResourceIdentityV1[] = [];
			let status: SessionSandboxObservationV1["status"] =
				allocation.desiredState === "stopped" ? "stopped" : "ready";
			let failureCode: SessionSandboxObservationV1["failureCode"];
			const expectedResources = sessionSandboxResourcesV1(
				purpose === "control"
					? { ...allocation, desiredState: "stopped" }
					: allocation,
			);
			if (
				purpose === "business" &&
				allocation.desiredState === "running" &&
				allocation.egress.nativeEgress &&
				hasAdditionalEgressPolicyV1(
					await options.client.list<V1NetworkPolicy>("NetworkPolicy", ""),
					expectedResources.find(
						(r) => r.kind === "NetworkPolicy",
					) as V1NetworkPolicy,
				)
			)
				throw new WorkloadKubernetesError("policy");
			// #1481（按 Sandbox 投影 Runtime 输入）之前准备的来源没有模型投影，排空 allocation 的
			// runtime 为 null：当时不创建 Runtime Secret，资源规格也由当时的模板渲染，今天的模板
			// 复现不了。这类来源的 control 观测只按归属标记与 UID 识别（#2885）。
			const preparedBeforeRuntimeInputs =
				purpose === "control" && allocation.runtime === null;
			const observed = await Promise.all(
				expectedResources.map(async (expected) => {
					const kind =
						expected.kind as SessionSandboxResourceIdentityV1["kind"];
					const name = expected.metadata?.name ?? "";
					const current = await options.client.read(kind, name);
					return { expected, kind, name, current };
				}),
			);
			for (const { expected, kind, name, current } of observed) {
				if (
					allocation.desiredState === "stopped" &&
					stoppedAbsentKinds.has(kind)
				) {
					if (current) status = "unknown";
					continue;
				}
				if (!current && kind === "Secret" && preparedBeforeRuntimeInputs)
					continue;
				if (
					!current ||
					!owned(current, expected, allocation) ||
					!current.metadata?.uid ||
					!current.metadata.resourceVersion ||
					current.metadata.deletionTimestamp ||
					current.metadata.namespace !== allocation.namespace ||
					current.metadata.name !== name
				) {
					status = "unknown";
					continue;
				}
				const identity = {
					kind,
					namespace: allocation.namespace,
					name,
					uid: current.metadata.uid,
					resourceVersion: current.metadata.resourceVersion,
				};
				resources.push(identity);
				const prior = previous.find((resource) => resource.kind === kind);
				// resourceVersion changes on legitimate writes; UID must retain instance identity.
				if (
					prior &&
					(prior.namespace !== identity.namespace ||
						prior.name !== name ||
						prior.uid !== identity.uid)
				)
					status = "unknown";
				const matches =
					preparedBeforeRuntimeInputs ||
					(purpose === "control" && kind === "Pod"
						? podSpecMatches(
								runtimeConnectionConsumerControlPodV1(current as V1Pod),
								runtimeConnectionConsumerControlPodV1(expected as V1Pod),
							)
						: resourceSpecMatches(current, expected));
				if (!matches) status = "unknown";
				if (kind === "Pod") {
					const pod = current as V1Pod;
					if (
						status === "ready" &&
						(pod.status?.phase !== "Running" ||
							!pod.status.conditions?.some(
								(condition) =>
									condition.type === "Ready" && condition.status === "True",
							))
					)
						status = "observed";
					if (status === "observed") {
						const container = pod.status?.containerStatuses?.find(
							(entry) => entry.name === "agent",
						);
						const waitingReason = container?.state?.waiting?.reason;
						const terminatedReason = container?.lastState?.terminated?.reason;
						if (
							waitingReason === "ErrImagePull" ||
							waitingReason === "ImagePullBackOff" ||
							waitingReason === "InvalidImageName"
						)
							failureCode = "eci.image_pull";
						else if (waitingReason === "CreateContainerConfigError")
							failureCode = "runtime.configuration";
						else if (
							waitingReason ||
							terminatedReason ||
							pod.status?.phase === "Failed"
						)
							failureCode = "runtime.startup";
					}
				}
			}
			return {
				status:
					purpose === "control" && status === "ready" ? "observed" : status,
				...(failureCode === undefined ? {} : { failureCode }),
				resources,
			};
		},
		async cleanup(
			allocation: SessionSandboxAllocationV1,
			previous: readonly SessionSandboxResourceIdentityV1[] = [],
			context: {
				readonly sourceGeneration?: number;
				readonly sourceResourceFence?: number;
				readonly targetGeneration?: number;
				readonly targetResourceFence?: number;
				readonly managementFence?: number;
				readonly deletionProgress?: readonly SessionSandboxDeletionProgressV1[];
				readonly recordDeletionProgress?: (
					progress: SessionSandboxDeletionProgressV1,
				) => Promise<"committed" | "stale" | "unknown">;
				/** 来源只记录了部分资源（准备中断，#2918）：未记录且不存在的种类视为从未创建。 */
				readonly partialSource?: boolean;
			} = {},
		): Promise<SessionSandboxStopReceiptV1> {
			if (options.client.namespace !== allocation.namespace)
				throw new WorkloadKubernetesError("policy");
			const recordDeletionProgress = context.recordDeletionProgress;
			if (!recordDeletionProgress)
				throw new WorkloadKubernetesError("unavailable");
			const expectedResources = sessionSandboxResourcesV1({
				...allocation,
				desiredState: "stopped",
			});
			const previousByKind = new Map(
				previous.map((resource) => [resource.kind, resource]),
			);
			// #2918：部分来源先确认所有未记录的种类都不存在，再删除任何资源；任一同名对象存在
			// 都失败关闭，不接管也不留下删了一半的状态。
			if (context.partialSource)
				for (const expected of expectedResources) {
					const kind =
						expected.kind as SessionSandboxResourceIdentityV1["kind"];
					if (previousByKind.has(kind)) continue;
					if (await options.client.read(kind, expected.metadata?.name ?? ""))
						throw new WorkloadKubernetesError("conflict");
				}
			const deletedResources: Array<
				SessionSandboxStopReceiptV1["removed"][number]
			> = [];
			const progressByKind = new Map(
				(context.deletionProgress ?? []).map((entry) => [
					entry.resource.kind,
					entry,
				]),
			);
			const record = async (
				resource: SessionSandboxResourceIdentityV1,
				state: SessionSandboxDeletionProgressV1["state"],
				result: SessionSandboxDeletionProgressV1["deleteCallResult"],
				absence?: SessionSandboxDeletionProgressV1["absence"],
			) => {
				const previousProgress = progressByKind.get(resource.kind);
				const progress: SessionSandboxDeletionProgressV1 = {
					schemaVersion: 1,
					state,
					deleteAttemptId: previousProgress?.deleteAttemptId ?? randomUUID(),
					deleteAttempted: result !== "not-attempted",
					deleteCallResult: result,
					sourceGeneration: context.sourceGeneration ?? allocation.generation,
					resourceFence:
						context.sourceResourceFence ?? allocation.resourceFence,
					managementFence:
						previousProgress?.managementFence ?? context.managementFence ?? 0,
					resource,
					preconditions: {
						uid: resource.uid,
						resourceVersion: resource.resourceVersion,
					},
					...(absence ? { absence } : {}),
				};
				const status = await recordDeletionProgress(progress);
				if (status !== "committed")
					throw new WorkloadKubernetesError("unavailable");
				progressByKind.set(resource.kind, progress);
			};
			const terminatingRetry = (
				current: KubernetesObject,
				existing: SessionSandboxDeletionProgressV1 | undefined,
			) =>
				!!existing?.deleteAttempted &&
				existing.deleteCallResult !== "failed" &&
				current.metadata?.uid === existing.resource.uid &&
				!!current.metadata.deletionTimestamp;
			const resources = expectedResources
				.filter((resource) => resource.kind !== "PersistentVolumeClaim")
				.reverse();
			for (const expected of resources) {
				const kind = expected.kind as SessionSandboxResourceIdentityV1["kind"];
				const existing = progressByKind.get(kind);
				const current = await options.client.read(
					kind,
					expected.metadata?.name ?? "",
				);
				if (!current && existing?.deleteAttempted) {
					const absence = existing.absence ?? {
						kind: existing.resource.kind,
						namespace: existing.resource.namespace,
						name: existing.resource.name,
					};
					await record(
						existing.resource,
						"absent",
						existing.deleteCallResult,
						absence,
					);
					deletedResources.push({
						resource: existing.resource,
						preconditions: existing.preconditions,
						absence,
					});
					continue;
				}
				if (!current) {
					const prior = previousByKind.get(kind);
					// #1481（按 Sandbox 投影 Runtime 输入）之前准备的来源（runtime 为 null）从未创建
					// Runtime Secret：既不在集群里、也没被记录时没有可删除的对象（#2885）。
					if (!prior && kind === "Secret" && allocation.runtime === null)
						continue;
					// #2918：部分准备的来源没有记录、集群里也不存在的种类从未被创建。
					if (!prior && context.partialSource) continue;
					if (!prior) throw new WorkloadKubernetesError("unavailable");
					const identity = existing?.resource ?? prior;
					const absence = {
						kind: identity.kind,
						namespace: identity.namespace,
						name: identity.name,
					};
					if (!existing)
						await record(identity, "delete-requested", "not-attempted");
					await record(identity, "absent", "unknown", absence);
					deletedResources.push({
						resource: identity,
						preconditions: existing?.preconditions ?? {
							uid: prior.uid,
							resourceVersion: prior.resourceVersion,
						},
						absence,
					});
					continue;
				}
				if (!current) throw new WorkloadKubernetesError("unavailable");
				if (!owned(current, expected, allocation))
					throw new WorkloadKubernetesError("conflict");
				const prior = previousByKind.get(kind);
				if (
					!prior ||
					prior.uid !== current.metadata?.uid ||
					prior.name !== current.metadata?.name
				)
					throw new WorkloadKubernetesError("conflict");
				const currentResourceVersion = current.metadata?.resourceVersion;
				if (
					existing &&
					(existing.resource.uid !== current.metadata?.uid ||
						(!terminatingRetry(current, existing) &&
							existing.preconditions.resourceVersion !==
								currentResourceVersion))
				)
					throw new WorkloadKubernetesError("conflict");
				const identity = existing
					? existing.resource
					: {
							...prior,
							resourceVersion: currentResourceVersion ?? prior.resourceVersion,
						};
				if (!existing?.deleteAttempted)
					await record(identity, "delete-requested", "not-attempted");
				if (terminatingRetry(current, existing))
					throw new WorkloadKubernetesError("unavailable");
				let callResult: SessionSandboxDeletionProgressV1["deleteCallResult"];
				try {
					if (!options.client.deleteResult)
						throw new WorkloadKubernetesError("unavailable");
					const result = await options.client.deleteResult(current);
					callResult = result === "absent" ? "unknown" : result;
				} catch (error) {
					if (existing?.deleteCallResult !== "acknowledged")
						await record(
							identity,
							"unknown",
							error instanceof WorkloadKubernetesError &&
								error.code !== "unavailable"
								? "failed"
								: "unknown",
						);
					throw error;
				}
				await record(identity, "delete-requested", callResult);
				if (await options.client.read(kind, expected.metadata?.name ?? ""))
					throw new WorkloadKubernetesError("unavailable");
				await record(identity, "absent", callResult, {
					kind,
					namespace: identity.namespace,
					name: identity.name,
				});
				deletedResources.push({
					resource: {
						...prior,
						resourceVersion:
							current.metadata?.resourceVersion ?? prior.resourceVersion,
					},
					preconditions: {
						uid: current.metadata?.uid ?? prior.uid,
						resourceVersion:
							current.metadata?.resourceVersion ?? prior.resourceVersion,
					},
					absence: {
						kind: prior.kind,
						namespace: prior.namespace,
						name: prior.name,
					},
				});
			}
			const expectedKinds = new Set(
				expectedResources.map((resource) => resource.kind),
			);
			for (const prior of previous) {
				if (
					prior.kind === "PersistentVolumeClaim" ||
					expectedKinds.has(prior.kind)
				)
					continue;
				const expected: KubernetesObject = {
					apiVersion: prior.kind === "StatefulSet" ? "apps/v1" : undefined,
					kind: prior.kind,
					metadata: {
						namespace: prior.namespace,
						name: prior.name,
						labels: { ...labels(allocation) },
						annotations: {
							...sessionSandboxIdentityAnnotationsV1(allocation),
							"agent-infra.agora.io/fence": String(allocation.resourceFence),
							"agent-infra.agora.io/managed": "session-sandbox-v1",
						},
					},
				};
				const existing = progressByKind.get(prior.kind);
				const current = await options.client.read(prior.kind, prior.name);
				if (!current && existing?.deleteAttempted) {
					const absence = existing.absence ?? {
						kind: existing.resource.kind,
						namespace: existing.resource.namespace,
						name: existing.resource.name,
					};
					await record(
						existing.resource,
						"absent",
						existing.deleteCallResult,
						absence,
					);
					deletedResources.push({
						resource: existing.resource,
						preconditions: existing.preconditions,
						absence,
					});
					continue;
				}
				if (!current) {
					const identity = existing?.resource ?? prior;
					const absence = {
						kind: identity.kind,
						namespace: identity.namespace,
						name: identity.name,
					};
					if (!existing)
						await record(identity, "delete-requested", "not-attempted");
					await record(identity, "absent", "unknown", absence);
					deletedResources.push({
						resource: identity,
						preconditions: existing?.preconditions ?? {
							uid: prior.uid,
							resourceVersion: prior.resourceVersion,
						},
						absence,
					});
					continue;
				}
				if (
					!current ||
					!owned(current, expected, allocation) ||
					current.metadata?.uid !== prior.uid ||
					!current.metadata.resourceVersion
				)
					throw new WorkloadKubernetesError("conflict");
				if (
					existing &&
					(existing.resource.uid !== current.metadata?.uid ||
						(!terminatingRetry(current, existing) &&
							existing.preconditions.resourceVersion !==
								current.metadata.resourceVersion))
				)
					throw new WorkloadKubernetesError("conflict");
				const identity = existing
					? existing.resource
					: {
							...prior,
							resourceVersion: current.metadata.resourceVersion,
						};
				if (!existing?.deleteAttempted)
					await record(identity, "delete-requested", "not-attempted");
				if (terminatingRetry(current, existing))
					throw new WorkloadKubernetesError("unavailable");
				let callResult: SessionSandboxDeletionProgressV1["deleteCallResult"];
				try {
					if (!options.client.deleteResult)
						throw new WorkloadKubernetesError("unavailable");
					const result = await options.client.deleteResult(current);
					callResult = result === "absent" ? "unknown" : result;
				} catch (error) {
					if (existing?.deleteCallResult !== "acknowledged")
						await record(
							identity,
							"unknown",
							error instanceof WorkloadKubernetesError &&
								error.code !== "unavailable"
								? "failed"
								: "unknown",
						);
					throw error;
				}
				await record(identity, "delete-requested", callResult);
				if (await options.client.read(prior.kind, prior.name))
					throw new WorkloadKubernetesError("unavailable");
				await record(identity, "absent", callResult, {
					kind: prior.kind,
					namespace: identity.namespace,
					name: identity.name,
				});
				deletedResources.push({
					resource: {
						...prior,
						resourceVersion: current.metadata.resourceVersion,
					},
					preconditions: {
						uid: prior.uid,
						resourceVersion: current.metadata.resourceVersion,
					},
					absence: {
						kind: prior.kind,
						namespace: prior.namespace,
						name: prior.name,
					},
				});
			}

			const pvcExpected = expectedResources.find(
				(resource) => resource.kind === "PersistentVolumeClaim",
			);
			if (!pvcExpected) throw new WorkloadKubernetesError("policy");
			const pvc = await options.client.read(
				"PersistentVolumeClaim",
				pvcExpected.metadata?.name ?? "",
			);
			const pvcPrior = previousByKind.get("PersistentVolumeClaim");
			const receipt = {
				schemaVersion: 1 as const,
				sandboxId: allocation.sandboxId,
				sessionId: allocation.sessionId,
				sourceGeneration: context.sourceGeneration ?? allocation.generation,
				sourceResourceFence:
					context.sourceResourceFence ?? allocation.resourceFence,
				targetGeneration: context.targetGeneration ?? allocation.generation,
				targetResourceFence:
					context.targetResourceFence ?? allocation.resourceFence,
				removed: deletedResources,
			};
			// #2918：部分准备的来源从未记录 PVC 时，集群里也不能有同名 PVC（未记录的对象一律
			// 失败关闭，不接管）；回执不保留 PVC。
			if (context.partialSource && !pvcPrior) {
				if (pvc) throw new WorkloadKubernetesError("conflict");
				return { ...receipt, retainedPVC: null };
			}
			if (
				!pvc ||
				!pvcPrior ||
				!owned(pvc, pvcExpected, allocation) ||
				pvc.metadata?.uid !== pvcPrior.uid ||
				!pvc.metadata.resourceVersion
			)
				throw new WorkloadKubernetesError("conflict");
			return {
				...receipt,
				retainedPVC: {
					...pvcPrior,
					resourceVersion: pvc.metadata.resourceVersion,
				},
			};
		},
	};
}
