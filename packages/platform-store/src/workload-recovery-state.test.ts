import { describe, expect, it } from "vitest";
import { workloadDesiredFixture } from "../../../apps/platform-worker/src/kubernetes.fixture.js";
import { agentConfigurationConformanceRecordV1 } from "../../platform-core/src/agent-configuration.conformance.js";
import { decodePersistedWorkloadStateV1 } from "./workload-reconciliation.js";

function fixture() {
	const sourceReference = {
		schemaVersion: 1,
		ownerType: "agent-owner",
		ownerId: "owner-a",
		agentId: "agent_01",
		secretId: "secret_model_primary",
		secretVersion: 1,
		configRevision: 7,
		algorithmVersion: "aes-256-gcm:v1",
		wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
		wrappingKeyVersion: "key-a",
		name: "agent-a.secret-a-v1-r7",
	};
	const recovery = {
		sourceReference,
		sourceActivationFence: {
			schemaVersion: 1,
			agentId: "agent_01",
			secretId: sourceReference.secretId,
			secretVersion: 1,
			configRevision: 7,
			kubernetesSecretName: sourceReference.name,
			workloadUid: "old-workload",
			workloadGeneration: 3,
			fence: 2,
		},
		reference: { ...sourceReference, name: `${sourceReference.name}-w8-f4` },
		workloadRevision: 8,
		fence: 4,
		secretUid: "secret-uid",
		identity: { uid: "new-workload", generation: 1 },
	};
	const version = {
		configuration: structuredClone(agentConfigurationConformanceRecordV1),
		deployment: {
			...workloadDesiredFixture(7, "agent_01", "internal-only"),
			workloadRevision: 8,
			fence: 4,
			secretRefs: [recovery.reference],
		},
		secretRecoveries: [recovery],
	};
	return {
		schemaVersion: 1,
		agentId: "agent_01",
		sourceConfigurationRevision: 7,
		sourceLifecycleRevision: 4,
		revision: 8,
		fence: 4,
		phase: "ready",
		candidate: structuredClone(version),
		verified: structuredClone(version),
		verifiedRevision: 8,
		identity: { uid: "new-workload", generation: 1 },
		rollback: false,
		failureCode: null,
		attempts: 0,
	};
}

describe("persisted Workload recovery state", () => {
	it("round-trips the verified source and replacement identity across process reads", () => {
		const state = fixture();
		expect(
			decodePersistedWorkloadStateV1(
				JSON.parse(JSON.stringify(state)),
				"agent_01",
			),
		).toEqual({ state, legacy: false });
	});
	it("round-trips an intention before Secret or Workload creation without inventing a UID", () => {
		const original = fixture();
		const { secretRecoveries: _, ...verified } = original.verified;
		const state = {
			...original,
			phase: "applying",
			identity: null,
			verified: {
				...verified,
				deployment: {
					...verified.deployment,
					secretRefs: [original.candidate.secretRecoveries[0]?.sourceReference],
				},
			},
			candidate: {
				...original.candidate,
				secretRecoveries: original.candidate.secretRecoveries.map(
					(recovery) => ({ ...recovery, secretUid: null, identity: null }),
				),
			},
		};
		expect(
			decodePersistedWorkloadStateV1(
				JSON.parse(JSON.stringify(state)),
				"agent_01",
			),
		).toEqual({ state, legacy: false });
	});
	it.each([
		"foreign Agent",
		"origin mismatch",
		"target mismatch",
		"future fence",
		"future revision",
		"missing fence",
		"unknown field",
		"duplicate source",
		"UID without Secret receipt",
		"missing deployment mapping",
	])("rejects %s before reconciliation can consume it", (mutation) => {
		const state = fixture();
		const recovery = state.candidate.secretRecoveries[0];
		if (!recovery) throw new Error();
		if (mutation === "foreign Agent")
			recovery.sourceReference.agentId = "agent-other";
		if (mutation === "origin mismatch")
			recovery.sourceActivationFence.configRevision = 6;
		if (mutation === "target mismatch")
			recovery.reference.name = "arbitrary-secret";
		if (mutation === "future fence") state.fence = 3;
		if (mutation === "future revision") state.revision = 7;
		if (mutation === "missing fence") Reflect.deleteProperty(state, "fence");
		if (mutation === "unknown field")
			Object.assign(recovery, { trusted: true });
		if (mutation === "duplicate source")
			state.candidate.secretRecoveries.push(structuredClone(recovery));
		if (mutation === "UID without Secret receipt")
			Object.assign(recovery, { secretUid: null });
		if (mutation === "missing deployment mapping")
			state.candidate.deployment.secretRefs = [];
		expect(() => decodePersistedWorkloadStateV1(state, "agent_01")).toThrow();
	});
});
