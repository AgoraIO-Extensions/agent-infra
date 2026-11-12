#!/usr/bin/env node

import fs from "node:fs";

const gateFields = {
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

const approvalFields = ["ownerAccount", "approvalRole", "approvalRevision"];
const topLevelFields = [
	"sourceCommitOrImageDigest",
	"validFrom",
	"expiresAt",
	"rotationOrRevocationRef",
];
const sourceTupleFields = ["platformSourceCommit", "connectionSourceCommit"];
function isSecretShapedKey(key) {
	const normalized = key.replace(/[-_]/g, "").toLowerCase();
	return [
		"token",
		"accesstoken",
		"refreshtoken",
		"secret",
		"secretvalue",
		"cookie",
		"pat",
		"password",
		"privatekey",
		"consumersecret",
		"clientsecret",
		"apikey",
		"authorization",
		"bearertoken",
		"secretref",
	].includes(normalized);
}

function safeRequestId(value) {
	return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
		? value
		: "CONNECTION-851-PRODUCTION-INPUTS";
}

function addRequiredFields(value, path, fields, present, missing) {
	const section =
		path.split(".").reduce((current, key) => current?.[key], value) ?? {};
	for (const field of fields) {
		const key = `${path}.${field}`;
		if (typeof section[field] === "string" && section[field].length > 0)
			present.push(key);
		else missing.push(key);
	}
}

function findSecretShapedFields(value, path = "", result = []) {
	if (!value || typeof value !== "object") return result;
	for (const [key, child] of Object.entries(value)) {
		const current = path ? `${path}.${key}` : key;
		if (isSecretShapedKey(key)) result.push(current);
		findSecretShapedFields(child, current, result);
	}
	return result;
}

export function validateConnectionProductionInputsV1(
	value,
	{ expectedPlatformSource, expectedConnectionSource } = {},
) {
	const present = [];
	const missing = [];
	for (const [gate, fields] of Object.entries(gateFields))
		addRequiredFields(value, gate, fields, present, missing);
	for (const gate of Object.keys(gateFields))
		addRequiredFields(
			value,
			`approvals.${gate.slice(0, 2)}`,
			approvalFields,
			present,
			missing,
		);
	if (value?.schemaVersion === 1) present.push("schemaVersion");
	else missing.push("schemaVersion");
	for (const field of topLevelFields)
		if (typeof value?.[field] === "string" && value[field].length > 0)
			present.push(field);
		else missing.push(field);
	for (const field of sourceTupleFields)
		if (
			typeof value?.sourceTuple?.[field] === "string" &&
			value.sourceTuple[field].length > 0
		)
			present.push(`sourceTuple.${field}`);
		else missing.push(`sourceTuple.${field}`);

	const secretShapedFields = findSecretShapedFields(value);
	const staleSourceTuple = [];
	if (
		typeof expectedPlatformSource !== "string" ||
		expectedPlatformSource.length === 0 ||
		value?.sourceTuple?.platformSourceCommit !== expectedPlatformSource
	)
		staleSourceTuple.push("sourceTuple.platformSourceCommit");
	if (
		typeof expectedConnectionSource !== "string" ||
		expectedConnectionSource.length === 0 ||
		value?.sourceTuple?.connectionSourceCommit !== expectedConnectionSource
	)
		staleSourceTuple.push("sourceTuple.connectionSourceCommit");

	return {
		schemaVersion: 1,
		status: secretShapedFields.length
			? "REJECT_SECRET_SHAPED_INPUT"
			: staleSourceTuple.length
				? "REJECT_STALE_SOURCE_TUPLE"
				: missing.length
					? "BLOCKED_MISSING_NONSECRET_INPUTS"
					: "READY_FOR_OWNER_APPROVAL_REVIEW",
		requestId: safeRequestId(value?.requestId),
		presentNonSecretFields: present,
		missingNonSecretFields: missing,
		secretShapedFields,
		staleSourceTuple,
		noRuntimeAction: true,
		noSecretRead: true,
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const inputPath = process.argv[2];
	const expectedPlatformSource = process.argv[3];
	const expectedConnectionSource = process.argv[4];
	if (
		!inputPath ||
		typeof expectedPlatformSource !== "string" ||
		expectedPlatformSource.length === 0 ||
		typeof expectedConnectionSource !== "string" ||
		expectedConnectionSource.length === 0
	) {
		console.error(
			"usage: validate-connection-production-inputs.mjs <packet.json> <platformSourceCommit> <connectionSourceCommit>",
		);
		process.exit(2);
	}
	const value = JSON.parse(fs.readFileSync(inputPath, "utf8"));
	const result = validateConnectionProductionInputsV1(value, {
		expectedPlatformSource,
		expectedConnectionSource,
	});
	console.log(JSON.stringify(result, null, 2));
	process.exitCode =
		result.status === "READY_FOR_OWNER_APPROVAL_REVIEW" ? 0 : 1;
}
