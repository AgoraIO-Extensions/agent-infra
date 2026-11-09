import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parse, parseAllDocuments, stringify } from "yaml";
import {
	assertCaptureDestination,
	capturedValues,
	freshDatabaseAccounts,
	freshDatabaseValues,
	sanitizeValues,
} from "../deploy/ack/capture-inputs.ts";

const installationId = "22222222-2222-2222-2222-222222222222";

test("capture destination must be outside the source worktree", () => {
	assert.throws(
		() => assertCaptureDestination(import.meta.dirname),
		/CAPTURE_DIRECTORY_MUST_BE_OUTSIDE_GIT/,
	);
});

test("capture sanitizes legacy values rejected by the current chart schema", () => {
	const value = sanitizeValues(
		{
			encryption: { keyVersion: "key-v1", currentKeyVersion: "key-v0" },
			worker: { keyVersions: "key-v1", workerKeyVersions: "key-v0" },
			images: { web: "web@sha256:abc" },
		},
		{
			type: "object",
			properties: {
				encryption: {
					type: "object",
					additionalProperties: false,
					properties: { keyVersion: { type: "string" } },
				},
				worker: {
					type: "object",
					additionalProperties: false,
					properties: { keyVersions: { type: "string" } },
				},
				images: { type: "object", additionalProperties: true },
			},
		},
	);
	assert.deepEqual(value.encryption, { keyVersion: "key-v1" });
	assert.deepEqual(value.worker, { keyVersions: "key-v1" });
	assert.equal(value.images.web, "web@sha256:abc");
});

test("capture restores nested null deletions without replacing resolved values or mutating inputs", () => {
	const resolved = {
		parent: { keep: "resolved", deleted: {}, items: [null, { value: null }] },
	};
	const overrides = {
		parent: { keep: "user", deleted: { key: null }, missing: { key: null } },
	};
	const before = structuredClone(resolved);
	const rawBefore = structuredClone(overrides);
	const value = capturedValues(resolved, overrides, { type: "object" });
	assert.deepEqual(value, {
		parent: {
			keep: "resolved",
			deleted: { key: null },
			missing: { key: null },
			items: [null, { value: null }],
		},
	});
	assert.deepEqual(resolved, before);
	assert.deepEqual(overrides, rawBefore);
});

test("capture keeps schema-rejected legacy null overrides out of the result", () => {
	const schema = {
		type: "object",
		additionalProperties: false,
		properties: {
			encryption: {
				type: "object",
				additionalProperties: false,
				properties: { keyVersion: { type: "string" } },
			},
		},
	};
	const value = capturedValues(
		{ encryption: { keyVersion: "active", currentKeyVersion: "legacy" } },
		{
			encryption: { keyVersion: null, currentKeyVersion: null },
			removed: null,
		},
		schema,
	);
	assert.deepEqual(value, { encryption: { keyVersion: null } });
});

test("capture refuses a scalar/map conflict instead of replacing an effective value", () => {
	assert.throws(
		() =>
			capturedValues(
				{ value: "resolved" },
				{ value: { key: null } },
				{ type: "object" },
			),
		/CAPTURE_NULL_OVERRIDE_SHAPE_CONFLICT/u,
	);
});

test("captured reuse and fresh values preserve the original Worker selector through real Helm coalescing", (t) => {
	const available = spawnSync("helm", ["version", "--short"], {
		encoding: "utf8",
	});
	if (available.error?.code === "ENOENT") {
		t.skip(
			"Helm is required for the render round-trip; pure capture tests still run",
		);
		return;
	}
	assert.equal(available.status, 0, available.stderr);
	const chart = resolve(import.meta.dirname, "../deploy/ack/chart");
	const schema = JSON.parse(
		readFileSync(resolve(chart, "values.schema.json"), "utf8"),
	);
	const resolved = parse(readFileSync(resolve(chart, "values.yaml"), "utf8"));
	const nodeSelector = resolved.scheduling.worker.nodeSelector;
	assert.equal(nodeSelector.type, "virtual-kubelet");
	nodeSelector["alibabacloud.com/nodepool-id"] = "synthetic-ecs-pool";
	delete nodeSelector.type;
	const overrides = {
		scheduling: {
			worker: {
				nodeSelector: {
					type: null,
					"alibabacloud.com/nodepool-id": "synthetic-ecs-pool",
				},
			},
		},
	};
	const render = (values) => {
		const result = spawnSync(
			"helm",
			[
				"template",
				"capture-null-test",
				chart,
				"--namespace",
				"capture-null-test",
				"--kube-version",
				"1.36.1",
				"--values",
				"-",
			],
			{ input: stringify(values), encoding: "utf8", maxBuffer: 2 ** 20 },
		);
		assert.equal(result.status, 0, result.stderr);
		const documents = parseAllDocuments(result.stdout).map((d) => d.toJSON());
		return documents.find(
			(d) =>
				d?.kind === "Deployment" && d.metadata.name === "agent-infra-worker",
		).spec.template.spec.nodeSelector;
	};
	const original = render(overrides);
	assert.equal(Object.hasOwn(original, "type"), false);
	assert.equal(
		render(sanitizeValues(resolved, schema)).type,
		"virtual-kubelet",
	);
	const captured = capturedValues(resolved, overrides, schema);
	assert.equal(captured.scheduling.worker.nodeSelector.type, null);
	assert.deepEqual(render(captured), original);
	assert.deepEqual(
		render(freshDatabaseValues(captured, installationId)),
		original,
	);
});

test("fresh values enable the database-only bootstrap contract", () => {
	const values = freshDatabaseValues(
		{
			bootstrap: { databaseOnly: false },
			migrations: { enabled: false },
			postgres: { enabled: false },
		},
		installationId,
	);
	assert.deepEqual(values.bootstrap, { databaseOnly: false });
	assert.equal(values.migrations.enabled, true);
	assert.deepEqual(values.postgres, {
		enabled: true,
		adminUser: "agent_infra_admin",
		initialDatabase: "postgres",
		adminSecret: "agent-infra-postgres-admin",
		initializationSecret: "agent-infra-postgres-initialization",
		bootstrapInstallationId: installationId,
	});
});

test("fresh database accounts produce three isolated roles and two databases", () => {
	const result = freshDatabaseAccounts("agent-infra");
	const roles = [
		result.accounts.platform.role,
		result.accounts.directory.role,
		result.accounts.migration.role,
	];
	assert.equal(new Set(roles).size, 3);
	assert.notEqual(
		result.accounts.platform.database,
		result.accounts.directory.database,
	);
	for (const url of Object.values(result.urls)) {
		const parsed = new URL(url);
		assert.equal(
			parsed.hostname,
			"agent-infra-postgres.agent-infra.svc.cluster.local",
		);
		assert.equal(parsed.port, "5432");
		assert.match(parsed.password, /^[A-Za-z0-9._~-]{16,256}$/u);
	}
});
