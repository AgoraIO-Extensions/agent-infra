import assert from "node:assert/strict";
import test from "node:test";

import {
	ackFourTemplateChecks,
	validateAckFourTemplateEvidence,
} from "../deploy/ack/four-template-e2e-receipt.mjs";

const sourceCommit = "a".repeat(40);
const templates = ["claude", "pi", "opencode", "codex"];
const imageDigests = Object.fromEntries(
	templates.map((template, index) => [
		template,
		`sha256:${String.fromCharCode(98 + index).repeat(64)}`,
	]),
);

function evidence(templateId) {
	return {
		templateId,
		driver: templateId === "opencode" ? "acp" : templateId,
		sourceCommit,
		imageDigest: imageDigests[templateId],
		configurationRevision: `configuration-${templateId}`,
		sandboxIdentityHash: "c".repeat(64),
		providerVersion: `provider-${templateId}-1.0.0`,
		nativeCommandReadback: {
			httpStatus: 202,
			executionId: `execution-${templateId}`,
			terminalStatus: "failed",
			reconnected: true,
			initialRequestCount: 1,
		},
		nativeCommands: {
			compact: {
				outcome: "completed",
				catalogHash: "1".repeat(64),
				invocationHash: "2".repeat(64),
				terminalHash: "3".repeat(64),
				reconnectHash: "4".repeat(64),
			},
			goal: {
				outcome: "unavailable",
				catalogHash: "1".repeat(64),
				blockedSubmissionHash: "5".repeat(64),
			},
		},
		runtimeEvents: {
			count: 6,
			eventIdHashes: ["d".repeat(64), "e".repeat(64)],
		},
		finalReceiptHash: "f".repeat(64),
		checks: Object.fromEntries(
			ackFourTemplateChecks.map((check) => [
				check,
				{ status: "passed", evidenceHash: "1".repeat(64) },
			]),
		),
	};
}

function input() {
	return {
		schemaVersion: 1,
		kind: "ack-four-template-e2e-input",
		sourceCommit,
		imageDigests,
		evidence: templates.map(evidence),
	};
}

test("accepts four complete ACK end-to-end template records", () => {
	const result = validateAckFourTemplateEvidence(input());
	assert.equal(result.status, "passed");
	assert.deepEqual(
		result.templates.map((item) => item.templateId),
		templates,
	);
	assert.equal(result.templates[0].providerVersion, "provider-claude-1.0.0");
});

test("keeps acceptance blocked when restart, recovery, or negative evidence is missing", () => {
	const value = input();
	delete value.evidence[1].checks.recovery;
	value.evidence[2].checks.crossConversationNativeSession.status = "unknown";
	const result = validateAckFourTemplateEvidence(value);
	assert.equal(result.status, "blocked");
	assert(result.reasons.includes("evidence[1].checks.recovery:missing"));
	assert(
		result.reasons.includes(
			"evidence[2].checks.crossConversationNativeSession:unknown",
		),
	);
});

test("rejects source, image, template, and unbounded-field drift", () => {
	const value = input();
	value.evidence[0].sourceCommit = "9".repeat(40);
	value.imageDigests.pi = `sha256:${"9".repeat(64)}`;
	value.evidence[2].unexpected = "secret";
	value.evidence[3].templateId = "unknown";
	const result = validateAckFourTemplateEvidence(value);
	assert.equal(result.status, "blocked");
	assert(result.reasons.includes("evidence[0]:source-commit-drift"));
	assert(result.reasons.includes("evidence[1]:image-digest-drift"));
	assert(result.reasons.includes("evidence[2]:unbounded-field"));
	assert(result.reasons.includes("evidence[3]:template-id"));
});

test("requires real Codex compact completion, reconnect and M1 goal non-submission evidence", () => {
	const data = input();
	const codex = data.evidence[3].nativeCommands;
	delete codex.compact.reconnectHash;
	codex.goal = { ...codex.compact, outcome: "completed" };
	delete data.evidence[0].nativeCommands;
	const result = validateAckFourTemplateEvidence(data);
	assert.equal(result.status, "blocked");
	for (const reason of [
		"evidence[0].nativeCommands:missing",
		"evidence[3].nativeCommands.compact:reconnectHash",
		"evidence[3].nativeCommands.goal:outcome",
	])
		assert(result.reasons.includes(reason));
	codex.compact = { ...evidence("claude").nativeCommands.goal };
	assert(
		validateAckFourTemplateEvidence(data).reasons.includes(
			"evidence[3].nativeCommands.compact:outcome",
		),
	);
});

test("accepts a discoverable but non-invocable command on a non-Codex template", () => {
	const data = input();
	data.evidence[1].nativeCommands.compact = {
		...data.evidence[1].nativeCommands.goal,
		outcome: "discovery-only",
	};
	assert.equal(
		validateAckFourTemplateEvidence(data).templates[1].nativeCommands.compact
			.outcome,
		"discovery-only",
	);
});
