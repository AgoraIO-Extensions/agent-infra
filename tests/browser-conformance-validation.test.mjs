import assert from "node:assert/strict";
import test from "node:test";

import {
	browserConformanceChecks,
	browserConformanceTemplates,
	sameBrowserConformanceTuple,
	validateBrowserConformanceReceipt,
} from "./local-real-e2e/browser-conformance-validation.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const hash = "b".repeat(64);
const template = (name) => ({
	template: name,
	agentHash: hash,
	sessionHash: "c".repeat(64),
	executionHash: "d".repeat(64),
	imageDigest: digest,
	chromiumVersion: "140.0.7339.0",
	playwrightVersion: "1.55.0",
	capabilityRevision: 7,
	checks: Object.fromEntries(
		browserConformanceChecks.map((check) => [
			check,
			{ status: "passed", evidenceHash: hash },
		]),
	),
});
const receipt = () => ({
	schemaVersion: 1,
	classification: "browser-m1-conformance",
	commit: "e".repeat(40),
	deployment: {
		imageDigest: digest,
		chromiumVersion: "140.0.7339.0",
		playwrightVersion: "1.55.0",
		capabilityRevision: 7,
	},
	templates: browserConformanceTemplates.map(template),
});

test("accepts a complete four-template receipt and returns bounded evidence", () => {
	const result = validateBrowserConformanceReceipt(receipt());
	assert.equal(result.status, "passed");
	assert.equal(result.templates.length, 4);
	assert.equal(result.templates[0].checks.navigation, hash);
	assert.equal(Object.hasOwn(result.templates[0], "sessionId"), false);
});

test("rejects missing, duplicate and unknown template entries", () => {
	for (const templates of [
		receipt().templates.slice(0, 3),
		[...receipt().templates.slice(0, 3), template("codex")],
		receipt().templates.slice(0, 3).concat(template("invalid")),
	]) {
		const result = validateBrowserConformanceReceipt({
			...receipt(),
			templates,
		});
		assert.equal(result.status, "rejected");
	}
});

test("rejects tuple drift, unknown results and malformed evidence", () => {
	const drift = receipt();
	drift.templates[1].imageDigest = `sha256:${"f".repeat(64)}`;
	assert.equal(validateBrowserConformanceReceipt(drift).status, "rejected");
	const unknown = receipt();
	unknown.templates[2].checks.recovery = {
		status: "unknown",
		evidenceHash: hash,
	};
	assert.equal(validateBrowserConformanceReceipt(unknown).status, "rejected");
	const malformed = receipt();
	malformed.templates[3].checks.securityNegative = {
		status: "passed",
		evidenceHash: "secret",
	};
	assert.equal(validateBrowserConformanceReceipt(malformed).status, "rejected");
});

test("rejects sensitive or unbounded receipt fields", () => {
	const sensitive = receipt();
	sensitive.templates[0].pageBody = "private content";
	assert.equal(validateBrowserConformanceReceipt(sensitive).status, "rejected");
	const rootSensitive = receipt();
	rootSensitive.cookies = "session=secret";
	assert.equal(
		validateBrowserConformanceReceipt(rootSensitive).status,
		"rejected",
	);
	const deploymentSensitive = receipt();
	deploymentSensitive.deployment.token = "secret";
	assert.equal(
		validateBrowserConformanceReceipt(deploymentSensitive).status,
		"rejected",
	);
	const checkSensitive = receipt();
	checkSensitive.templates[0].checks.navigation.pageBody = "private content";
	assert.equal(
		validateBrowserConformanceReceipt(checkSensitive).status,
		"rejected",
	);
	const badCheck = receipt();
	badCheck.templates[0].checks.extra = { status: "passed", evidenceHash: hash };
	assert.equal(validateBrowserConformanceReceipt(badCheck).status, "rejected");
});

test("rejects URL-shaped and token-shaped version values", () => {
	for (const field of ["chromiumVersion", "playwrightVersion"]) {
		const invalid = receipt();
		invalid.deployment[field] = "https://example.test/?token=secret";
		for (const template of invalid.templates)
			template[field] = invalid.deployment[field];
		assert.equal(validateBrowserConformanceReceipt(invalid).status, "rejected");
	}
});

test("preserves only validated evidence hashes in rejection diagnostics", () => {
	const unknown = receipt();
	unknown.templates[0].checks.recovery = {
		status: "unknown",
		evidenceHash: hash,
	};
	unknown.templates[1].checks.recovery = {
		status: "credential=secret",
		evidenceHash: "token=secret",
	};
	const result = validateBrowserConformanceReceipt(unknown);
	assert.equal(result.status, "rejected");
	assert.equal(result.evidence["templates[0].recovery"], hash);
	assert.equal(Object.values(result.evidence).includes("token=secret"), false);
});

test("compares only the deployment tuple", () => {
	assert.equal(sameBrowserConformanceTuple(receipt(), receipt()), true);
	const other = receipt();
	other.deployment.capabilityRevision = 8;
	assert.equal(sameBrowserConformanceTuple(receipt(), other), false);
});
