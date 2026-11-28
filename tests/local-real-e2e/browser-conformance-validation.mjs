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
const versionPattern = /^[0-9]{1,6}(?:\.[0-9]{1,6}){2,3}$/u;

function matches(pattern, value) {
	return typeof value === "string" && pattern.test(value);
}

function record(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: undefined;
}

function rejection(reasons, evidence = {}) {
	return {
		status: "rejected",
		reasons: [...new Set(reasons)],
		evidence: Object.fromEntries(Object.entries(evidence).sort()),
	};
}

/** Read the operator's independently sourced Helm deploymentRelease; only its template publication enters the receipt. */
export function browserConformanceRelease(deploymentRelease, commit) {
	const source = deploymentRelease?.source;
	const version = deploymentRelease?.version;
	if (
		source?.repository !== "AgoraIO-Extensions/agent-infra" ||
		!matches(/^[a-f0-9]{40}$/u, source.sha) ||
		source.sha !== commit ||
		!Number.isSafeInteger(source.releaseRun) ||
		source.releaseRun < 1 ||
		!Number.isSafeInteger(source.attempt) ||
		source.attempt < 1 ||
		(version !== undefined &&
			!matches(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u, version))
	)
		throw new Error("release:source");
	const manifest = deploymentRelease.manifests?.["templates-amd64"];
	if (
		manifest?.schemaVersion !== 1 ||
		manifest.platform !== "linux/amd64" ||
		manifest.commitSha !== commit
	)
		throw new Error("release:template-manifest");
	const images = record(manifest.images);
	if (
		!images ||
		Object.keys(images).some(
			(key) => !browserConformanceTemplates.includes(key),
		)
	)
		throw new Error("release:templates");
	const imageDigests = {};
	for (const template of browserConformanceTemplates) {
		const image = images[template];
		if (
			image?.repository !==
				`ghcr.io/agoraio-extensions/agent-infra/agent-runtime-${template}` ||
			!matches(digestPattern, image.digest)
		)
			throw new Error(`release:${template}-image`);
		imageDigests[template] = image.digest;
	}
	return {
		release: {
			...(version !== undefined && { version }),
			source: {
				repository: source.repository,
				sha: source.sha,
				releaseRun: source.releaseRun,
				attempt: source.attempt,
			},
		},
		imageDigests,
	};
}

function checkEntry(value, path, reasons, evidence) {
	const entry = record(value);
	if (!entry) {
		reasons.push(`${path}:missing`);
		return;
	}
	const status = entry.status;
	if (!["passed", "failed", "unknown", "blocked"].includes(status))
		reasons.push(`${path}:invalid-status`);
	else if (status !== "passed") reasons.push(`${path}:${status}`);
	if (!matches(hashPattern, entry.evidenceHash))
		reasons.push(`${path}:evidence-hash`);
	else if (status !== "passed") evidence[path] = entry.evidenceHash;
	for (const key of Object.keys(entry)) {
		if (!["status", "evidenceHash"].includes(key))
			reasons.push(`${path}:unbounded-field`);
	}
}

/**
 * Validate an externally produced D7 receipt without treating declarations,
 * health checks, fixtures or unknown results as Browser acceptance.
 * The returned passed form contains hashes and versions only.
 */
export function validateBrowserConformanceReceipt(value, ...releaseInput) {
	const reasons = [];
	const rejectedEvidence = {};
	const input = record(value);
	if (!input) return rejection(["receipt:shape"]);
	for (const key of Object.keys(input)) {
		if (
			![
				"schemaVersion",
				"classification",
				"commit",
				"deployment",
				"templates",
			].includes(key)
		)
			reasons.push("receipt:unbounded-field");
	}
	const isRelease = input.schemaVersion === 2;
	let expected;
	if (isRelease) {
		if (releaseInput.length !== 1) return rejection(["release:source"]);
		try {
			expected = browserConformanceRelease(releaseInput[0], input.commit);
		} catch (error) {
			return rejection([error.message]);
		}
	} else if (input.schemaVersion !== 1 || releaseInput.length > 0) {
		// An explicitly supplied undefined is a failed release lookup. V1 history uses one argument.
		reasons.push("receipt:schema-version");
	}
	if (input.classification !== "browser-m1-conformance")
		reasons.push("receipt:classification");
	if (!matches(/^[0-9a-f]{40}$/u, input.commit)) reasons.push("receipt:commit");
	const deployment = record(input.deployment);
	if (!deployment) reasons.push("deployment:missing");
	else {
		for (const key of Object.keys(deployment)) {
			if (
				![
					...(isRelease ? ["imageDigests", "release"] : ["imageDigest"]),
					"chromiumVersion",
					"playwrightVersion",
					"capabilityRevision",
				].includes(key)
			)
				reasons.push("deployment:unbounded-field");
		}
		if (isRelease) {
			if (!isDeepStrictEqual(deployment.release, expected.release))
				reasons.push("deployment:release-drift");
			if (!isDeepStrictEqual(deployment.imageDigests, expected.imageDigests))
				reasons.push("deployment:image-digests-drift");
		} else if (!matches(digestPattern, deployment.imageDigest))
			reasons.push("deployment:image-digest");
		if (!matches(versionPattern, deployment.chromiumVersion))
			reasons.push("deployment:chromium-version");
		if (!matches(versionPattern, deployment.playwrightVersion))
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
		const template = record(value);
		const knownTemplate = browserConformanceTemplates.includes(
			template?.template,
		);
		const path =
			isRelease && knownTemplate
				? `templates.${template.template}`
				: `templates[${index}]`;
		if (!template) {
			reasons.push(`${path}:shape`);
			continue;
		}
		if (!knownTemplate) {
			reasons.push(`${path}:template`);
		} else if (seen.has(template.template)) {
			reasons.push(`${path}:duplicate-template`);
		} else {
			seen.add(template.template);
		}
		for (const field of ["agentHash", "sessionHash", "executionHash"]) {
			if (!matches(hashPattern, template[field]))
				reasons.push(`${path}:${field}`);
		}
		if (deployment) {
			const expectedDigest =
				isRelease && knownTemplate
					? expected.imageDigests[template.template]
					: deployment.imageDigest;
			if (template.imageDigest !== expectedDigest)
				reasons.push(`${path}:image-digest-drift`);
			if (isRelease && !isDeepStrictEqual(template.release, expected.release))
				reasons.push(`${path}:release-drift`);
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
				checkEntry(
					checks[check],
					`${path}.${check}`,
					reasons,
					rejectedEvidence,
				);
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
					...(isRelease ? ["release"] : []),
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
	if (reasons.length) return rejection(reasons, rejectedEvidence);
	return {
		status: "passed",
		commit: input.commit,
		deployment: {
			...(isRelease ? expected : { imageDigest: deployment.imageDigest }),
			chromiumVersion: deployment.chromiumVersion,
			playwrightVersion: deployment.playwrightVersion,
			capabilityRevision: deployment.capabilityRevision,
		},
		templates: templates.map((template) => ({
			template: template.template,
			...(isRelease && { imageDigest: template.imageDigest }),
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
