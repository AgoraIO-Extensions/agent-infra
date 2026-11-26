import { isIP } from "node:net";
import {
	validateSessionRuntimePlacementV1,
	type WorkloadResourceConfigurationV1,
} from "@agent-infra/platform-core";
import type { V1Pod, V1PodSpec, V1Toleration } from "@kubernetes/client-node";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import { hasSameStructure } from "./kubernetes-runtime-comparison.js";

/**
 * Deployment-owned placement for every Agent-level Pod (Engineering Spec §10.1
 * "运行形态与调度", ADR-0049/0057). ECI and explicitly approved ACS use virtual
 * nodes; their NetworkPolicy execution evidence must be verified separately.
 *
 * `legacyUnplaced` governs objects created before placement was configured.
 * `retain-until-lifecycle` keeps them serving without automatic rebuild until
 * that Agent's next formal lifecycle apply writes the placement; `reject`
 * treats them as drift. Owner, Manifest and request inputs never reach here.
 */
export interface AgentWorkloadPlacementV1 {
	readonly architecture: "amd64" | "arm64";
	readonly legacyUnplaced: "retain-until-lifecycle" | "reject";
	readonly compute?: "eci" | "acs";
}

export type AgentWorkloadPlacementShapeV1 = "placed" | "unplaced" | "foreign";
export type SessionRuntimePlacementV1 = NonNullable<
	WorkloadResourceConfigurationV1["sessionRuntimePlacement"]
>;
export const sessionRuntimePlacementEnvironmentV1 =
	"AGENT_INFRA_SESSION_RUNTIME_PLACEMENT";

export function sessionRuntimePlacementFromEnvironmentV1(
	value: string | undefined,
	configuredInModule: boolean,
): SessionRuntimePlacementV1 | undefined {
	if (configuredInModule)
		throw new TypeError("SESSION_RUNTIME_PLACEMENT_INVALID");
	if (value === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new TypeError("SESSION_RUNTIME_PLACEMENT_INVALID");
	}
	if (parsed === undefined)
		throw new TypeError("SESSION_RUNTIME_PLACEMENT_INVALID");
	validateSessionRuntimePlacementV1(parsed);
	return parsed;
}

const providerToleration: V1Toleration = {
	key: "virtual-kubelet.io/provider",
	operator: "Equal",
	value: "alibabacloud",
	effect: "NoSchedule",
};

/** Kubernetes DefaultTolerationSeconds output on every live Pod. */
const defaultLiveTolerations: readonly V1Toleration[] = [
	{
		key: "node.kubernetes.io/memory-pressure",
		operator: "Exists",
		effect: "NoSchedule",
	},
	{
		key: "node.kubernetes.io/not-ready",
		operator: "Exists",
		effect: "NoExecute",
		tolerationSeconds: 300,
	},
	{
		key: "node.kubernetes.io/unreachable",
		operator: "Exists",
		effect: "NoExecute",
		tolerationSeconds: 300,
	},
];

/** Observed on live ECI Pods (#4351 inventory); never accepted off ECI. */
const eciLiveTolerations: readonly V1Toleration[] = [
	{
		key: "node.kubernetes.io/not-ready",
		operator: "Exists",
		effect: "NoExecute",
	},
	{
		key: "node.kubernetes.io/unreachable",
		operator: "Exists",
		effect: "NoExecute",
	},
];

/**
 * Platform constraints for known live ECI metadata, not a vendor input schema.
 * Some keys also configure ECI creation; live acceptance never admits them on a
 * template or feeds desired configuration. EIP/IPv6 switches remain rejected.
 */
const eciProviderAnnotations: Readonly<Record<string, RegExp>> = {
	ProviderCreate: /^done$/,
	"alibabacloud.com/cluster-id": /^c[a-z0-9]{1,64}$/,
	"k8s.aliyun.com/cluster-domain":
		/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/,
	"k8s.aliyun.com/dns-cache-enable": /^(?:true|false)$/,
	"k8s.aliyun.com/eci-client-token":
		/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/,
	// These opaque markers support only the observed platform forms.
	"k8s.aliyun.com/eci-container-exit-priority": /^\{\}$/,
	"k8s.aliyun.com/eci-drop-apiserver-interactive-caps": /^$/,
	"k8s.aliyun.com/eci-kube-proxy-enabled": /^(?:true|false)$/,
	"k8s.aliyun.com/eci-schedule-strategy": /^(?:VSwitchOrdered|VSwitchRandom)$/,
	"k8s.aliyun.com/eci-security-group":
		/^sg-[a-z0-9]{1,64}(?:,sg-[a-z0-9]{1,64}){0,4}$/,
	"k8s.aliyun.com/eci-vswitch": /^vsw-[a-z0-9]{1,64}$/,
	"k8s.aliyun.com/k8s-version":
		/^v?[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(?:[-+][A-Za-z0-9.-]{1,96})?$/,
	"k8s.aliyun.com/product-on-eci-mode": /^NA$/,
	"k8s.aliyun.com/vk-version":
		/^v?[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(?:[-+][A-Za-z0-9.-]{1,96})?$/,
	"kubernetes.io/pod-stream-port": /^10250$/,
	"kubernetes.io/resource-type": /^eci$/,
	"k8s.aliyun.com/eci-request-id": /^[A-Za-z0-9-]{1,64}$/,
	"k8s.aliyun.com/eci-instance-id": /^eci-[a-z0-9]{1,64}$/,
	"k8s.aliyun.com/eci-instance-spec":
		/^(?:[0-9]{1,4}(?:\.[0-9]{1,3})?-[0-9]{1,5}(?:\.[0-9]{1,3})?Gi|ecs\.[a-z0-9.-]{1,64})$/,
	"k8s.aliyun.com/eci-instance-cpu": /^[0-9]{1,4}(?:\.[0-9]{1,3})?$/,
	"k8s.aliyun.com/eci-instance-mem": /^[0-9]{1,5}(?:\.[0-9]{1,3})?$/,
	"k8s.aliyun.com/eci-instance-compute-category": /^(?:economy|general)$/,
	"k8s.aliyun.com/eci-platform-version": /^[0-9]{1,6}(?:\.[0-9]{1,6}){0,3}$/,
	"k8s.aliyun.com/eci-created-by-template": /^(?:true|false)$/,
	"k8s.aliyun.com/eni-instance-id": /^eni-[a-z0-9]{1,64}$/,
	"k8s.aliyun.com/eci-vpc": /^vpc-[a-z0-9]{1,64}$/,
	"k8s.aliyun.com/eci-matched-image-cache": /^imc-[a-z0-9]{1,64}$/,
	"k8s.aliyun.com/eci-schedule-result": /^finished$/,
};

/** Bounded provider status observed on the ACS capability probe; request fields stay exact. */
const acsProviderAnnotations: Readonly<Record<string, RegExp>> = {
	ProviderCreate: /^done$/,
	"alibabacloud.com/applied-pod-hash": /^[a-f0-9]{12,64}$/,
	"alibabacloud.com/client-token": /^[a-f0-9-]{36}$/,
	"alibabacloud.com/cpu-vendors": /^(intel|amd)$/,
	"alibabacloud.com/instance-id": /^acs-[a-z0-9]{1,64}$/,
	"alibabacloud.com/instance-cpu": /^[0-9]{1,4}(?:\.[0-9]{1,3})?$/,
	"alibabacloud.com/instance-mem": /^[0-9]{1,5}(?:\.[0-9]{1,3})?$/,
	"alibabacloud.com/platform-version": /^[0-9]{1,6}(?:\.[0-9]{1,6}){0,3}$/,
	"alibabacloud.com/pod-ephemeral-storage": /^[0-9]{1,6}Gi$/,
	"alibabacloud.com/pod-use-spec": /^[0-9.]{1,10}-[0-9.]{1,10}Gi$/,
	"alibabacloud.com/request-id": /^[A-Za-z0-9-]{1,64}$/,
	"alibabacloud.com/required-timezone": /^UTC$/,
	"alibabacloud.com/schedule-result": /^finished$/,
	"alibabacloud.com/user-id": /^[0-9]{1,32}$/,
	"kubernetes.io/pod-stream-port": /^10250$/,
	"kubernetes.io/resource-type": /^eci$/,
	"network.alibabacloud.com/allocated-eni-id": /^eni-[a-z0-9]{1,64}$/,
	"network.alibabacloud.com/enable-dns-cache": /^false$/,
	"network.alibabacloud.com/security-group-id": /^sg-[a-z0-9]{1,64}$/,
	"network.alibabacloud.com/vpc-id": /^vpc-[a-z0-9]{1,64}$/,
	"network.alibabacloud.com/vswitch-id": /^vsw-[a-z0-9]{1,64}$/,
};

/** Rejects anything but the exact deployment shape; absence keeps prior behavior. */
export function validateAgentWorkloadPlacementV1(
	value: unknown,
): asserts value is AgentWorkloadPlacementV1 | undefined {
	if (value === undefined) return;
	const placement = value as Record<string, unknown> | null;
	if (
		!placement ||
		typeof placement !== "object" ||
		Array.isArray(placement) ||
		Object.keys(placement).some(
			(key) => !["architecture", "legacyUnplaced", "compute"].includes(key),
		) ||
		!["amd64", "arm64"].includes(placement.architecture as string) ||
		(placement.compute !== undefined &&
			!["eci", "acs"].includes(placement.compute as string)) ||
		(placement.compute === "acs" && placement.architecture !== "amd64") ||
		!["retain-until-lifecycle", "reject"].includes(
			placement.legacyUnplaced as string,
		)
	)
		throw new TypeError("AGENT_WORKLOAD_PLACEMENT_INVALID");
}

export {
	acsPodMetadataV1,
	withoutAcsStorageDefaultV1,
} from "@agent-infra/platform-core";

/** Pod-template fields the Worker injects; same form as the Session ECI admission. */
export function agentWorkloadPodPlacementV1(
	placement: AgentWorkloadPlacementV1 | undefined,
): Pick<V1PodSpec, "nodeSelector" | "tolerations"> {
	validateAgentWorkloadPlacementV1(placement);
	return placement
		? {
				nodeSelector: {
					type: "virtual-kubelet",
					"kubernetes.io/arch": placement.architecture,
				},
				tolerations: [{ ...providerToleration }],
			}
		: {};
}

/** Controller annotation recording the placement the Worker last wrote for this Agent. */
export const agentWorkloadPlacementAnnotationV1 =
	"agent-infra.agora.io/agent-workload-placement";

/** Chart-rendered Worker env; the only source of the deployment placement. */
export const agentWorkloadPlacementEnvironmentV1 =
	"AGENT_INFRA_AGENT_WORKLOAD_PLACEMENT";

/** Metadata the Worker writes with the injected fields on each Agent controller. */
export function agentWorkloadPlacementRecordV1(
	placement: AgentWorkloadPlacementV1 | undefined,
): Record<string, string> {
	validateAgentWorkloadPlacementV1(placement);
	return placement
		? {
				[agentWorkloadPlacementAnnotationV1]:
					placement.compute === "acs" ? "acs:amd64" : placement.architecture,
			}
		: {};
}

/**
 * Reads the deployment placement from the chart-rendered env (JSON). A Worker
 * module that sets `policy.agentWorkloadPlacement` itself is rejected, so the
 * preflight can bind the exact value the release renders.
 */
export function agentWorkloadPlacementFromEnvironmentV1(
	value: string | undefined,
	configuredInModule: boolean,
): AgentWorkloadPlacementV1 | undefined {
	if (configuredInModule)
		throw new TypeError("AGENT_WORKLOAD_PLACEMENT_INVALID");
	if (value === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new TypeError("AGENT_WORKLOAD_PLACEMENT_INVALID");
	}
	if (parsed === undefined || parsed === null)
		throw new TypeError("AGENT_WORKLOAD_PLACEMENT_INVALID");
	validateAgentWorkloadPlacementV1(parsed);
	return parsed;
}

function shapeFor(
	architecture: string | undefined,
	spec: V1PodSpec | undefined,
	live: boolean,
): AgentWorkloadPlacementShapeV1 {
	if (
		spec?.affinity !== undefined ||
		spec?.runtimeClassName !== undefined ||
		(!live && spec?.nodeName !== undefined)
	)
		return "foreign";
	const selector = spec?.nodeSelector ?? {};
	const tolerations = spec?.tolerations ?? [];
	const without = (allowed: readonly V1Toleration[]) =>
		tolerations.filter(
			(entry) =>
				!live || !allowed.some((item) => hasSameStructure(entry, item)),
		);
	if (Object.keys(selector).length === 0)
		return without(defaultLiveTolerations).length === 0
			? "unplaced"
			: "foreign";
	if (
		(architecture !== "amd64" && architecture !== "arm64") ||
		!hasSameStructure(selector, {
			type: "virtual-kubelet",
			"kubernetes.io/arch": architecture,
		}) ||
		!hasSameStructure(
			without([...defaultLiveTolerations, ...eciLiveTolerations]),
			[providerToleration],
		) ||
		(live &&
			spec?.nodeName !== undefined &&
			!spec.nodeName.startsWith("virtual-kubelet-"))
	)
		return "foreign";
	return "placed";
}

/**
 * Classifies scheduling fields against the current deployment placement.
 * `live` admits the API-server default tolerations and the scheduled node; a
 * template admits neither.
 */
export function agentWorkloadPlacementShapeV1(
	placement: AgentWorkloadPlacementV1 | undefined,
	spec: V1PodSpec | undefined,
	live: boolean,
): AgentWorkloadPlacementShapeV1 {
	validateAgentWorkloadPlacementV1(placement);
	return shapeFor(placement?.architecture, spec, live);
}

/**
 * Observation accepts what this Agent last adopted: the exact placement
 * recorded on its controller, or (without a record) a pre-placement object while
 * the deployment retains them. The current policy only decides what the next
 * formal lifecycle apply writes, so changing it never rebuilds a Host.
 */
export function acceptsAdoptedAgentWorkloadPlacementV1(
	placement: AgentWorkloadPlacementV1 | undefined,
	record: string | undefined,
	spec: V1PodSpec | undefined,
	live: boolean,
): boolean {
	validateAgentWorkloadPlacementV1(placement);
	if (record === undefined)
		return (
			shapeFor(undefined, spec, live) === "unplaced" &&
			(placement === undefined ||
				placement.legacyUnplaced === "retain-until-lifecycle")
		);
	return (
		(record === "amd64" || record === "arm64" || record === "acs:amd64") &&
		shapeFor(record === "acs:amd64" ? "amd64" : record, spec, live) === "placed"
	);
}

/** Provider status on a Pod carrying the controller's recorded compute placement. */
export function isProviderPodAnnotationV1(
	record: string | undefined,
	spec: V1PodSpec | undefined,
	key: string,
	value: string,
	metadata?: V1Pod["metadata"],
): boolean {
	if (record === "acs:amd64") {
		const pattern = Object.hasOwn(acsProviderAnnotations, key)
			? acsProviderAnnotations[key]
			: undefined;
		return (
			shapeFor("amd64", spec, true) === "placed" &&
			pattern?.test(value) === true
		);
	}
	if (
		(record !== "amd64" && record !== "arm64") ||
		shapeFor(record, spec, true) !== "placed"
	)
		return false;
	switch (key) {
		case "alibabacloud.com/user-resource-name":
			return !!metadata?.name && value === metadata.name;
		case "alibabacloud.com/user-resource-namespace":
			return !!metadata?.namespace && value === metadata.namespace;
		case "alibabacloud.com/user-resource-uid":
			return !!metadata?.uid && value === metadata.uid;
		case "k8s.aliyun.com/eci-instance-zone":
			return (
				!!metadata?.labels?.["topology.kubernetes.io/zone"] &&
				value === metadata.labels["topology.kubernetes.io/zone"]
			);
		case "kubernetes.io/preferred-scheduling-node":
			// ECI can write the hint before binding the Pod to a node. It is
			// observation only; after binding the actual node remains authoritative.
			return spec?.nodeName === undefined
				? /^(?=.{1,255}$)virtual-kubelet-[a-z0-9](?:[a-z0-9-]{0,45}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\/1$/u.test(
						value,
					)
				: value === `${spec.nodeName}/1`;
		case "k8s.aliyun.com/cluster-dns": {
			const addresses = value.split(",");
			return (
				value === "" ||
				(value.length <= 137 &&
					addresses.length <= 3 &&
					addresses.every((address) => isIP(address) !== 0))
			);
		}
	}
	const pattern = Object.hasOwn(eciProviderAnnotations, key)
		? eciProviderAnnotations[key]
		: undefined;
	return pattern?.test(value) === true;
}

/**
 * The placement an apply writes. A formal management command (stop_agent,
 * restart_agent, publish: each a CAS on the management revision that issues a
 * new fence) adopts the deployment value. `sameCommand` is true when the apply
 * reuses the fence under which the controller was last written (drift repair,
 * which only advances the reconciliation revision; recovery; re-applying the
 * same intent): then the controller's adoption record decides, never its
 * possibly drifted template. A recorded architecture is restored with its
 * canonical fields; a pre-placement object stays unplaced while retained.
 * Anything else under the same command cannot be confirmed and fails closed
 * instead of adopting the deployment value (Spec §10.1).
 */
export function effectiveAgentWorkloadPlacementV1(
	placement: AgentWorkloadPlacementV1 | undefined,
	current:
		| {
				readonly metadata?: {
					readonly annotations?: Readonly<Record<string, string>>;
				};
				readonly spec?: { readonly template?: { readonly spec?: V1PodSpec } };
		  }
		| null
		| undefined,
	sameCommand: boolean,
): AgentWorkloadPlacementV1 | undefined {
	validateAgentWorkloadPlacementV1(placement);
	if (!current || !sameCommand) return placement;
	const record =
		current.metadata?.annotations?.[agentWorkloadPlacementAnnotationV1];
	if (record === "amd64" || record === "arm64")
		return {
			architecture: record,
			legacyUnplaced: placement?.legacyUnplaced ?? "reject",
		};
	if (record === "acs:amd64")
		return {
			architecture: "amd64",
			compute: "acs",
			legacyUnplaced: placement?.legacyUnplaced ?? "reject",
		};
	if (record === undefined) {
		// Without a deployment placement nothing is adopted: unchanged behavior.
		if (placement === undefined) return undefined;
		if (
			acceptsAdoptedAgentWorkloadPlacementV1(
				placement,
				undefined,
				current.spec?.template?.spec,
				false,
			)
		)
			return undefined;
	}
	throw new WorkloadKubernetesError("policy");
}
