import { isDeepStrictEqual } from "node:util";
import type { AgentManagementStateV1 } from "./agent-management.js";
import type {
	SecretActivationFenceV1,
	SecretActivationLifecycleStateV1,
	SecretActivationReferenceV1,
} from "./secret-activation.js";
import type { WorkloadReconciliationStateV1 } from "./workload-reconciliation.js";

/** A Workload-owned materialization; the source Secret's activation never changes. */
export interface WorkloadSecretRecoveryV1 {
	readonly sourceReference: SecretActivationReferenceV1;
	readonly sourceActivationFence: SecretActivationFenceV1;
	readonly reference: SecretActivationReferenceV1;
	readonly workloadRevision: number;
	readonly fence: number;
	readonly secretUid: string | null;
	readonly identity: {
		readonly uid: string;
		readonly generation: number;
	} | null;
}

function object(
	input: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new Error("Invalid Workload Secret recovery");
	const value = input as Record<string, unknown>;
	if (
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		throw new Error("Invalid Workload Secret recovery");
	return value;
}

function text(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 1024 &&
		!value.includes("\0") &&
		value.isWellFormed()
	);
}

function positive(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function reference(input: unknown): SecretActivationReferenceV1 {
	const value = object(input, [
		"schemaVersion",
		"ownerType",
		"ownerId",
		"agentId",
		"secretId",
		"secretVersion",
		"configRevision",
		"algorithmVersion",
		"wrappingAlgorithmVersion",
		"wrappingKeyVersion",
		"name",
	]);
	if (
		value.schemaVersion !== 1 ||
		!["agent-owner", "platform"].includes(String(value.ownerType)) ||
		![
			value.ownerId,
			value.agentId,
			value.secretId,
			value.wrappingKeyVersion,
		].every(text) ||
		!positive(value.secretVersion) ||
		!positive(value.configRevision) ||
		value.algorithmVersion !== "aes-256-gcm:v1" ||
		value.wrappingAlgorithmVersion !== "rsa-oaep-sha256:v1" ||
		typeof value.name !== "string" ||
		!/^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/.test(value.name)
	)
		throw new Error("Invalid Workload Secret recovery");
	return value as unknown as SecretActivationReferenceV1;
}

function workloadRecoverySecretNameV1(
	source: SecretActivationReferenceV1,
	revision: number,
	fence: number,
): string {
	if (!positive(revision) || !positive(fence))
		throw new Error("Invalid Workload Secret recovery");
	const name = `${source.name}-w${revision}-f${fence}`;
	if (name.length > 253) throw new Error("Invalid Workload Secret recovery");
	return name;
}

export function parseWorkloadSecretRecoveriesV1(
	input: unknown,
	agentId: string,
): readonly WorkloadSecretRecoveryV1[] {
	if (!Array.isArray(input) || input.length === 0)
		throw new Error("Invalid Workload Secret recovery");
	const names = new Set<string>();
	return input.map((item) => {
		const value = object(item, [
			"sourceReference",
			"sourceActivationFence",
			"reference",
			"workloadRevision",
			"fence",
			"secretUid",
			"identity",
		]);
		const sourceReference = reference(value.sourceReference);
		const target = reference(value.reference);
		const activation = object(value.sourceActivationFence, [
			"schemaVersion",
			"agentId",
			"secretId",
			"secretVersion",
			"configRevision",
			"kubernetesSecretName",
			"workloadUid",
			"workloadGeneration",
			"fence",
		]);
		if (
			sourceReference.agentId !== agentId ||
			!positive(value.workloadRevision) ||
			!positive(value.fence) ||
			activation.schemaVersion !== 1 ||
			activation.agentId !== agentId ||
			activation.secretId !== sourceReference.secretId ||
			activation.secretVersion !== sourceReference.secretVersion ||
			activation.configRevision !== sourceReference.configRevision ||
			activation.kubernetesSecretName !== sourceReference.name ||
			!text(activation.workloadUid) ||
			!positive(activation.workloadGeneration) ||
			!positive(activation.fence) ||
			!isDeepStrictEqual(target, {
				...sourceReference,
				name: workloadRecoverySecretNameV1(
					sourceReference,
					value.workloadRevision,
					value.fence,
				),
			}) ||
			(value.secretUid !== null && !text(value.secretUid))
		)
			throw new Error("Invalid Workload Secret recovery");
		if (value.identity !== null) {
			const identity = object(value.identity, ["uid", "generation"]);
			if (
				!text(identity.uid) ||
				!positive(identity.generation) ||
				value.secretUid === null
			)
				throw new Error("Invalid Workload Secret recovery");
		}
		if (names.has(target.name) || names.has(sourceReference.name))
			throw new Error("Invalid Workload Secret recovery");
		names.add(target.name);
		names.add(sourceReference.name);
		return structuredClone(value) as unknown as WorkloadSecretRecoveryV1;
	});
}

export function hasUnverifiedWorkloadSecretRecoveryV1(
	version: { readonly secretRecoveries?: readonly WorkloadSecretRecoveryV1[] },
	verified: {
		readonly secretRecoveries?: readonly WorkloadSecretRecoveryV1[];
	} | null,
): boolean {
	return (version.secretRecoveries ?? []).some(
		(candidate) =>
			!(verified?.secretRecoveries ?? []).some(
				(previous) =>
					isDeepStrictEqual(previous.reference, candidate.reference) &&
					previous.identity?.uid === candidate.identity?.uid,
			),
	);
}

/** Validated Store binding metadata; contains no encrypted or plaintext value. */
export interface WorkloadSecretRecoverySourceV1 {
	readonly reference: SecretActivationReferenceV1;
	readonly lifecycleState: SecretActivationLifecycleStateV1;
	readonly activationFence: SecretActivationFenceV1 | null;
}

export function workloadSecretRecoveriesV1(
	state: WorkloadReconciliationStateV1,
): readonly WorkloadSecretRecoveryV1[] {
	if (state.candidate.secretRecoveries === undefined) return [];
	const values = parseWorkloadSecretRecoveriesV1(
		state.candidate.secretRecoveries,
		state.agentId,
	);
	if (
		values.some(
			(value) =>
				value.workloadRevision > state.revision ||
				value.fence > state.fence ||
				value.reference.configRevision > state.candidate.configuration.revision,
		)
	)
		throw new Error("Workload Secret recovery is stale");
	return values;
}

export function validateWorkloadSecretRecoverySourcesV1(
	state: WorkloadReconciliationStateV1,
	management: AgentManagementStateV1,
	sources: readonly WorkloadSecretRecoverySourceV1[],
): void {
	for (const recovery of workloadSecretRecoveriesV1(state)) {
		const source = sources.find((value) =>
			isDeepStrictEqual(value.reference, recovery.sourceReference),
		);
		if (
			source?.lifecycleState !== "active" ||
			!isDeepStrictEqual(
				source.activationFence,
				recovery.sourceActivationFence,
			) ||
			!management.ownerIds.includes(source.reference.ownerId)
		)
			throw new Error("Workload Secret recovery source is unavailable");
	}
}

function verifiedRecoveries(state: WorkloadReconciliationStateV1) {
	return state.verified?.secretRecoveries === undefined
		? []
		: parseWorkloadSecretRecoveriesV1(
				state.verified.secretRecoveries,
				state.agentId,
			);
}

function sourceMatches(
	source: WorkloadSecretRecoverySourceV1,
	recovery: WorkloadSecretRecoveryV1,
) {
	return (
		source.lifecycleState === "active" &&
		isDeepStrictEqual(source.reference, recovery.sourceReference) &&
		isDeepStrictEqual(source.activationFence, recovery.sourceActivationFence)
	);
}

export function inheritWorkloadSecretRecoveriesV1(
	state: WorkloadReconciliationStateV1,
	sources: readonly WorkloadSecretRecoverySourceV1[],
): readonly WorkloadSecretRecoveryV1[] {
	const verified = verifiedRecoveries(state);
	for (const recovery of verified) {
		const current = sources.find(
			(source) =>
				source.reference.secretId === recovery.sourceReference.secretId &&
				source.reference.secretVersion ===
					recovery.sourceReference.secretVersion,
		);
		if (current && !sourceMatches(current, recovery))
			throw new Error("Verified Workload Secret source changed");
	}
	return verified.filter((recovery) =>
		sources.some((source) => sourceMatches(source, recovery)),
	);
}

/** Called under the Agent lock, before the Runtime persists or materializes the plan. */
export function planMissingWorkloadSecretRecoveryV1(
	state: WorkloadReconciliationStateV1,
	management: AgentManagementStateV1,
	sources: readonly WorkloadSecretRecoverySourceV1[],
): readonly WorkloadSecretRecoveryV1[] | null {
	if (
		!state.verified ||
		hasUnverifiedWorkloadSecretRecoveryV1(state.candidate, state.verified)
	)
		return null;
	const active = sources.filter((source) => source.lifecycleState === "active");
	if (!active.length) return null;
	if (
		management.agentId !== state.agentId ||
		management.fence !== state.fence ||
		management.desiredState !== "running" ||
		management.status === "disabled"
	)
		throw new Error("Workload recovery is not authorized");
	const deployment = state.verified.deployment;
	if (
		!deployment ||
		typeof deployment !== "object" ||
		!("secretRefs" in deployment) ||
		!Array.isArray(deployment.secretRefs)
	)
		throw new Error("Verified Workload Secret source is unavailable");
	const verifiedReferences = deployment.secretRefs.map(reference);
	const verified = verifiedRecoveries(state);
	return active.map((source): WorkloadSecretRecoveryV1 => {
		const sourceReference = source.reference;
		const sourceActivationFence = source.activationFence;
		const inherited = verified.find((value) => sourceMatches(source, value));
		if (
			!sourceActivationFence ||
			sourceReference.agentId !== state.agentId ||
			sourceReference.configRevision > state.candidate.configuration.revision ||
			sourceReference.ownerType !== "agent-owner" ||
			!management.ownerIds.includes(sourceReference.ownerId) ||
			!verifiedReferences.some((value) =>
				isDeepStrictEqual(value, inherited?.reference ?? sourceReference),
			)
		)
			throw new Error("Verified Workload Secret source is unavailable");
		return {
			sourceReference,
			sourceActivationFence,
			reference: {
				...sourceReference,
				name: workloadRecoverySecretNameV1(
					sourceReference,
					state.revision,
					state.fence,
				),
			},
			workloadRevision: state.revision,
			fence: state.fence,
			secretUid: null,
			identity: null,
		};
	});
}
