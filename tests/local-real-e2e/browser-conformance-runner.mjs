import { isDeepStrictEqual } from "node:util";
import {
	browserConformanceChecks,
	browserConformanceRelease,
	browserConformanceTemplates,
	validateBrowserConformanceReceipt,
} from "./browser-conformance-validation.mjs";

const versionPattern = /^[0-9]{1,6}(?:\.[0-9]{1,6}){2,3}$/u;
const templateResultKeys = new Set([
	"template",
	"release",
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
			!["chromiumVersion", "playwrightVersion", "capabilityRevision"].includes(
				key,
			)
		)
			throw new Error("BROWSER_CONFORMANCE_DEPLOYMENT_UNBOUNDED");
	}
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
	if (result.template !== template)
		throw new Error(
			`BROWSER_CONFORMANCE_${template.toUpperCase()}_TEMPLATE_DRIFT`,
		);
	for (const key of Object.keys(result)) {
		if (!templateResultKeys.has(key))
			throw new Error(
				`BROWSER_CONFORMANCE_${template.toUpperCase()}_RESULT_UNBOUNDED`,
			);
	}
	if (
		result.imageDigest !== deployment.imageDigest ||
		result.chromiumVersion !== deployment.chromiumVersion ||
		result.playwrightVersion !== deployment.playwrightVersion ||
		result.capabilityRevision !== deployment.capabilityRevision
	)
		throw new Error(
			`BROWSER_CONFORMANCE_${template.toUpperCase()}_TUPLE_DRIFT`,
		);
	if (!isDeepStrictEqual(result.release, deployment.release))
		throw new Error(
			`BROWSER_CONFORMANCE_${template.toUpperCase()}_RELEASE_DRIFT`,
		);
	return structuredClone(result);
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
	const commit = value.commit;
	const deploymentRelease = structuredClone(value.deploymentRelease);
	const binding = browserConformanceRelease(deploymentRelease, commit);
	assertDeployment(value.deployment);
	const common = structuredClone(value.deployment);
	const deployment = { ...common, ...binding };
	const templates = [];
	for (const template of browserConformanceTemplates) {
		value.signal?.throwIfAborted();
		const target = {
			...common,
			release: binding.release,
			imageDigest: binding.imageDigests[template],
		};
		const result = await value.runTemplate(template, {
			deployment: structuredClone(target),
			signal: value.signal,
		});
		value.signal?.throwIfAborted();
		templates.push(normalizeTemplateResult(template, result, target));
	}
	const receipt = {
		schemaVersion: 2,
		classification: "browser-m1-conformance",
		commit,
		deployment,
		templates,
	};
	const validated = validateBrowserConformanceReceipt(
		receipt,
		deploymentRelease,
	);
	if (validated.status !== "passed") {
		const error = new Error("BROWSER_CONFORMANCE_RECEIPT_INVALID");
		error.reasons = validated.reasons;
		throw error;
	}
	return { receipt, validated };
}

export { browserConformanceChecks, browserConformanceTemplates };
