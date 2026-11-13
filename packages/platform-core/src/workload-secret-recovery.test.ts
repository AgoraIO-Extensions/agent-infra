import { describe, expect, it } from "vitest";
import type { AgentConfigurationRecordV2 } from "./agent-configuration.js";
import type { AgentManagementStateV1 } from "./agent-management.js";
import type {
	WorkloadPreparationV1,
	WorkloadReconciliationStateV1,
} from "./workload-reconciliation.js";
import {
	hasUnverifiedWorkloadSecretRecoveryV1,
	syncVerifiedWorkloadSecretUidReceiptsV1,
	type WorkloadSecretRecoveryV1,
} from "./workload-secret-recovery.js";

const sourceReference = {
	schemaVersion: 1 as const,
	ownerType: "agent-owner" as const,
	ownerId: "owner-a",
	agentId: "agent-a",
	secretId: "secret-a",
	secretVersion: 1,
	configRevision: 1,
	algorithmVersion: "aes-256-gcm:v1" as const,
	wrappingAlgorithmVersion: "rsa-oaep-sha256:v1" as const,
	wrappingKeyVersion: "key-a",
	name: "source-v1-r1",
};
const recovery: WorkloadSecretRecoveryV1 = {
	sourceReference,
	sourceActivationFence: {
		schemaVersion: 1,
		agentId: "agent-a",
		secretId: "secret-a",
		secretVersion: 1,
		configRevision: 1,
		kubernetesSecretName: sourceReference.name,
		workloadUid: "original-workload",
		workloadGeneration: 1,
		fence: 1,
	},
	reference: { ...sourceReference, name: `${sourceReference.name}-w2-f4` },
	workloadRevision: 2,
	fence: 4,
	secretUid: "secret-uid",
	identity: { uid: "workload-uid", generation: 1 },
};

function receiptFixture() {
	const configuration: AgentConfigurationRecordV2 = {
		schemaVersion: 2,
		agentId: "agent-a",
		revision: 1,
		channels: [],
		channelRevision: "channels-a",
		environment: [],
		secrets: [
			{ name: "API_KEY", secretId: "secret-a", version: 1, isSet: true },
		],
		modelConfiguration: null,
		source: {
			kind: "custom",
			imageDigest: `sha256:${"a".repeat(64)}`,
			admissionRevision: "admission-a",
			interactionMode: "platform-adapter",
			connectionEnabled: false,
		},
	};
	const verified = {
		configuration,
		deployment: { behaviour: "verified" },
		secretRecoveries: [recovery],
	};
	const candidate = {
		configuration: {
			...configuration,
			revision: 2,
			environment: [{ name: "NEW", value: "candidate" }],
		},
		deployment: { behaviour: "unverified" },
		secretRecoveries: [recovery],
	};
	const state: WorkloadReconciliationStateV1 = {
		schemaVersion: 1,
		agentId: "agent-a",
		sourceConfigurationRevision: 2,
		sourceLifecycleRevision: 2,
		revision: 3,
		fence: 4,
		phase: "applying",
		candidate,
		verified,
		verifiedRevision: 2,
		identity: recovery.identity,
		rollback: false,
		failureCode: null,
		attempts: 0,
	};
	const management: AgentManagementStateV1 = {
		schemaVersion: 1,
		agentId: "agent-a",
		applicationId: "application-a",
		applicantId: "owner-a",
		ownerIds: ["owner-a"],
		availability: [],
		decisionReason: null,
		revision: 3,
		workloadRevision: 2,
		fence: 4,
		status: "available",
		desiredState: "running",
		serviceAvailability: "updating",
		approvalRevision: 1,
		failureCode: null,
	};
	const prepared: WorkloadPreparationV1 = {
		status: "prepared",
		candidate: {
			...candidate,
			secretRecoveries: [{ ...recovery, secretUid: "repaired-uid" }],
		},
		identity: state.identity,
	};
	return { state, management, prepared };
}

describe("Workload Secret recovery verification", () => {
	it("requires every recovery field to match the verified record", () => {
		expect(
			hasUnverifiedWorkloadSecretRecoveryV1(
				{ secretRecoveries: [recovery] },
				{ secretRecoveries: [structuredClone(recovery)] },
			),
		).toBe(false);
		for (const patch of [
			{ fence: recovery.fence + 1 },
			{ secretUid: "different-secret" },
			{
				identity: {
					uid: (recovery.identity as { uid: string }).uid,
					generation: 2,
				},
			},
		]) {
			expect(
				hasUnverifiedWorkloadSecretRecoveryV1(
					{ secretRecoveries: [{ ...recovery, ...patch }] },
					{ secretRecoveries: [recovery] },
				),
			).toBe(true);
		}
	});
	it("syncs only the verified UID receipt without promoting the candidate configuration or deployment", () => {
		const f = receiptFixture();
		expect(
			hasUnverifiedWorkloadSecretRecoveryV1(
				f.prepared.candidate,
				f.state.verified,
			),
		).toBe(true);
		const result = syncVerifiedWorkloadSecretUidReceiptsV1(
			f.state,
			f.prepared,
			f.management,
		);
		expect(result).toEqual({
			...f.state.verified,
			secretRecoveries: [{ ...recovery, secretUid: "repaired-uid" }],
		});
		expect(result?.configuration).toBe(f.state.verified?.configuration);
		expect(result?.deployment).toBe(f.state.verified?.deployment);
		expect(f.state.verified?.secretRecoveries?.[0]?.secretUid).toBe(
			"secret-uid",
		);
		expect(
			hasUnverifiedWorkloadSecretRecoveryV1(f.prepared.candidate, result),
		).toBe(false);
	});
	it("does not sync a changed source, creation, reference or Workload identity", () => {
		const f = receiptFixture();
		const next = f.prepared.candidate.secretRecoveries?.[0];
		if (!next) throw new Error();
		const mutations: WorkloadSecretRecoveryV1[] = [
			{
				...next,
				sourceActivationFence: { ...next.sourceActivationFence, fence: 2 },
			},
			{
				...next,
				sourceReference: { ...next.sourceReference, ownerId: "other-owner" },
				reference: { ...next.reference, ownerId: "other-owner" },
			},
			{
				...next,
				sourceReference: {
					...next.sourceReference,
					wrappingKeyVersion: "other-key",
				},
				reference: { ...next.reference, wrappingKeyVersion: "other-key" },
			},
			{
				...next,
				workloadRevision: 3,
				reference: { ...next.reference, name: `${sourceReference.name}-w3-f4` },
			},
			{
				...next,
				fence: 3,
				reference: { ...next.reference, name: `${sourceReference.name}-w2-f3` },
			},
			{ ...next, identity: { uid: "other-workload", generation: 1 } },
			{ ...next, identity: { uid: "workload-uid", generation: 2 } },
		];
		for (const value of mutations) {
			const prepared = {
				...f.prepared,
				candidate: { ...f.prepared.candidate, secretRecoveries: [value] },
			};
			expect(
				syncVerifiedWorkloadSecretUidReceiptsV1(
					f.state,
					prepared,
					f.management,
				),
			).toBe(f.state.verified);
		}
	});
	it("requires the same current owner, Agent, management fence and observed identity", () => {
		const f = receiptFixture();
		for (const management of [
			{ ...f.management, ownerIds: ["other-owner"] },
			{ ...f.management, agentId: "other-agent" },
			{ ...f.management, fence: 5 },
			{ ...f.management, workloadRevision: 3 },
			{ ...f.management, desiredState: "stopped" as const },
			{ ...f.management, status: "disabled" as const },
		])
			expect(
				syncVerifiedWorkloadSecretUidReceiptsV1(
					f.state,
					f.prepared,
					management,
				),
			).toBe(f.state.verified);
		for (const identity of [
			{ uid: "other-workload", generation: 1 },
			{ uid: "workload-uid", generation: 2 },
			null,
		])
			expect(
				syncVerifiedWorkloadSecretUidReceiptsV1(
					f.state,
					{ ...f.prepared, identity },
					f.management,
				),
			).toBe(f.state.verified);
	});
});
