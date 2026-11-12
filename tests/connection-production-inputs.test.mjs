import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

test("rejects a packet when source expectations are omitted", () => {
	const result = validateConnectionProductionInputsV1(completePacket());
	assert.equal(result.status, "REJECT_STALE_SOURCE_TUPLE");
	assert.deepEqual(result.staleSourceTuple, [
		"sourceTuple.platformSourceCommit",
		"sourceTuple.connectionSourceCommit",
	]);
});

test("rejects a packet when either source expectation is empty", () => {
	const result = validateConnectionProductionInputsV1(completePacket(), {
		expectedPlatformSource: sourceTuple.platformSourceCommit,
		expectedConnectionSource: "",
	});
	assert.equal(result.status, "REJECT_STALE_SOURCE_TUPLE");
	assert.deepEqual(result.staleSourceTuple, [
		"sourceTuple.connectionSourceCommit",
	]);
});

test("rejects arbitrary, malformed, or untrimmed source expectations", () => {
	for (const [field, expectedValue] of [
		["expectedPlatformSource", "synthetic-platform-source"],
		["expectedConnectionSource", "synthetic-connection-source"],
		["expectedPlatformSource", `${sourceTuple.platformSourceCommit} `],
		["expectedConnectionSource", ` ${sourceTuple.connectionSourceCommit}`],
		["expectedPlatformSource", "z".repeat(40)],
		["expectedConnectionSource", "1".repeat(39)],
	]) {
		const result = validateConnectionProductionInputsV1(completePacket(), {
			expectedPlatformSource: sourceTuple.platformSourceCommit,
			expectedConnectionSource: sourceTuple.connectionSourceCommit,
			[field]: expectedValue,
		});
		assert.equal(result.status, "REJECT_STALE_SOURCE_TUPLE", field);
		assert.ok(
			result.staleSourceTuple.includes(
				field === "expectedPlatformSource"
					? "sourceTuple.platformSourceCommit"
					: "sourceTuple.connectionSourceCommit",
			),
		);
	}
});

test("requires both source expectations in the CLI", () => {
	const script = fileURLToPath(
		new URL(
			"../scripts/validate-connection-production-inputs.mjs",
			import.meta.url,
		),
	);
	const result = spawnSync(process.execPath, [script, "packet.json"], {
		encoding: "utf8",
	});
	assert.equal(result.status, 2);
	assert.match(
		result.stderr,
		/<platformSourceCommit> <connectionSourceCommit>/,
	);
});

test("rejects malformed source expectations in the CLI", () => {
	const script = fileURLToPath(
		new URL(
			"../scripts/validate-connection-production-inputs.mjs",
			import.meta.url,
		),
	);
	const result = spawnSync(
		process.execPath,
		[
			script,
			"packet.json",
			sourceTuple.platformSourceCommit,
			"synthetic-connection-source",
		],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 2);
	assert.match(
		result.stderr,
		/<platformSourceCommit> <connectionSourceCommit>/,
	);
});

test("requires schema version 1", () => {
	for (const schemaVersion of [undefined, 0, 2, "1"]) {
		const packet = completePacket();
		if (schemaVersion === undefined) delete packet.schemaVersion;
		else packet.schemaVersion = schemaVersion;
		const result = validateConnectionProductionInputsV1(packet, {
			expectedPlatformSource: sourceTuple.platformSourceCommit,
			expectedConnectionSource: sourceTuple.connectionSourceCommit,
		});
		assert.equal(result.status, "BLOCKED_MISSING_NONSECRET_INPUTS");
		assert.ok(result.missingNonSecretFields.includes("schemaVersion"));
	}
});

test("rejects secret-shaped fields without revealing their values", () => {
	const packet = completePacket();
	packet.D3_protectedSupply.client_secret = "synthetic-secret-value";
	const result = validateConnectionProductionInputsV1(packet, {
		expectedPlatformSource: sourceTuple.platformSourceCommit,
		expectedConnectionSource: sourceTuple.connectionSourceCommit,
	});
	assert.equal(result.status, "REJECT_SECRET_SHAPED_INPUT");
	assert.deepEqual(result.secretShapedFields, [
		"D3_protectedSupply.client_secret",
	]);
	assert.equal(
		JSON.stringify(result).includes("synthetic-secret-value"),
		false,
	);
});

test("rejects common auth-key spellings without printing values", () => {
	for (const key of [
		"apiKey",
		"api_key",
		"authorization",
		"bearerToken",
		"secretRef",
	]) {
		const packet = completePacket();
		packet.D1_machineAuthority[key] = "synthetic-secret-value";
		const result = validateConnectionProductionInputsV1(packet, {
			expectedPlatformSource: sourceTuple.platformSourceCommit,
			expectedConnectionSource: sourceTuple.connectionSourceCommit,
		});
		assert.equal(result.status, "REJECT_SECRET_SHAPED_INPUT", key);
		assert.deepEqual(result.secretShapedFields, [`D1_machineAuthority.${key}`]);
		assert.equal(
			JSON.stringify(result).includes("synthetic-secret-value"),
			false,
		);
	}
});

test("does not echo an unsafe request id", () => {
	const packet = completePacket();
	packet.requestId = "Bearer synthetic-secret-value";
	const result = validateConnectionProductionInputsV1(packet, {
		expectedPlatformSource: sourceTuple.platformSourceCommit,
		expectedConnectionSource: sourceTuple.connectionSourceCommit,
	});
	assert.equal(result.requestId, "CONNECTION-851-PRODUCTION-INPUTS");
	assert.equal(
		JSON.stringify(result).includes("synthetic-secret-value"),
		false,
	);
});

test("requires every approval identity and revision", () => {
	const packet = completePacket();
	delete packet.approvals.D4.approvalRevision;
	const result = validateConnectionProductionInputsV1(packet, {
		expectedPlatformSource: sourceTuple.platformSourceCommit,
		expectedConnectionSource: sourceTuple.connectionSourceCommit,
	});
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
	const result = validateConnectionProductionInputsV1(packet, {
		expectedPlatformSource: sourceTuple.platformSourceCommit,
		expectedConnectionSource: sourceTuple.connectionSourceCommit,
	});
	assert.equal(result.status, "REJECT_STALE_SOURCE_TUPLE");
	assert.ok(
		result.missingNonSecretFields.includes("sourceTuple.platformSourceCommit"),
	);
});
