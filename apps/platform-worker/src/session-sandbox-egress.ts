import { createHash } from "node:crypto";
import type { V1NetworkPolicy } from "@kubernetes/client-node";
import {
	type WorkerKubernetesClientV1,
	WorkloadKubernetesError,
} from "./kubernetes-client.js";
import { matchesNetworkPolicySpec } from "./kubernetes-runtime-comparison.js";
import {
	type WorkloadEgressPolicyV1,
	workloadEgressRulesV1,
} from "./workload-network.js";

/** Worker-only projection of the original committed allocation, not a new Store/wire contract. */
export interface SessionSandboxEgressBindingV1 {
	readonly schemaVersion: 1;
	readonly principalId: string;
	readonly agentId: string;
	readonly sessionId: string;
	readonly sandboxId: string;
	readonly generation: number;
	readonly fence: number;
	readonly configRevision: number;
	readonly workloadRevision: number;
	readonly namespace: string;
	readonly leaseId: string;
	readonly leaseExpiresAt: number;
}
export interface SessionSandboxEgressReceiptV1 {
	readonly name: string;
	readonly uid: string;
	readonly resourceVersion: string;
}
type Operation = "apply" | "observe" | "revoke" | "remove";
const prefix = "agent-infra.agora.io/";
const labelValue = /^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;

/**
 * #1251 calls this before creating a Pod and before admitting work. The profile
 * is an immutable deployment-approved compilation; Connection rules must come
 * from the full Spec 13.5 Consumer snapshot, resolved by its configuration owner.
 * No endpoint, model setting or Runtime/request field is accepted by operations.
 */
export function createSessionSandboxEgressV1(options: {
	readonly client: WorkerKubernetesClientV1;
	readonly profile: WorkloadEgressPolicyV1 & {
		readonly ref: string;
		readonly revision: string;
	};
	/**
	 * The allocation owner must revalidate principal, revisions, generation and
	 * current lease/fence, and serialize action with allocation transitions using
	 * the ORIGINAL authority. Remove additionally requires retirement/no Pod creation.
	 * This seam neither opens a Store transaction nor keeps an in-memory authority.
	 */
	readonly withCurrentAllocation: <T>(
		binding: SessionSandboxEgressBindingV1,
		operation: Operation,
		action: () => Promise<T>,
	) => Promise<T>;
}) {
	const { client } = options;
	const profile = structuredClone(options.profile);
	if (!profile.ref || !profile.revision)
		throw new WorkloadKubernetesError("policy");
	const egress = workloadEgressRulesV1(profile);
	function assertValidBinding(value: SessionSandboxEgressBindingV1) {
		if (
			value.schemaVersion !== 1 ||
			value.namespace !== client.namespace ||
			![value.agentId, value.sessionId, value.sandboxId].every(
				(id) => typeof id === "string" && labelValue.test(id),
			) ||
			typeof value.principalId !== "string" ||
			!value.principalId ||
			typeof value.leaseId !== "string" ||
			!value.leaseId ||
			![
				value.generation,
				value.fence,
				value.configRevision,
				value.workloadRevision,
			].every((n) => Number.isSafeInteger(n) && n > 0) ||
			!Number.isSafeInteger(value.leaseExpiresAt) ||
			value.leaseExpiresAt <= Date.now()
		)
			throw new WorkloadKubernetesError("policy");
	}
	function expected(value: SessionSandboxEgressBindingV1, revoked = false) {
		assertValidBinding(value);
		const labels = {
			[`${prefix}agent-id`]: value.agentId,
			[`${prefix}session-id`]: value.sessionId,
			[`${prefix}sandbox-id`]: value.sandboxId,
			[`${prefix}generation`]: String(value.generation),
		};
		return {
			apiVersion: "networking.k8s.io/v1",
			kind: "NetworkPolicy",
			metadata: {
				namespace: value.namespace,
				name: `sandbox-egress-${createHash("sha256").update(value.sandboxId).digest("hex").slice(0, 40)}`,
				labels,
				annotations: {
					[`${prefix}managed`]: "session-sandbox-egress-v1",
					[`${prefix}principal-id`]: value.principalId,
					[`${prefix}fence`]: String(value.fence),
					[`${prefix}config-revision`]: String(value.configRevision),
					[`${prefix}workload-revision`]: String(value.workloadRevision),
					[`${prefix}egress-profile`]: profile.ref,
					[`${prefix}egress-revision`]: profile.revision,
				},
			},
			spec: {
				podSelector: { matchLabels: labels },
				policyTypes: ["Egress"],
				egress: revoked ? [] : structuredClone(egress),
			},
		} satisfies V1NetworkPolicy;
	}
	function receipt(value: V1NetworkPolicy): SessionSandboxEgressReceiptV1 {
		const { name, uid, resourceVersion } = value.metadata ?? {};
		if (!name || !uid || !resourceVersion)
			throw new WorkloadKubernetesError("conflict");
		return { name, uid, resourceVersion };
	}
	function owned(
		actual: V1NetworkPolicy,
		desired: V1NetworkPolicy,
		known: SessionSandboxEgressReceiptV1 | undefined,
		advance = false,
	) {
		if (
			!known ||
			actual.metadata?.uid !== known.uid ||
			actual.metadata?.name !== known.name ||
			actual.metadata?.namespace !== desired.metadata?.namespace ||
			actual.metadata?.name !== desired.metadata?.name ||
			actual.metadata?.deletionTimestamp ||
			actual.metadata?.ownerReferences?.length ||
			!Object.entries(desired.metadata?.labels ?? {}).every(
				([key, value]) => actual.metadata?.labels?.[key] === value,
			) ||
			!Object.entries(desired.metadata?.annotations ?? {}).every(
				([key, value]) => {
					const previous = actual.metadata?.annotations?.[key];
					if (
						advance &&
						["fence", "config-revision", "workload-revision"].some(
							(field) => key === `${prefix}${field}`,
						)
					) {
						const number = Number(previous);
						return (
							Number.isSafeInteger(number) &&
							number > 0 &&
							String(number) === previous &&
							number <= Number(value)
						);
					}
					return previous === value;
				},
			)
		)
			throw new WorkloadKubernetesError("conflict");
		receipt(actual);
	}
	async function exclusive(desired: V1NetworkPolicy) {
		const labels = desired.spec?.podSelector?.matchLabels ?? {};
		// NetworkPolicies are additive. Conservatively reject another potentially
		// overlapping allow policy, including expression selectors. Empty denies are safe.
		const policies = await client.list<V1NetworkPolicy>("NetworkPolicy", "");
		if (
			policies.some(
				(policy) =>
					policy.metadata?.name !== desired.metadata?.name &&
					(policy.spec?.policyTypes?.includes("Egress") ??
						!!policy.spec?.egress?.length) &&
					!!policy.spec?.egress?.length &&
					// An expression may select this Sandbox even when its labels
					// look disjoint; reject it conservatively rather than allow
					// an unprovable additive egress policy.
					((policy.spec?.podSelector?.matchExpressions?.length ?? 0) > 0 ||
						!Object.entries(policy.spec?.podSelector?.matchLabels ?? {}).some(
							([key, value]) =>
								Object.hasOwn(labels, key) && labels[key] !== value,
						)),
			)
		)
			throw new WorkloadKubernetesError("policy");
	}
	async function write(
		value: SessionSandboxEgressBindingV1,
		known: SessionSandboxEgressReceiptV1 | undefined,
		revoked: boolean,
	) {
		const binding = structuredClone(value);
		return options.withCurrentAllocation(
			binding,
			revoked ? "revoke" : "apply",
			async () => {
				const desired = expected(binding, revoked);
				await exclusive(desired);
				const current = await client.read<V1NetworkPolicy>(
					"NetworkPolicy",
					desired.metadata.name,
				);
				if (current) owned(current, desired, known, true);
				else if (known) throw new WorkloadKubernetesError("conflict");
				assertValidBinding(binding); // Lease can expire during API reads.
				const applied = current
					? matchesNetworkPolicySpec(current.spec, desired.spec) &&
						Object.entries(desired.metadata?.annotations ?? {}).every(
							([key, value]) => current.metadata?.annotations?.[key] === value,
						)
						? current
						: await client.replace({
								...desired,
								metadata: {
									...desired.metadata,
									uid: current.metadata?.uid,
									resourceVersion: current.metadata?.resourceVersion,
								},
							})
					: await client.create(desired);
				const result = receipt(applied);
				const observed = await client.read<V1NetworkPolicy>(
					"NetworkPolicy",
					result.name,
				);
				if (!observed) throw new WorkloadKubernetesError("conflict");
				owned(observed, desired, result);
				if (!matchesNetworkPolicySpec(observed.spec, desired.spec))
					throw new WorkloadKubernetesError("conflict");
				await exclusive(desired);
				assertValidBinding(binding);
				return receipt(observed);
			},
		);
	}
	return {
		apply: (
			value: SessionSandboxEgressBindingV1,
			known?: SessionSandboxEgressReceiptV1,
		) => write(value, known, false),
		revoke: (
			value: SessionSandboxEgressBindingV1,
			known: SessionSandboxEgressReceiptV1,
		) => write(value, known, true),
		async observe(
			value: SessionSandboxEgressBindingV1,
			known: SessionSandboxEgressReceiptV1,
		) {
			const binding = structuredClone(value);
			return options.withCurrentAllocation(binding, "observe", async () => {
				const desired = expected(binding);
				const current = await client.read<V1NetworkPolicy>(
					"NetworkPolicy",
					desired.metadata.name,
				);
				if (!current) return false;
				owned(current, desired, known);
				await exclusive(desired);
				assertValidBinding(binding);
				return matchesNetworkPolicySpec(current.spec, desired.spec);
			});
		},
		async remove(
			value: SessionSandboxEgressBindingV1,
			known: SessionSandboxEgressReceiptV1,
		) {
			const binding = structuredClone(value);
			return options.withCurrentAllocation(binding, "remove", async () => {
				const desired = expected(binding, true);
				const current = await client.read<V1NetworkPolicy>(
					"NetworkPolicy",
					desired.metadata.name,
				);
				if (!current) return;
				owned(current, desired, known);
				// Never remove the last deny while any generation of this Sandbox has a Pod.
				if (
					(await client.list("Pod", `${prefix}sandbox-id=${binding.sandboxId}`))
						.length ||
					!matchesNetworkPolicySpec(current.spec, desired.spec)
				)
					throw new WorkloadKubernetesError("policy");
				assertValidBinding(binding);
				await client.delete(current); // Existing client uses UID/resourceVersion preconditions.
			});
		},
	};
}
