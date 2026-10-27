import assert from "node:assert/strict";
import test from "node:test";
import {
	freshDatabaseAccounts,
	freshDatabaseValues,
	sanitizeValues,
} from "../deploy/ack/capture-inputs.ts";

const installationId = "22222222-2222-2222-2222-222222222222";

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
