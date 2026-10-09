import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	imageUpdates,
	shanghai,
	validatePublishedRun,
	validateRuntime,
	validateTarget,
} from "../deploy/connection-shanghai-release.mjs";

function runtime() {
	return {
		api: {
			metadata: { name: "connection-api" },
			spec: {
				replicas: 1,
				strategy: { type: "Recreate" },
				template: {
					spec: {
						containers: [
							{
								name: "api",
								env: [
									{
										name: "DATABASE_URL",
										valueFrom: {
											secretKeyRef: {
												name: shanghai.databaseSecret,
												key: "DATABASE_URL",
											},
										},
									},
									{ name: "NODE_EXTRA_CA_CERTS", value: shanghai.caPath },
								],
								volumeMounts: [
									{
										name: "rds-ca",
										mountPath: "/etc/connection-rds",
										readOnly: true,
									},
								],
							},
						],
						volumes: [
							{ name: "rds-ca", configMap: { name: shanghai.caConfigMap } },
						],
						nodeSelector: { "kubernetes.io/hostname": "fixture-node" },
					},
				},
			},
		},
		web: {
			metadata: { name: "connection-web" },
			spec: {
				replicas: 1,
				template: { spec: { containers: [{ name: "web" }] } },
			},
		},
		database: {
			data: {
				DATABASE_URL: Buffer.from(
					`postgresql://agent_infra@${shanghai.databaseHost}:5432/agent_connector?sslmode=verify-full`,
				).toString("base64"),
			},
		},
		config: { metadata: { name: "connection-config" } },
		ca: {
			data: {
				"ApsaraDB-CA-Chain.pem":
					"-----BEGIN CERTIFICATE-----\npublic-test-placeholder",
			},
		},
	};
}

function checkRuntime(value) {
	validateRuntime(value.api, value.web, value.database, value.config, value.ca);
}

test("wrong context/server, TLS bypass and incompatible kubectl are rejected", () => {
	const config = { clusters: [{ cluster: { server: shanghai.server } }] };
	const versions = {
		clientVersion: { major: "1", minor: "34" },
		serverVersion: { major: "1", minor: "34+" },
	};
	const namespace = {
		metadata: { name: shanghai.namespace },
		status: { phase: "Active" },
	};
	assert.doesNotThrow(() => validateTarget(config, versions, namespace));
	assert.throws(
		() =>
			validateTarget(
				{
					clusters: [{ cluster: { server: "https://wrong-cluster.invalid" } }],
				},
				versions,
				namespace,
			),
		/Wrong cluster/,
	);
	config.clusters[0].cluster["insecure-skip-tls-verify"] = true;
	assert.throws(
		() => validateTarget(config, versions, namespace),
		/TLS verification/,
	);
	delete config.clusters[0].cluster["insecure-skip-tls-verify"];
	assert.throws(
		() =>
			validateTarget(
				config,
				{ ...versions, clientVersion: { major: "1", minor: "27" } },
				namespace,
			),
		/kubectl/,
	);
	assert.throws(
		() =>
			validateTarget(config, versions, {
				...namespace,
				metadata: { name: "other-namespace" },
			}),
		/namespace/,
	);
});

test("release inspection preserves runtime configuration and updates only image assignments", () => {
	const value = runtime();
	const before = structuredClone(value);
	checkRuntime(value);
	assert.deepEqual(value, before);
	assert.deepEqual(imageUpdates("connection-v9.8.7"), [
		{
			deployment: "connection-api",
			container: "api",
			image:
				"ghcr.io/agoraio-extensions/agent-infra/connection-api:connection-v9.8.7",
		},
		{
			deployment: "connection-web",
			container: "web",
			image:
				"ghcr.io/agoraio-extensions/agent-infra/connection-web:connection-v9.8.7",
		},
	]);
	assert.throws(() => imageUpdates("latest"), /canonical/);
});

test("old database, non-strict TLS and missing CA mount are rejected", () => {
	let value = runtime();
	value.api.spec.template.spec.containers[0].env[0].valueFrom.secretKeyRef.name =
		"connection-database";
	assert.throws(() => checkRuntime(value), /Shanghai database Secret/);
	value = runtime();
	value.database.data.DATABASE_URL = Buffer.from(
		"postgresql://agent_infra@old-database.invalid/agent_connector?sslmode=verify-full",
	).toString("base64");
	assert.throws(() => checkRuntime(value), /database identity/);
	value = runtime();
	value.database.data.DATABASE_URL = Buffer.from(
		`postgresql://agent_infra@${shanghai.databaseHost}/agent_connector?sslmode=disable`,
	).toString("base64");
	assert.throws(() => checkRuntime(value), /verify-full/);
	for (const query of [
		"sslmode=verify-full&sslmode=disable",
		"sslmode=verify-full&host=other-database.invalid",
		"sslmode=verify-full&ssl=disable",
	]) {
		value = runtime();
		value.database.data.DATABASE_URL = Buffer.from(
			`postgresql://agent_infra@${shanghai.databaseHost}/agent_connector?${query}`,
		).toString("base64");
		assert.throws(() => checkRuntime(value), /verify-full/);
	}
	value = runtime();
	value.api.spec.template.spec.containers[0].volumeMounts = [];
	assert.throws(() => checkRuntime(value), /CA ConfigMap mount/);
});

test("additional writers, rolling API replacement and Node TLS bypass are rejected", () => {
	let value = runtime();
	value.api.spec.replicas = 2;
	assert.throws(() => checkRuntime(value), /one writer/);
	value = runtime();
	value.api.spec.strategy.type = "RollingUpdate";
	assert.throws(() => checkRuntime(value), /Recreate/);
	value = runtime();
	value.api.spec.template.spec.containers[0].env.push({
		name: "NODE_TLS_REJECT_UNAUTHORIZED",
		value: "0",
	});
	assert.throws(() => checkRuntime(value), /Node TLS/);
});

test("failed, pending and wrong-head publications cannot authorize deployment", () => {
	assert.doesNotThrow(() =>
		validatePublishedRun(
			{ status: "completed", conclusion: "success", headSha: "fixture-sha" },
			"fixture-sha",
		),
	);
	for (const run of [
		undefined,
		{ status: "in_progress", conclusion: "", headSha: "fixture-sha" },
		{ status: "completed", conclusion: "failure", headSha: "fixture-sha" },
		{ status: "completed", conclusion: "success", headSha: "wrong-sha" },
	]) {
		assert.throws(
			() => validatePublishedRun(run, "fixture-sha"),
			/publication/,
		);
	}
});

test("retired GZ3 command rejects deployment before invoking external tools", () => {
	const result = spawnSync(
		"bash",
		[
			"deploy/connection-gz3-release.sh",
			"connection-v9.8.7",
			"--publish",
			"--deploy",
		],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /GZ3 is retired/);
	assert.equal(result.stdout, "");
});

test("release entry refuses a dirty worktree before publication", () => {
	const directory = mkdtempSync(
		path.join(tmpdir(), "connection-release-test-"),
	);
	try {
		execFileSync("git", ["init", "--quiet", directory]);
		writeFileSync(path.join(directory, "untracked.txt"), "fixture");
		const result = spawnSync(
			"bash",
			[
				path.resolve("deploy/connection-release.sh"),
				"connection-v9.8.7",
				"--publish",
				"--deploy",
			],
			{ cwd: directory, encoding: "utf8" },
		);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /clean release worktree/);
		assert.equal(result.stdout, "");
	} finally {
		rmSync(directory, { recursive: true });
	}
});

test("direct deployment entry requires an explicit kubeconfig", () => {
	const result = spawnSync(
		"node",
		[
			"deploy/connection-shanghai-release.mjs",
			"--deploy",
			"connection-v9.8.7",
			"/missing-test-kubeconfig",
		],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Explicit Shanghai kubeconfig/);
});

test("malformed Kubernetes output cannot leak runtime configuration in errors", () => {
	const directory = mkdtempSync(
		path.join(tmpdir(), "connection-release-test-"),
	);
	try {
		const kubeconfig = path.join(directory, "kubeconfig");
		const kubectl = path.join(directory, "kubectl");
		const marker = "FIXTURE_NOT_A_REAL_CREDENTIAL";
		writeFileSync(kubeconfig, "fixture");
		writeFileSync(kubectl, `#!/bin/sh\nprintf '%s' '${marker}'\n`, {
			mode: 0o700,
		});
		const result = spawnSync(
			"node",
			[
				"deploy/connection-shanghai-release.mjs",
				"--preflight",
				"connection-v9.8.7",
				kubeconfig,
			],
			{
				encoding: "utf8",
				env: { ...process.env, CONNECTION_KUBECTL: kubectl },
			},
		);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /raw exception withheld/);
		assert.equal(result.stderr.includes(marker), false);
	} finally {
		rmSync(directory, { recursive: true });
	}
});
