import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const ackFourTemplateIds = Object.freeze([
	"claude",
	"pi",
	"opencode",
	"codex",
]);

export const ackFourTemplateChecks = Object.freeze([
	"create",
	"prompt",
	"stream",
	"completion",
	"restart",
	"recovery",
	"concurrentConversations",
	"conversationIsolation",
	"crossConversationNativeSession",
	"credentialIsolation",
	"workspaceIsolation",
	"eventReplay",
]);

const drivers = Object.freeze({ claude: "claude", pi: "pi", opencode: "acp", codex: "codex" });
const sourcePattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const boundedTextPattern = /^[A-Za-z0-9][A-Za-z0-9._+/:@-]{0,255}$/u;

function record(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function add(reasons, reason) {
	if (!reasons.includes(reason)) reasons.push(reason);
}

function hash(value) {
	return createHash("sha256").update(value).digest("hex");
}

function checkEntry(value, path, reasons, output) {
	const entry = record(value);
	if (!entry) {
		add(reasons, `${path}:missing`);
		return;
	}
	for (const key of Object.keys(entry)) {
		if (!["status", "evidenceHash"].includes(key)) add(reasons, `${path}:unbounded-field`);
	}
	if (!("status" in entry)) add(reasons, `${path}:missing-status`);
	else if (entry.status !== "passed") add(reasons, `${path}:${entry.status}`);
	if (!hashPattern.test(entry.evidenceHash ?? "")) add(reasons, `${path}:evidence-hash`);
	else output[path.split(".").at(-1)] = entry.evidenceHash;
}

// Status describes the observed Web behavior. Missing catalog/readback evidence blocks acceptance.
function nativeCommandEvidence(item, path, reasons) {
	const commands = record(item.nativeCommands);
	if (!commands) {
		add(reasons, `${path}:missing`);
		return;
	}
	const normalized = {};
	for (const name of ["compact", "goal"]) {
		const entry = record(commands[name]);
		const allowed = item.templateId === "codex"
			? [name === "compact" ? "completed" : "unavailable"]
			: ["completed", "unavailable", "discovery-only"];
		if (!entry || !allowed.includes(entry.outcome)) {
			add(reasons, `${path}.${name}:outcome`);
			continue;
		}
		const hashes = entry.outcome === "completed"
			? ["catalogHash", "invocationHash", "terminalHash", "reconnectHash"]
			: ["catalogHash", "blockedSubmissionHash"];
		for (const key of hashes) {
			if (typeof entry[key] !== "string" || !hashPattern.test(entry[key])) add(reasons, `${path}.${name}:${key}`);
		}
		if (Object.keys(entry).some((key) => key !== "outcome" && !hashes.includes(key))) add(reasons, `${path}.${name}:unbounded-field`);
		normalized[name] = entry;
	}
	if (Object.keys(commands).some((name) => !["compact", "goal"].includes(name))) add(reasons, `${path}:unbounded-field`);
	return normalized;
}

function validateRecord(value, index, sourceCommit, imageDigest) {
	const reasons = [];
	const item = record(value);
	if (!item) return [`evidence[${index}]:shape`];
	const allowed = new Set([
		"templateId", "driver", "sourceCommit", "imageDigest", "configurationRevision",
		"sandboxIdentityHash", "providerVersion", "runtimeEvents", "finalReceiptHash", "checks", "nativeCommands",
	]);
	for (const key of Object.keys(item)) if (!allowed.has(key)) add(reasons, `evidence[${index}]:unbounded-field`);
	if (!ackFourTemplateIds.includes(item.templateId)) add(reasons, `evidence[${index}]:template-id`);
	else if (item.driver !== drivers[item.templateId]) add(reasons, `evidence[${index}]:driver`);
	if (item.sourceCommit !== sourceCommit) add(reasons, `evidence[${index}]:source-commit-drift`);
	if (item.imageDigest !== imageDigest) add(reasons, `evidence[${index}]:image-digest-drift`);
	if (!boundedTextPattern.test(item.configurationRevision ?? "")) add(reasons, `evidence[${index}]:configuration-revision`);
	if (!hashPattern.test(item.sandboxIdentityHash ?? "")) add(reasons, `evidence[${index}]:sandbox-identity`);
	if (!boundedTextPattern.test(item.providerVersion ?? "")) add(reasons, `evidence[${index}]:provider-version`);
	const runtime = record(item.runtimeEvents);
	if (!runtime) add(reasons, `evidence[${index}].runtimeEvents:missing`);
	else {
		if (!Number.isSafeInteger(runtime.count) || runtime.count < 1) add(reasons, `evidence[${index}].runtimeEvents:count`);
		if (!Array.isArray(runtime.eventIdHashes) || runtime.eventIdHashes.length < 1 || runtime.eventIdHashes.some((entry) => !hashPattern.test(entry))) add(reasons, `evidence[${index}].runtimeEvents:event-hashes`);
		for (const key of Object.keys(runtime)) if (!["count", "eventIdHashes"].includes(key)) add(reasons, `evidence[${index}].runtimeEvents:unbounded-field`);
	}
	if (!hashPattern.test(item.finalReceiptHash ?? "")) add(reasons, `evidence[${index}]:final-receipt`);
	const checks = record(item.checks);
	const boundedChecks = {};
	if (!checks) add(reasons, `evidence[${index}].checks:missing`);
	else {
		for (const check of ackFourTemplateChecks) checkEntry(checks[check], `evidence[${index}].checks.${check}`, reasons, boundedChecks);
		for (const key of Object.keys(checks)) if (!ackFourTemplateChecks.includes(key)) add(reasons, `evidence[${index}].checks:unknown-${key}`);
	}
	const nativeCommands = nativeCommandEvidence(item, `evidence[${index}].nativeCommands`, reasons);
	return { reasons, item, boundedChecks, nativeCommands };
}

/**
 * Validate one bounded receipt assembled from four authenticated browser journeys.
 * The input must be produced by the live ACK journey and include every lifecycle,
 * restart/recovery, concurrency/isolation, credential, workspace, and replay check.
 */
export function validateAckFourTemplateEvidence(value, expected = {}) {
	const reasons = [];
	const input = record(value);
	if (!input) return { status: "blocked", reasons: ["receipt:shape"] };
	for (const key of Object.keys(input)) if (!["schemaVersion", "kind", "sourceCommit", "imageDigests", "evidence"].includes(key)) add(reasons, "receipt:unbounded-field");
	if (input.schemaVersion !== 1) add(reasons, "receipt:schema-version");
	if (input.kind !== "ack-four-template-e2e-input") add(reasons, "receipt:kind");
	if (!sourcePattern.test(input.sourceCommit ?? "")) add(reasons, "receipt:source-commit");
	if (expected.sourceCommit !== undefined && input.sourceCommit !== expected.sourceCommit) add(reasons, "receipt:source-commit-drift");
	const imageDigests = record(input.imageDigests);
	if (!imageDigests) add(reasons, "receipt:image-digests");
	else {
		for (const key of Object.keys(imageDigests)) if (!ackFourTemplateIds.includes(key)) add(reasons, "receipt:image-digests-unbounded");
		for (const template of ackFourTemplateIds) if (!digestPattern.test(imageDigests[template] ?? "")) add(reasons, `receipt:image-digest-${template}`);
		if (expected.imageDigests) for (const template of ackFourTemplateIds) if (imageDigests[template] !== expected.imageDigests[template]) add(reasons, `receipt:image-digest-${template}-drift`);
	}
	if (!Array.isArray(input.evidence) || input.evidence.length !== ackFourTemplateIds.length) add(reasons, "receipt:evidence-count");
	const entries = Array.isArray(input.evidence) ? input.evidence : [];
	const seen = new Set();
	const normalized = [];
	for (const [index, value_] of entries.entries()) {
		const checked = validateRecord(value_, index, input.sourceCommit, imageDigests?.[value_?.templateId]);
		if (Array.isArray(checked)) {
			checked.forEach((reason) => add(reasons, reason));
			continue;
		}
		checked.reasons.forEach((reason) => add(reasons, reason));
		if (seen.has(checked.item.templateId)) add(reasons, `evidence[${index}]:duplicate-template`);
		seen.add(checked.item.templateId);
		for (const template of ackFourTemplateIds) if (checked.item.templateId === template) normalized.push({
			templateId: template,
			driver: checked.item.driver,
			sourceCommit: checked.item.sourceCommit,
			imageDigest: checked.item.imageDigest,
			configurationRevision: checked.item.configurationRevision,
			sandboxIdentityHash: checked.item.sandboxIdentityHash,
			providerVersion: checked.item.providerVersion,
			runtimeEventCount: checked.item.runtimeEvents?.count,
			runtimeEventHashes: checked.item.runtimeEvents?.eventIdHashes,
			finalReceiptHash: checked.item.finalReceiptHash,
			checks: checked.boundedChecks,
			nativeCommands: checked.nativeCommands,
		});
	}
	for (const template of ackFourTemplateIds) if (!seen.has(template)) add(reasons, `evidence:missing-${template}`);
	if (reasons.length) return { status: "blocked", reasons: [...new Set(reasons)].sort() };
	return {
		schemaVersion: 1,
		kind: "ack-four-template-e2e",
		status: "passed",
		sourceCommit: input.sourceCommit,
		imageDigests,
		evidenceHash: hash(JSON.stringify(input)),
		templates: normalized,
	};
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
	try {
		const inputFile = process.argv[2];
		if (!inputFile) throw new Error("ACK_TEMPLATE_E2E_EVIDENCE_FILE_REQUIRED");
		const result = validateAckFourTemplateEvidence(JSON.parse(await readFile(inputFile, "utf8")), {
			sourceCommit: process.argv[3],
			imageDigests: process.argv[4] ? JSON.parse(process.argv[4]) : undefined,
		});
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		if (result.status !== "passed") process.exitCode = 1;
	} catch (error) {
		process.stdout.write(`${JSON.stringify({ schemaVersion: 1, kind: "ack-four-template-e2e", status: "blocked", reasons: [error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : "ACK_TEMPLATE_E2E_EVIDENCE_INVALID"] }, null, 2)}\n`);
		process.exitCode = 1;
	}
}
