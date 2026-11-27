import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { compareChartManifestsV1 } from "../deploy/ack/compare-chart.ts";
import { productionChartValues } from "./fixtures/ack-chart-values.ts";
import { renderAckChart } from "./support/ack-chart.ts";

const b64 = (value: string) => Buffer.from(value).toString("base64");
const image = `registry.example.test/image@sha256:${"a".repeat(64)}`;

test("private production inputs equal the frozen live release, including hooks", {
	skip:
		!process.env.ACK_CHART_PRODUCTION_VALUES_FILES &&
		!process.env.ACK_CHART_PRODUCTION_BASELINE,
}, () => {
	const files = JSON.parse(
		process.env.ACK_CHART_PRODUCTION_VALUES_FILES ?? "null",
	);
	const baseline = process.env.ACK_CHART_PRODUCTION_BASELINE;
	assert(
		Array.isArray(files) &&
			files.length > 0 &&
			files.every((file) => typeof file === "string"),
	);
	assert(baseline);
	const rendered = spawnSync(
		"helm",
		[
			"template",
			"agent-infra",
			new URL("../deploy/ack/chart", import.meta.url).pathname,
			"-n",
			"agent-infra",
			"--kube-version",
			"v1.36.1",
			...files.flatMap((file) => ["-f", file]),
		],
		{ encoding: "utf8", timeout: 20_000 },
	);
	assert.equal(
		rendered.status,
		0,
		"production Helm render failed; inspect the private inputs locally",
	);
	const comparison = compareChartManifestsV1(
		readFileSync(baseline, "utf8"),
		rendered.stdout,
	);
	assert(comparison.baselineResources > 0);
	assert.deepEqual(comparison.changed, []);
});
function render(values?: unknown) {
	const result = renderAckChart(values);
	assert.equal(result.status, 0, result.stderr);
	return parseAllDocuments(result.stdout)
		.map((document) => {
			assert.equal(document.errors.length, 0);
			return document.toJSON();
		})
		.filter(Boolean);
}

test("defaults use external configuration and render no environment-owned resources", () => {
	const documents = render();
	for (const kind of [
		"Secret",
		"ConfigMap",
		"Certificate",
		"Issuer",
		"ImageCache",
		"Job",
		"Pod",
	])
		assert(!documents.some((resource) => resource.kind === kind), kind);
});

test("directory source updates roll the directory with externally managed Secrets", () => {
	const values = {
		chartSecrets: { enabled: false },
		directorySource: { files: { "source.ts": "export const revision = 1;" } },
	};
	const before = render(values);
	values.directorySource.files["source.ts"] = "export const revision = 2;";
	const after = render(values);
	for (const name of [
		"agent-infra-directory",
		"agent-infra-api",
		"agent-infra-worker",
	]) {
		const podTemplate = (resources) =>
			resources.find(
				(resource) =>
					resource.kind === "Deployment" && resource.metadata.name === name,
			).spec.template;
		if (name === "agent-infra-directory") {
			assert.notDeepEqual(podTemplate(before), podTemplate(after));
			assert.equal(
				podTemplate(after).metadata.annotations?.[
					"agent-infra.agora.io/secrets-checksum"
				],
				undefined,
			);
		} else {
			assert.deepEqual(podTemplate(before), podTemplate(after));
		}
	}
});

test("production shape renders configuration, credentials, certificates, directory, caches and hooks", () => {
	const values = {
		...productionChartValues(),
		oidc: { administratorUserIds: ["00000000-0000-4000-8000-000000000001"] },
		files: { enabled: true },
		worker: {
			fileBridge: { enabled: true },
			nativeMetadataGateway: { enabled: true },
			piSessionPlacement: false,
		},
		operations: {
			enabled: true,
			clusterReads: true,
			configurationSecret: "fixture-operations",
		},
		chartSecrets: {
			enabled: true,
			items: {
				"agent-infra-platform-database": {
					type: "Opaque",
					keep: true,
					data: { url: b64("synthetic-database-input") },
				},
			},
		},
		directorySource: { files: { "source.ts": "export const source = {};" } },
		certificates: [
			{
				name: "fixture-web",
				secretName: "fixture-web-tls",
				dnsNames: ["platform.example.test"],
				clusterIssuer: "fixture-issuer",
			},
		],
		imageCaches: { enabled: true, images: [image] },
		smokeTest: { enabled: true },
		migrations: { enabled: true, activeDeadlineSeconds: 600 },
		web: { preStopSleepSeconds: 5 },
	};
	values.configuration.operations = { "configuration.json": b64("{}") };
	const documents = render(values);
	for (const kind of [
		"Secret",
		"ConfigMap",
		"Certificate",
		"ImageCache",
		"Job",
		"Pod",
	])
		assert(
			documents.some((resource) => resource.kind === kind),
			kind,
		);
	const api = documents.find(
		(resource) =>
			resource.kind === "Deployment" &&
			resource.metadata.name === "agent-infra-api",
	);
	const config = documents.find(
		(resource) =>
			resource.kind === "Secret" &&
			resource.metadata.name.startsWith("agent-infra-api-configuration-"),
	);
	assert(config.immutable);
	assert(
		api.spec.template.spec.volumes.some(
			(volume) => volume.secret?.secretName === config.metadata.name,
		),
	);
	assert.equal(
		documents.filter((resource) => resource.kind === "Job").length,
		2,
	);
	const worker = documents.find(
		(resource) =>
			resource.kind === "Deployment" &&
			resource.metadata.name === "agent-infra-worker",
	);
	assert(
		worker.spec.template.spec.containers[0].env.some(
			(entry) => entry.name === "PLATFORM_WORKER_FILE_EXCHANGE_ORIGIN",
		),
	);
	const next = structuredClone(values);
	next.configuration.api["configuration.mjs"] = b64(
		"export const fixture = 2;",
	);
	const nextDocuments = render(next);
	const nextConfig = nextDocuments.find(
		(resource) =>
			resource.kind === "Secret" &&
			resource.metadata.name.startsWith("agent-infra-api-configuration-"),
	);
	assert.notEqual(config.metadata.name, nextConfig.metadata.name);
	const workerConfig = (resources) =>
		resources.find(
			(resource) =>
				resource.kind === "Secret" &&
				resource.metadata.name.startsWith("agent-infra-worker-configuration-"),
		);
	assert.equal(
		workerConfig(documents).metadata.name,
		workerConfig(nextDocuments).metadata.name,
	);
	assert.equal(
		documents.find((resource) => resource.kind === "ImageCache").spec.images[0],
		image,
	);
});

test("executor approvals require an explicit environment allowlist", () => {
	const values = productionChartValues();
	values.worker = {
		executorInstanceStartupApprovals: [
			{
				schemaVersion: 2,
				imageDigest: `ghcr.io/agoraio-extensions/agent-infra/agent-runtime-pi@sha256:${"b".repeat(64)}`,
				verificationRef: "fixture:verified",
			},
		],
	};
	const result = renderAckChart(values);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /environment approval allowlist/);
});

for (const [key, limit] of [
	["extraImages", 25],
	["groups", 82],
] as const) {
	test(`ImageCache ${key} supports the retained production set and rejects overflow`, () => {
		const references = Array.from(
			{ length: limit + 1 },
			(_, index) =>
				`registry.example.test/retained@sha256:${index.toString(16).padStart(64, "0")}`,
		);
		const entries =
			key === "groups"
				? references.map((reference) => [reference, image])
				: references;
		render({
			imageCaches: { enabled: true, [key]: entries.slice(0, limit) },
		});
		const overflow = renderAckChart({
			imageCaches: { enabled: true, [key]: entries },
		});
		assert.notEqual(overflow.status, 0);
		assert.match(overflow.stderr, /maxItems/);
	});
}

test("retained ImageCache groups preserve the old Worker group across an upgrade", () => {
	const template = image;
	const oldWorker = image.replace("/image@", "/old-worker@");
	const newWorker = image.replace("/image@", "/new-worker@");
	const oldGroup = [template, oldWorker];
	const caches = (worker: string, retainedGroups: string[][]) =>
		render({
			agentVersion: "1.0.0",
			skillHub: { enabled: true, scannerImage: image },
			imageCaches: {
				enabled: true,
				groups: [[template, worker]],
				retainedGroups,
			},
		}).filter((resource) => resource.kind === "ImageCache");
	const existing = caches(oldWorker, []);
	assert.equal(existing.length, 1);
	assert.deepEqual(caches(oldWorker, [oldGroup]), existing);
	const upgraded = caches(newWorker, [oldGroup]);
	assert.equal(upgraded.length, 2);
	assert.deepEqual(
		upgraded.find((cache) => cache.metadata.name === existing[0].metadata.name),
		existing[0],
	);
	assert(upgraded.some((cache) => cache.spec.images[1] === newWorker));
});

test("explicit ImageCache groups have a separate finite budget and require immutable distinct images", () => {
	const groups = Array.from({ length: 21 }, (_, index) => [
		image,
		image.replace("/image@", `/worker-${index}@`),
	]);
	const result = (retainedGroups: string[][]) =>
		renderAckChart({
			imageCaches: { enabled: true, retainedGroups },
		});
	const boundary = result(groups.slice(0, 20));
	assert.equal(boundary.status, 0, boundary.stderr);
	assert.equal(boundary.stdout.match(/^kind: ImageCache$/gm)?.length, 20);
	for (const invalid of [
		groups,
		[[image]],
		[[image, image]],
		[[image, "registry.example.test/worker:latest"]],
	]) {
		const rejected = result(invalid);
		assert.notEqual(rejected.status, 0);
		assert.match(rejected.stderr, /retainedGroups/);
	}
});
