import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { privateBytes, privateJson } from "./private-input.ts";

const digest = /^sha256:[a-f0-9]{64}$/u;
const hash = (bytes: string | Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

/** Read-only gate: readiness does not prove that a Session can be allocated. */
export function validateCapacityBindings(
	requests: any[],
	templates: any[],
	policy: any,
	profiles: any[],
	evidence: Map<string, Uint8Array>,
) {
	assert(Array.isArray(requests) && requests.length > 0 && requests.length <= 20);
	assert(Array.isArray(templates) && Array.isArray(profiles));
	assert(typeof policy.resourceProfileRef === "string" && policy.resourceProfileRef);
	for (const field of ["requests", "limits"])
		for (const resource of ["cpu", "memory"])
			assert(typeof policy.resources?.[field]?.[resource] === "string");
	const resourcesHash = hash(JSON.stringify({
		resourceProfileRef: policy.resourceProfileRef,
		requests: {
			cpu: policy.resources.requests.cpu,
			memory: policy.resources.requests.memory,
		},
		limits: {
			cpu: policy.resources.limits.cpu,
			memory: policy.resources.limits.memory,
		},
	}));
	const checked = new Set<string>();
	for (const request of requests) {
		const source = request.source;
		assert(source && ["standard", "custom"].includes(source.kind));
		if (source.kind === "custom" && source.interactionMode === "self-managed")
			continue;
		const matches = source.kind === "standard"
			? templates.filter((entry) => entry.templateId === source.templateId)
			: [];
		if (source.kind === "standard") assert(matches.length === 1);
		const imageDigest = source.kind === "standard"
			? matches[0].imageDigest
			: source.imageReference?.split("@")[1];
		assert(typeof imageDigest === "string" && digest.test(imageDigest));
		if (checked.has(imageDigest)) continue;
		const capacity = profiles.filter((profile) =>
			profile.imageDigest === imageDigest &&
			profile.resourceProfileRef === policy.resourceProfileRef &&
			profile.resourceConfigurationHash === resourcesHash,
		);
		assert(capacity.length === 1, "CAPACITY_BINDING_MISSING_OR_AMBIGUOUS");
		const profile = capacity[0];
		assert(profile.schemaVersion === 1 &&
			Number.isSafeInteger(profile.maximumConcurrentExecutions) &&
			profile.maximumConcurrentExecutions > 0 &&
			/^[a-f0-9]{64}$/u.test(profile.conformanceEvidenceHash) &&
			!/^0+$/u.test(profile.conformanceEvidenceHash));
		const bytes = evidence.get(imageDigest);
		assert(bytes && hash(bytes) === profile.conformanceEvidenceHash,
			"CAPACITY_EVIDENCE_MISMATCH");
		checked.add(imageDigest);
	}
	return {
		schemaVersion: 1,
		kind: "ack-workload-capacity",
		imageCount: checked.size,
		resourceConfigurationHash: resourcesHash,
		businessVerified: false,
	};
}

export async function checkWorkloadCapacity(
	configFile: string,
	requestsFile: string,
	templatesFile: string,
	sourceSha: string,
	readMountedProfiles: (ref: { name: string; key: string }) => Uint8Array,
) {
	const input = await privateJson(configFile);
	const requests = await privateJson(requestsFile);
	const templates = await privateJson(templatesFile);
	assert(/^[a-f0-9]{40}$/u.test(sourceSha));
	assert(input.schemaVersion === 1 && input.sourceSha === sourceSha &&
		templates.schemaVersion === 1 && templates.sourceSha === sourceSha &&
		requests.schemaVersion === 1 && Array.isArray(requests.requests) &&
		requests.requests.length > 0 && requests.requests.length <= 20);
	assert(Array.isArray(input.evidence) && input.evidence.length <= 64);
	const bytes = await privateBytes(input.profilesFile);
	const profiles = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	assert(profiles.schemaVersion === 1);
	const evidence = new Map<string, Uint8Array>();
	for (const entry of input.evidence) {
		assert(digest.test(entry.imageDigest) && !evidence.has(entry.imageDigest));
		evidence.set(entry.imageDigest, await privateBytes(entry.file));
	}
	const bodies = await Promise.all(requests.requests.map(
		(request: { bodyFile: string }) => privateJson(request.bodyFile),
	));
	const receipt = validateCapacityBindings(
		bodies, templates.templates, input, profiles.profiles, evidence,
	);
	const ref = input.workerSecretRef;
	assert(ref && /^[a-z0-9][a-z0-9.-]{0,252}$/u.test(ref.name) &&
		/^[A-Za-z0-9._-]{1,253}$/u.test(ref.key));
	assert.deepEqual(Buffer.from(readMountedProfiles(ref)), bytes,
		"CAPACITY_SECRET_DRIFT");
	return { ...receipt, profilesHash: hash(bytes), mountedInputVerified: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const [config, requests, templates] = process.argv.slice(2);
		const { ACK_KUBECONFIG: kubeconfig, ACK_NAMESPACE: namespace, ACK_SOURCE_SHA: source } = process.env;
		assert(kubeconfig && namespace && source && config && requests && templates);
		const result = await checkWorkloadCapacity(config, requests, templates, source, (ref) => {
			const value = JSON.parse(execFileSync("kubectl", [
				"--kubeconfig", kubeconfig, "--request-timeout=20s", "-n", namespace,
				"get", "secret", ref.name, "-o", "json",
			], { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"] }));
			assert(value.metadata?.namespace === namespace && value.metadata?.name === ref.name);
			assert(typeof value.data?.[ref.key] === "string");
			return Buffer.from(value.data[ref.key], "base64");
		});
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch {
		process.stderr.write("ACK_WORKLOAD_CAPACITY_INVALID\n");
		process.exitCode = 1;
	}
}
