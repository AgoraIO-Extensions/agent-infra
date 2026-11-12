import assert from "node:assert/strict";
import test from "node:test";
import { validateConnectionProductionInputsV1 } from "../scripts/validate-connection-production-inputs.mjs";

const sourceTuple = {
	platformSourceCommit: "adbe87dc76fc9d46c55b09c6ca30ce87aaeb4a74",
	connectionSourceCommit: "ee14d300d5cc40b201575b93f9decd50489f4803",
};
const fields = {
	D1_machineAuthority: [
		"bundleRef",
		"bundleRevision",
		"machineIssuerRef",
		"machineAudience",
		"machineScope",
		"sourceNamespace",
		"policyRevision",
		"trustRevision",
		"expiryOrRotationRef",
	],
	D2_ownerResolution: [
		"ownerResolverRef",
		"ownerResolverRevision",
		"mappingSourceRef",
		"mappingRevision",
		"principalActivePolicyRef",
		"ambiguityAndChangePolicyRef",
	],
	D3_protectedSupply: [
		"protectedSinkRef",
		"protectedSinkRevision",
		"receiverOwner",
		"receiverWorkloadRef",
		"placementRef",
		"publishAuthRef",
		"inspectAuthRef",
		"rotationRevocationPolicyRef",
	],
	D4_capabilityLifecycle: [
		"declarationRef",
		"declarationRevision",
		"actionVersionSubsetRef",
		"lifecycleContractRef",
		"recoveryExecutorRef",
		"recoveryRevision",
		"fenceLeaseRef",
		"negativeMatrixRef",
	],
};

function completePacket() {
	const packet = {
		schemaVersion: 1,
		requestId: "CONNECTION-851-PRODUCTION-INPUTS",
		sourceCommitOrImageDigest: "sha256:synthetic",
		validFrom: "2026-01-01T00:00:00Z",
		expiresAt: "2027-01-01T00:00:00Z",
		rotationOrRevocationRef: "ref://rotation",
		sourceTuple: { ...sourceTuple },
		approvals: {},
	};
	for (const [gate, names] of Object.entries(fields)) {
		packet[gate] = Object.fromEntries(
			names.map((name) => [name, `ref://synthetic/${name}`]),
		);
		packet.approvals[gate.slice(0, 2)] = {
			ownerAccount: "owner@example.test",
			approvalRole: gate,
			approvalRevision: "approval-r1",
		};
	}
	return packet;
}

test("accepts a complete source-bound non-secret approval packet", () => {
	assert.equal(
		validateConnectionProductionInputsV1(completePacket(), {
			expectedPlatformSource: sourceTuple.platformSourceCommit,
			expectedConnectionSource: sourceTuple.connectionSourceCommit,
		}).status,
		"READY_FOR_OWNER_APPROVAL_REVIEW",
	);
});

test("rejects a stale source tuple", () => {
	const packet = completePacket();
	packet.sourceTuple.connectionSourceCommit = "old-connection-source";
	const result = validateConnectionProductionInputsV1(packet, {
		expectedPlatformSource: sourceTuple.platformSourceCommit,
		expectedConnectionSource: sourceTuple.connectionSourceCommit,
	});
	assert.equal(result.status, "REJECT_STALE_SOURCE_TUPLE");
	assert.deepEqual(result.staleSourceTuple, [
		"sourceTuple.connectionSourceCommit",
	]);
});

test("rejects secret-shaped fields without revealing their values", () => {
	const packet = completePacket();
	packet.D3_protectedSupply.token = "synthetic-token-value";
	const result = validateConnectionProductionInputsV1(packet, {
		expectedPlatformSource: sourceTuple.platformSourceCommit,
		expectedConnectionSource: sourceTuple.connectionSourceCommit,
	});
	assert.equal(result.status, "REJECT_SECRET_SHAPED_INPUT");
	assert.deepEqual(result.secretShapedFields, ["D3_protectedSupply.token"]);
	assert.equal(JSON.stringify(result).includes("synthetic-token-value"), false);
});

test("requires every approval identity and revision", () => {
	const packet = completePacket();
	delete packet.approvals.D4.approvalRevision;
	const result = validateConnectionProductionInputsV1(packet, sourceTuple);
	assert.equal(result.status, "BLOCKED_MISSING_NONSECRET_INPUTS");
	assert.ok(
		result.missingNonSecretFields.includes("approvals.D4.approvalRevision"),
	);
});

test("does not treat legacy packet source fields as current tuple", () => {
	const packet = completePacket();
	delete packet.sourceTuple;
	packet.platformSourceCommit = sourceTuple.platformSourceCommit;
	packet.connectionSourceCommit = sourceTuple.connectionSourceCommit;
	const result = validateConnectionProductionInputsV1(packet, sourceTuple);
	assert.equal(result.status, "BLOCKED_MISSING_NONSECRET_INPUTS");
	assert.ok(
		result.missingNonSecretFields.includes("sourceTuple.platformSourceCommit"),
	);
});
