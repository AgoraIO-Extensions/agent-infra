import { isDeepStrictEqual } from "node:util";

export const browserConformanceTemplates = Object.freeze([
	"codex",
	"claude",
	"opencode",
	"pi",
]);

export const browserConformanceChecks = Object.freeze([
	"navigation",
	"observation",
	"interaction",
	"approval",
	"files",
	"handoff",
	"isolation",
	"recovery",
	"securityNegative",
]);

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const hashPattern = /^[0-9a-f]{64}$/u;
const versionPattern = /^[\x21-\x7e]{1,128}$/u;

function record(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: undefined;
}

function rejection(reasons) {
	return { status: "rejected", reasons: [...new Set(reasons)] };
}

function checkEntry(value, path, reasons) {
	const entry = record(value);
	if (!entry) {
		reasons.push(`${path}:missing`);
		return;
	}
	if (entry.status !== "passed")
		reasons.push(`${path}:${String(entry.status)}`);
	if (!hashPattern.test(entry.evidenceHash ?? ""))
		reasons.push(`${path}:evidence-hash`);
}

/**
 * Validate an externally produced D7 receipt without treating declarations,
 * health checks, fixtures or unknown results as Browser acceptance.
 * The returned passed form contains hashes and versions only.
 */
export function validateBrowserConformanceReceipt(value) {
	const reasons = [];
	const input = record(value);
	if (!input) return rejection(["receipt:shape"]);
	if (input.schemaVersion !== 1) reasons.push("receipt:schema-version");
	if (input.classification !== "browser-m1-conformance")
		reasons.push("receipt:classification");
	if (!/^[0-9a-f]{40}$/u.test(input.commit ?? ""))
		reasons.push("receipt:commit");
	const deployment = record(input.deployment);
	if (!deployment) reasons.push("deployment:missing");
	else {
		if (!digestPattern.test(deployment.imageDigest ?? ""))
			reasons.push("deployment:image-digest");
		if (!versionPattern.test(deployment.chromiumVersion ?? ""))
			reasons.push("deployment:chromium-version");
		if (!versionPattern.test(deployment.playwrightVersion ?? ""))
			reasons.push("deployment:playwright-version");
		if (
			!Number.isSafeInteger(deployment.capabilityRevision) ||
			deployment.capabilityRevision < 1
		)
			reasons.push("deployment:capability-revision");
	}
	if (
		!Array.isArray(input.templates) ||
		input.templates.length !== browserConformanceTemplates.length
	) {
		reasons.push("templates:count");
	}
	const templates = Array.isArray(input.templates) ? input.templates : [];
	const seen = new Set();
	for (const [index, value] of templates.entries()) {
		const path = `templates[${index}]`;
		const template = record(value);
		if (!template) {
			reasons.push(`${path}:shape`);
			continue;
		}
		if (!browserConformanceTemplates.includes(template.template)) {
			reasons.push(`${path}:template`);
		} else if (seen.has(template.template)) {
			reasons.push(`${path}:duplicate-template`);
		} else {
			seen.add(template.template);
		}
		for (const field of ["agentHash", "sessionHash", "executionHash"]) {
			if (!hashPattern.test(template[field] ?? ""))
				reasons.push(`${path}:${field}`);
		}
		if (deployment) {
			if (template.imageDigest !== deployment.imageDigest)
				reasons.push(`${path}:image-digest-drift`);
			if (template.chromiumVersion !== deployment.chromiumVersion)
				reasons.push(`${path}:chromium-drift`);
			if (template.playwrightVersion !== deployment.playwrightVersion)
				reasons.push(`${path}:playwright-drift`);
			if (template.capabilityRevision !== deployment.capabilityRevision)
				reasons.push(`${path}:capability-drift`);
		}
		const checks = record(template.checks);
		if (!checks) reasons.push(`${path}:checks-missing`);
		else {
			for (const check of browserConformanceChecks)
				checkEntry(checks[check], `${path}.${check}`, reasons);
			for (const key of Object.keys(checks)) {
				if (!browserConformanceChecks.includes(key))
					reasons.push(`${path}:unknown-check`);
			}
		}
		for (const key of Object.keys(template)) {
			if (
				![
					"template",
					"agentHash",
					"sessionHash",
					"executionHash",
					"imageDigest",
					"chromiumVersion",
					"playwrightVersion",
					"capabilityRevision",
					"checks",
				].includes(key)
			)
				reasons.push(`${path}:unbounded-field`);
		}
	}
	for (const template of browserConformanceTemplates) {
		if (!seen.has(template)) reasons.push(`templates:missing-${template}`);
	}
	if (reasons.length) return rejection(reasons);
	return {
		status: "passed",
		commit: input.commit,
		deployment: {
			imageDigest: deployment.imageDigest,
			chromiumVersion: deployment.chromiumVersion,
			playwrightVersion: deployment.playwrightVersion,
			capabilityRevision: deployment.capabilityRevision,
		},
		templates: templates.map((template) => ({
			template: template.template,
			agentHash: template.agentHash,
			sessionHash: template.sessionHash,
			executionHash: template.executionHash,
			checks: Object.fromEntries(
				browserConformanceChecks.map((check) => [
					check,
					template.checks[check].evidenceHash,
				]),
			),
		})),
	};
}

export function sameBrowserConformanceTuple(left, right) {
	return isDeepStrictEqual(left?.deployment, right?.deployment);
}
