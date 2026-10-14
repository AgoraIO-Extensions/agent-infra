import {
	browserConformanceChecks,
	browserConformanceTemplates,
	validateBrowserConformanceReceipt,
} from "./browser-conformance-validation.mjs";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const versionPattern = /^[0-9]{1,6}(?:\.[0-9]{1,6}){2,3}$/u;
const templateResultKeys = new Set([
	"agentHash",
	"sessionHash",
	"executionHash",
	"imageDigest",
	"chromiumVersion",
	"playwrightVersion",
	"capabilityRevision",
	"checks",
]);

function record(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: undefined;
}

function assertString(pattern, value, message) {
	if (typeof value !== "string" || !pattern.test(value))
		throw new Error(message);
}

function assertDeployment(deployment) {
	const value = record(deployment);
	if (!value) throw new Error("BROWSER_CONFORMANCE_DEPLOYMENT_INVALID");
	for (const key of Object.keys(value)) {
		if (
			![
				"imageDigest",
				"chromiumVersion",
				"playwrightVersion",
				"capabilityRevision",
			].includes(key)
		)
			throw new Error("BROWSER_CONFORMANCE_DEPLOYMENT_UNBOUNDED");
	}
	assertString(
		digestPattern,
		value.imageDigest,
		"BROWSER_CONFORMANCE_IMAGE_DIGEST_INVALID",
	);
	assertString(
		versionPattern,
		value.chromiumVersion,
		"BROWSER_CONFORMANCE_CHROMIUM_VERSION_INVALID",
	);
	assertString(
		versionPattern,
		value.playwrightVersion,
		"BROWSER_CONFORMANCE_PLAYWRIGHT_VERSION_INVALID",
	);
	if (
		!Number.isSafeInteger(value.capabilityRevision) ||
		value.capabilityRevision < 1
	)
		throw new Error("BROWSER_CONFORMANCE_CAPABILITY_REVISION_INVALID");
}

function normalizeTemplateResult(template, value, deployment) {
	const result = record(value);
	if (!result)
		throw new Error(
			`BROWSER_CONFORMANCE_${template.toUpperCase()}_RESULT_INVALID`,
		);
	for (const key of Object.keys(result)) {
		if (!templateResultKeys.has(key))
			throw new Error(
				`BROWSER_CONFORMANCE_${template.toUpperCase()}_RESULT_UNBOUNDED`,
			);
	}
	const normalized = {
		template,
		agentHash: result.agentHash,
		sessionHash: result.sessionHash,
		executionHash: result.executionHash,
		imageDigest: result.imageDigest,
		chromiumVersion: result.chromiumVersion,
		playwrightVersion: result.playwrightVersion,
		capabilityRevision: result.capabilityRevision,
		checks: result.checks,
	};
	if (
		normalized.imageDigest !== deployment.imageDigest ||
		normalized.chromiumVersion !== deployment.chromiumVersion ||
		normalized.playwrightVersion !== deployment.playwrightVersion ||
		normalized.capabilityRevision !== deployment.capabilityRevision
	)
		throw new Error(
			`BROWSER_CONFORMANCE_${template.toUpperCase()}_TUPLE_DRIFT`,
		);
	return normalized;
}

/**
 * Run four externally supplied real Browser journeys in a fixed order and
 * return only the bounded conformance receipt. The callback owns the actual
 * Runtime/Session/Browser work; this runner owns ordering, tuple consistency,
 * cancellation and receipt validation.
 */
export async function runBrowserConformanceSuite(input) {
	const value = record(input);
	if (!value || typeof value.runTemplate !== "function")
		throw new Error("BROWSER_CONFORMANCE_RUNNER_INPUT_INVALID");
	assertString(
		/^[0-9a-f]{40}$/u,
		value.commit,
		"BROWSER_CONFORMANCE_COMMIT_INVALID",
	);
	assertDeployment(value.deployment);
	const deployment = structuredClone(value.deployment);
	const templates = [];
	for (const template of browserConformanceTemplates) {
		value.signal?.throwIfAborted();
		const result = await value.runTemplate(template, {
			deployment: structuredClone(deployment),
			signal: value.signal,
		});
		value.signal?.throwIfAborted();
		templates.push(normalizeTemplateResult(template, result, deployment));
	}
	const receipt = {
		schemaVersion: 1,
		classification: "browser-m1-conformance",
		commit: value.commit,
		deployment,
		templates,
	};
	const validated = validateBrowserConformanceReceipt(receipt);
	if (validated.status !== "passed") {
		const error = new Error("BROWSER_CONFORMANCE_RECEIPT_INVALID");
		error.reasons = validated.reasons;
		throw error;
	}
	return { receipt, validated };
}

export { browserConformanceChecks, browserConformanceTemplates };
