import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseAllDocuments } from "yaml";

type RecordValue = Record<string, any>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const immutable = /^[a-z0-9][a-z0-9.:/-]*@sha256:[a-f0-9]{64}$/u;
const components = {
	web: "agent-infra-web",
	platformApi: "agent-infra-api",
	platformWorker: "agent-infra-worker",
	enterpriseDirectorySync: "agent-infra-directory",
};

export function normalizeRuntimeImageManifest(value: RecordValue, sourceSha: string): RecordValue {
	assert(value && typeof value === "object" && !Array.isArray(value));
	assert(typeof sourceSha === "string" && /^[a-f0-9]{40}$/u.test(sourceSha));
	assert(value.schemaVersion === 1 && value.platform === "linux/amd64" && value.commitSha === sourceSha);
	const image = Object.hasOwn(value, "images") ? value.images?.runtimeHost : value;
	assert(image && typeof image.repository === "string" && typeof image.digest === "string");
	assert.match(`${image.repository}@${image.digest}`, immutable);
	return { schemaVersion: 1, commitSha: sourceSha, platform: value.platform, repository: image.repository, digest: image.digest };
}

export function validateRenderedImages(
	text: string,
	platform: RecordValue,
	runtime: RecordValue,
) {
	assert(platform.schemaVersion === 1 && platform.platform === "linux/amd64");
	runtime = normalizeRuntimeImageManifest(runtime, platform.commitSha);
	const documents = parseAllDocuments(text).map((document) => {
		assert.equal(document.errors.length, 0);
		return document.toJSON() as RecordValue;
	}).filter(Boolean);
	for (const [key, name] of Object.entries(components)) {
		const matches = documents.filter(
			(item) => item.kind === "Deployment" && item.metadata?.name === name,
		);
		assert.equal(matches.length, 1);
		const containers = matches[0].spec.template.spec.containers;
		assert.equal(containers.length, 1);
		const image = platform.images[key];
		const expected = `${image.repository}@${image.digest}`;
		assert.match(expected, immutable);
		assert.equal(containers[0].image, expected);
		if (key === "platformWorker") {
			for (const [field, expectedValue] of [
				["AGENT_INFRA_RUNTIME_IMAGE_REPOSITORY", runtime.repository],
				["AGENT_INFRA_RUNTIME_IMAGE_DIGEST", runtime.digest],
			]) {
				const entries = containers[0].env.filter((entry: RecordValue) => entry.name === field);
				assert.equal(entries.length, 1);
				assert.equal(entries[0].value, expectedValue);
			}
		}
	}
	assert.match(`${runtime.repository}@${runtime.digest}`, immutable);
	for (const document of documents) {
		const pod = document.kind === "Pod" ? document.spec : document.spec?.template?.spec;
		for (const container of [...(pod?.containers ?? []), ...(pod?.initContainers ?? [])])
			assert.match(container.image, immutable);
	}
}

// Deliberately project fields: annotations, env, event messages and URLs can contain secrets.
export function projectSnapshot(
	helm: RecordValue[],
	resources: RecordValue,
	release: string,
	namespace: string,
	sourceSha: string,
) {
	assert.match(sourceSha, /^[a-f0-9]{40}$/u);
	assert(Array.isArray(helm) && Array.isArray(resources.items));
	const releases = helm.filter((item) => item.name === release);
	assert(releases.length <= 1);
	const revision = releases.length ? Number(releases[0].revision) : null;
	assert(revision === null || (Number.isSafeInteger(revision) && revision > 0));
	return {
		schemaVersion: 1,
		observedAt: new Date().toISOString(),
		expectedSourceSha: sourceSha,
		deploymentSourceVerified: false,
		releaseHash: hash(release),
		namespaceHash: hash(namespace),
		helmRevision: revision,
		businessVerified: false,
		resources: resources.items.map((item: RecordValue) => {
			const kind = ["Deployment", "StatefulSet", "Pod", "Job", "PersistentVolumeClaim"].includes(item.kind)
				? item.kind : "other";
			const pod = kind === "Pod" ? item.spec : item.spec?.template?.spec;
			return {
				kind,
				nameHash: hash(String(item.metadata?.name ?? "")),
				uidHash: hash(String(item.metadata?.uid ?? "")),
				nodeHash: pod?.nodeName ? hash(String(pod.nodeName)) : null,
				images: (pod?.containers ?? []).map((container: RecordValue) => ({
					referenceHash: hash(String(container.image ?? "")),
					digestHash: hash(String(container.image ?? "").split("@")[1] ?? ""),
				})),
				ready: item.status?.conditions?.some((condition: RecordValue) =>
					["Ready", "Available", "Complete"].includes(condition.type) && condition.status === "True") === true,
			};
		}),
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const [mode, ...args] = process.argv.slice(2);
		if (mode === "runtime-manifest") {
			const [file, source] = args;
			normalizeRuntimeImageManifest(JSON.parse(readFileSync(file, "utf8")), source);
		} else if (mode === "render") {
			const [rendered, platform, runtime] = args;
			validateRenderedImages(readFileSync(rendered, "utf8"),
				JSON.parse(readFileSync(platform, "utf8")), JSON.parse(readFileSync(runtime, "utf8")));
		} else if (mode === "snapshot") {
			const [namespace, release, source] = args;
			const run = (command: string, argv: string[]) => JSON.parse(execFileSync(command, argv, {
				encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
			}));
			const helm = run("helm", ["list", "-n", namespace, "-o", "json"]);
			const resources = run("kubectl", ["--request-timeout=20s", "-n", namespace,
				"get", "deploy,statefulset,pod,job,pvc", "-o", "json"]);
			process.stdout.write(`${JSON.stringify(projectSnapshot(helm, resources, release, namespace, source), null, 2)}\n`);
		} else throw new Error("MODE_INVALID");
	} catch {
		process.stderr.write("ACK_EVIDENCE_VALIDATION_FAILED\n");
		process.exitCode = 1;
	}
}
