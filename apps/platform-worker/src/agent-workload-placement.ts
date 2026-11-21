import type { V1PodSpec, V1Toleration } from "@kubernetes/client-node";
import { hasSameStructure } from "./kubernetes-runtime-comparison.js";

/**
 * Deployment-owned placement for every Agent-level Pod (Engineering Spec §10.1
 * "运行形态与调度", ADR-0049). Only the ECI virtual-kubelet form is accepted:
 * its NetworkPolicy is enforced by ACK Poseidon, unlike flannel ECS nodes.
 *
 * `legacyUnplaced` governs objects created before placement was configured.
 * `retain-until-lifecycle` keeps them serving without automatic rebuild until
 * that Agent's next formal lifecycle apply writes the placement; `reject`
 * treats them as drift. Owner, Manifest and request inputs never reach here.
 */
export interface AgentWorkloadPlacementV1 {
	readonly architecture: "amd64" | "arm64";
	readonly legacyUnplaced: "retain-until-lifecycle" | "reject";
}

export type AgentWorkloadPlacementShapeV1 = "placed" | "unplaced" | "foreign";

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
 * Status annotations the ECI provider writes after scheduling (Alibaba Cloud
 * "ECI pod annotations", plus values observed on this cluster). EIP/IPv6
 * allocations and every request-side annotation stay rejected.
 */
const eciProviderAnnotations: Readonly<Record<string, RegExp>> = {
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
		Object.keys(placement).sort().join(",") !== "architecture,legacyUnplaced" ||
		!["amd64", "arm64"].includes(placement.architecture as string) ||
		!["retain-until-lifecycle", "reject"].includes(
			placement.legacyUnplaced as string,
		)
	)
		throw new TypeError("AGENT_WORKLOAD_PLACEMENT_INVALID");
}

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
		? { [agentWorkloadPlacementAnnotationV1]: placement.architecture }
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
		(record === "amd64" || record === "arm64") &&
		shapeFor(record, spec, live) === "placed"
	);
}

/** Provider status annotation on a Pod that carries its controller's recorded ECI placement. */
export function isEciProviderPodAnnotationV1(
	record: string | undefined,
	spec: V1PodSpec | undefined,
	key: string,
	value: string,
): boolean {
	const pattern = Object.hasOwn(eciProviderAnnotations, key)
		? eciProviderAnnotations[key]
		: undefined;
	return (
		pattern?.test(value) === true &&
		(record === "amd64" || record === "arm64") &&
		shapeFor(record, spec, true) === "placed"
	);
}

/**
 * The placement an apply writes. While the controller's revision is unchanged
 * (the same intent re-applied, not a formal lifecycle) an accepted recorded
 * placement is kept, so changing the deployment value never rebuilds a Host;
 * a new revision (restart/stop→restart, publish) adopts the deployment value.
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
	sameRevision: boolean,
): AgentWorkloadPlacementV1 | undefined {
	validateAgentWorkloadPlacementV1(placement);
	if (!current || !sameRevision) return placement;
	const record =
		current.metadata?.annotations?.[agentWorkloadPlacementAnnotationV1];
	if (
		!acceptsAdoptedAgentWorkloadPlacementV1(
			placement,
			record,
			current.spec?.template?.spec,
			false,
		)
	)
		return placement;
	return record === "amd64" || record === "arm64"
		? {
				architecture: record,
				legacyUnplaced: placement?.legacyUnplaced ?? "reject",
			}
		: undefined;
}
