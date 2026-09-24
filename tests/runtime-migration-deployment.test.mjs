import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseAllDocuments } from "yaml";

const chart = "deploy/helm/runtime-legacy-migration";
const digest = `sha256:${"a".repeat(64)}`;
const values = {
	image: { digest },
	mode: "candidate",
	dataClaim: "original-data",
	candidateClaim: "migration-output",
	issuer: "platform-fixture",
	binding: {
		workerId: "worker-fixture",
		agentId: "agent-fixture",
		workloadRevision: 7,
		fence: 3,
		imageDigest: `sha256:${"b".repeat(64)}`,
	},
	trust: {
		keyId: "migration-key",
		manifest: { name: "migration-manifest" },
		publicKey: { name: "migration-public-key" },
	},
};

function render(...args) {
	return spawnSync(
		"helm",
		[
			"template",
			"migration-fixture",
			chart,
			"--namespace",
			"migration-fixture",
			"--values",
			"-",
			...args,
		],
		{ encoding: "utf8", input: JSON.stringify(values) },
	);
}

function migrationJobName({ dataClaim, candidateClaim, mode }) {
	const suffix = createHash("sha256")
		.update(`${dataClaim}|${candidateClaim}|${mode}`)
		.digest("hex")
		.slice(0, 12);
	return `migration-fixture-${suffix}`;
}

function renderedJob(result) {
	return parseAllDocuments(result.stdout)
		.map((doc) => doc.toJSON())
		.find((item) => item.kind === "Job");
}

test("migration chart runs the real offline CLI with ordinary trust files and retained evidence", () => {
	const result = render();
	assert.equal(result.status, 0, result.stderr);
	const resources = parseAllDocuments(result.stdout).map((doc) => doc.toJSON());
	assert.equal(resources.length, 2);
	const job = resources.find((item) => item.kind === "Job");
	const policy = resources.find((item) => item.kind === "NetworkPolicy");
	assert.ok(job);
	assert.ok(policy);
	assert.equal(job.metadata.name, migrationJobName(values));
	assert.ok(job.metadata.name.length <= 63);
	assert.equal(job.metadata.annotations?.["helm.sh/hook"], undefined);
	assert.equal(job.spec.backoffLimit, 0);
	assert.equal(job.spec.ttlSecondsAfterFinished, undefined);
	const pod = job.spec.template.spec;
	assert.equal(pod.restartPolicy, "Never");
	assert.equal(pod.automountServiceAccountToken, false);
	assert.equal(pod.securityContext.runAsUser, 1000);
	assert.equal(pod.securityContext.fsGroup, undefined);
	assert.equal(pod.initContainers, undefined);
	assert.equal(pod.containers.length, 1);
	const container = pod.containers[0];
	assert.deepEqual(container.command, [
		"/usr/local/bin/node",
		"--disable-sigusr1",
		"/app/dist/legacy-migration-cli.mjs",
	]);
	assert.ok(container.image.endsWith(`@${digest}`));
	assert.equal(container.securityContext.readOnlyRootFilesystem, true);
	assert.equal(container.securityContext.allowPrivilegeEscalation, false);
	assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
	assert.equal(container.envFrom, undefined);
	const environment = Object.fromEntries(
		container.env.map(({ name, value }) => [name, value]),
	);
	assert.equal(
		environment.AGENT_INFRA_RUNTIME_LEGACY_BOOTSTRAP_MODE,
		"candidate",
	);
	assert.equal(
		environment.AGENT_INFRA_RUNTIME_LEGACY_MIGRATION_TRUST_ROOT_UID,
		"0",
	);
	assert.deepEqual(
		JSON.parse(environment.AGENT_INFRA_RUNTIME_READINESS_BINDING),
		values.binding,
	);
	assert.equal(container.env.length, 10);
	for (const [name, path, secretName] of [
		["manifest", "manifest.json", "migration-manifest"],
		["public-key", "public.pem", "migration-public-key"],
	]) {
		const mount = container.volumeMounts.find((item) => item.name === name);
		const volume = pod.volumes.find((item) => item.name === name);
		assert.equal(mount.mountPath, `/etc/agent-infra/legacy-migration/${path}`);
		assert.equal(mount.subPath, path);
		assert.equal(mount.readOnly, true);
		assert.equal(volume.secret.secretName, secretName);
		assert.equal(volume.secret.defaultMode, 0o444);
		assert.deepEqual(volume.secret.items, [{ key: path, path }]);
	}
	for (const [name, claimName] of [
		["data", "original-data"],
		["candidate", "migration-output"],
	]) {
		const volume = pod.volumes.find((item) => item.name === name);
		assert.deepEqual(volume.persistentVolumeClaim, { claimName });
	}
	assert.deepEqual(
		policy.spec.podSelector.matchLabels,
		job.spec.template.metadata.labels,
	);
	assert.deepEqual(policy.spec.policyTypes, ["Ingress", "Egress"]);
	assert.deepEqual(policy.spec.ingress, []);
	assert.deepEqual(policy.spec.egress, []);
});

test("migration input changes create a distinct Job instead of reusing a completed one", () => {
	const candidate = render("--set", "candidateClaim=another-migration-output");
	assert.equal(candidate.status, 0, candidate.stderr);
	const candidateJob = renderedJob(candidate);
	assert.ok(candidateJob);
	assert.equal(
		candidateJob.metadata.name,
		migrationJobName({
			...values,
			candidateClaim: "another-migration-output",
		}),
	);
	assert.notEqual(candidateJob.metadata.name, migrationJobName(values));

	const offlineCommit = render("--set", "mode=offline-commit");
	assert.equal(offlineCommit.status, 0, offlineCommit.stderr);
	const offlineJob = renderedJob(offlineCommit);
	assert.ok(offlineJob);
	assert.equal(
		offlineJob.metadata.name,
		migrationJobName({ ...values, mode: "offline-commit" }),
	);
	assert.notEqual(offlineJob.metadata.name, candidateJob.metadata.name);
});

test("offline commit is explicit and cannot add process input or weaken trust mounts", () => {
	const commit = render("--set", "mode=offline-commit");
	assert.equal(commit.status, 0, commit.stderr);
	assert.match(commit.stdout, /value: "offline-commit"/);
	for (const [option, value] of [
		["mode", "online-commit"],
		["image.digest", "latest"],
		["binding.imageDigest", `sha256:${"0".repeat(64)}`],
		["binding.workerId", ""],
		["binding.fence", "0"],
		["binding.extra", "injected"],
		["trust.manifest.name", ""],
		["trust.publicKey.key", "../public.pem"],
		["trust.rootUid", "1000"],
		["candidateClaim", "original-data"],
		["command", "injected"],
		["environment.LD_PRELOAD", "/tmp/preload.so"],
	]) {
		const result = render("--set", `${option}=${value}`);
		assert.notEqual(result.status, 0, `${option} was accepted`);
	}
	const defaults = spawnSync("helm", ["template", "migration-fixture", chart], {
		encoding: "utf8",
	});
	assert.notEqual(defaults.status, 0, "unconfigured migration must not render");
});
