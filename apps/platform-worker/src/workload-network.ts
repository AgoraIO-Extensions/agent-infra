import { createHash } from "node:crypto";
import {
	compileWorkloadEgressRulesV1,
	type NativeEgressPolicyV1,
	type NetworkPolicySpecV1,
	type WorkloadEgressDestinationV1,
	WorkloadEgressPolicyError,
	type WorkloadEgressPolicyV1,
} from "@agent-infra/platform-core";
import type {
	V1NetworkPolicy,
	V1NetworkPolicyEgressRule,
} from "@kubernetes/client-node";
import { WorkloadKubernetesError } from "./kubernetes-client.js";

export type {
	NativeEgressPolicyV1,
	WorkloadEgressDestinationV1,
	WorkloadEgressPolicyV1,
};

export const nativeEgressPolicyAnnotationV1 =
	"agent-infra.agora.io/native-egress-policy";
export function nativeEgressPolicyAnnotationsV1(
	value: NativeEgressPolicyV1 | undefined,
): Record<string, string> {
	return value === undefined
		? {}
		: {
				[nativeEgressPolicyAnnotationV1]: createHash("sha256")
					.update(JSON.stringify(value))
					.digest("hex"),
			};
}

/** NetworkPolicy allows are additive; unknown selectors conservatively overlap. */
export function hasAdditionalEgressPolicyV1(
	policies: readonly V1NetworkPolicy[],
	expected: V1NetworkPolicy,
) {
	const labels = expected.spec?.podSelector?.matchLabels ?? {};
	return policies.some((policy) => {
		if (
			policy.metadata?.name === expected.metadata?.name ||
			!(
				policy.spec?.policyTypes?.includes("Egress") ??
				!!policy.spec?.egress?.length
			) ||
			!policy.spec?.egress?.length
		)
			return false;
		if (policy.spec.podSelector?.matchExpressions?.length) return true;
		return !Object.entries(policy.spec.podSelector?.matchLabels ?? {}).some(
			([key, value]) => Object.hasOwn(labels, key) && labels[key] !== value,
		);
	});
}

export function workloadEgressRulesV1(
	policy: WorkloadEgressPolicyV1,
): V1NetworkPolicyEgressRule[] {
	try {
		return compileWorkloadEgressRulesV1(policy);
	} catch (error) {
		if (error instanceof WorkloadEgressPolicyError)
			throw new WorkloadKubernetesError("policy");
		throw error;
	}
}

export function requireWorkspaceSnapshotEgressV1(
	value: WorkloadEgressPolicyV1["workspaceSnapshotEgress"],
) {
	if (!Array.isArray(value) || value.length === 0)
		throw new WorkloadKubernetesError("policy");
	workloadEgressRulesV1({ workspaceSnapshotEgress: value });
}

/** The Kubernetes client names the ingress `from` field `_from`. */
export function toClientNetworkPolicySpecV1(
	spec: NetworkPolicySpecV1,
): V1NetworkPolicy["spec"] {
	return {
		...spec,
		ingress: spec.ingress.map(({ from, ...rule }) => ({
			...rule,
			...(from === undefined ? {} : { _from: from }),
		})),
	} as V1NetworkPolicy["spec"];
}
