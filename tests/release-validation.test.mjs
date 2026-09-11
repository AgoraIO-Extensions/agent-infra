import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	access,
	chmod,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parse, stringify } from "yaml";

const repositoryRoot = resolve(import.meta.dirname, "..");
const validator = resolve(repositoryRoot, "deploy/release/validate.mjs");
const imageKeys = ["web", "platformApi", "platformWorker", "runtimeHost"];

function validate(fixture, args, environment = {}) {
	return spawnSync(process.execPath, [validator, ...args], {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_BIN: fixture.git,
			MIGRATION_CHECK_BIN: fixture.migrationCheck,
			MIGRATION_CHECK_MARKER: fixture.migrationCheckMarker,
			...environment,
		},
	});
}

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "agent-infra-release-"));
	const values = parse(
		await readFile(
			resolve(repositoryRoot, "deploy/helm/agent-infra/values.yaml"),
			"utf8",
		),
	);
	values.platformWorker.deploymentModule =
		"file:///app/deployment/platform-worker.mjs";
	const images = {};
	for (const [index, key] of imageKeys.entries()) {
		const digest = `sha256:${String(index + 1).repeat(64)}`;
		values.images[key].digest = digest;
		images[key] = { ...values.images[key], digest };
	}
	const manifest = {
		schemaVersion: 1,
		commitSha: "1".repeat(40),
		platform: "linux/amd64",
		images,
	};
	const git = join(directory, "git.mjs");
	const gitDriftMarker = join(directory, "git-drift");
	const helm = join(directory, "helm.mjs");
	const helmMarker = join(directory, "helm.log");
	const migrationCheck = join(directory, "migration-check.mjs");
	const migrationCheckMarker = join(directory, "migration-check.log");
	const manifestPath = join(directory, "images.json");
	const valuesPath = join(directory, "values.yaml");
	await writeFile(
		git,
		`#!/usr/bin/env node
import { existsSync } from "node:fs";
const command = process.argv[2];
if (command === "status") {
  if (existsSync(process.env.VALIDATION_GIT_DRIFT_MARKER)) console.log(" M source");
  process.exit(0);
}
if (command === "rev-parse") console.log("${"1".repeat(40)}");
else process.exit(1);
`,
	);
	await chmod(git, 0o755);
	await writeFile(
		helm,
		`#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.HELM_MARKER, args[args.indexOf("--values") + 1] + "\\n");
if (process.env.MUTATE_VALUES_PATH) writeFileSync(process.env.MUTATE_VALUES_PATH, "changed: true\\n");
`,
	);
	await chmod(helm, 0o755);
	await writeFile(
		migrationCheck,
		`#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync(process.env.MIGRATION_CHECK_MARKER, "checked\\n");
if (process.env.MIGRATION_GIT_DRIFT_MARKER) writeFileSync(process.env.MIGRATION_GIT_DRIFT_MARKER, "drift");
if (process.env.MIGRATION_CHECK_FAIL) process.exit(1);
`,
	);
	await chmod(migrationCheck, 0o755);
	await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
	await writeFile(valuesPath, stringify(values));
	return {
		directory,
		git,
		gitDriftMarker,
		helm,
		helmMarker,
		manifest,
		manifestPath,
		migrationCheck,
		migrationCheckMarker,
		values,
		valuesPath,
	};
}

test("release validation accepts only matching immutable image references", async () => {
	const release = await fixture();
	try {
		const valid = validate(release, [
			"release",
			release.manifestPath,
			release.valuesPath,
		]);
		assert.equal(valid.status, 0, valid.stderr);

		release.values.images.platformWorker.digest = `sha256:${"f".repeat(64)}`;
		await writeFile(release.valuesPath, stringify(release.values));
		const mismatch = validate(release, [
			"release",
			release.manifestPath,
			release.valuesPath,
		]);
		assert.notEqual(mismatch.status, 0);
		assert.match(mismatch.stderr, /platformWorker image does not match/);
	} finally {
		await rm(release.directory, { recursive: true, force: true });
	}
});

test("validation freezes values and rejects input drift", async () => {
	const valuesDrift = await fixture();
	try {
		const result = validate(
			valuesDrift,
			["release", valuesDrift.manifestPath, valuesDrift.valuesPath],
			{
				HELM_BIN: valuesDrift.helm,
				HELM_MARKER: valuesDrift.helmMarker,
				MUTATE_VALUES_PATH: valuesDrift.valuesPath,
			},
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /release values changed during validation/);
		const frozenPaths = (await readFile(valuesDrift.helmMarker, "utf8"))
			.trim()
			.split("\n");
		assert.equal(new Set(frozenPaths).size, 1);
		assert.notEqual(frozenPaths[0], valuesDrift.valuesPath);
		await assert.rejects(access(frozenPaths[0]));
	} finally {
		await rm(valuesDrift.directory, { recursive: true, force: true });
	}

	const checkoutDrift = await fixture();
	try {
		const result = validate(
			checkoutDrift,
			["migration", checkoutDrift.manifestPath, checkoutDrift.valuesPath],
			{
				MIGRATION_GIT_DRIFT_MARKER: checkoutDrift.gitDriftMarker,
				VALIDATION_GIT_DRIFT_MARKER: checkoutDrift.gitDriftMarker,
			},
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /checkout does not match image manifest/);
	} finally {
		await rm(checkoutDrift.directory, { recursive: true, force: true });
	}
});

test("migration validation fails closed before deployment", async () => {
	const release = await fixture();
	try {
		const valid = validate(release, [
			"migration",
			release.manifestPath,
			release.valuesPath,
		]);
		assert.equal(valid.status, 0, valid.stderr);

		release.manifest.commitSha = "3".repeat(40);
		await writeFile(
			release.manifestPath,
			`${JSON.stringify(release.manifest)}\n`,
		);
		const wrongCommit = validate(release, [
			"migration",
			release.manifestPath,
			release.valuesPath,
		]);
		assert.notEqual(wrongCommit.status, 0);
		assert.match(wrongCommit.stderr, /checkout does not match image manifest/);
		release.manifest.commitSha = "1".repeat(40);
		await writeFile(
			release.manifestPath,
			`${JSON.stringify(release.manifest)}\n`,
		);

		release.values.migration.enabled = false;
		await writeFile(release.valuesPath, stringify(release.values));
		const disabled = validate(release, [
			"migration",
			release.manifestPath,
			release.valuesPath,
		]);
		assert.notEqual(disabled.status, 0);
		assert.match(disabled.stderr, /migration must be enabled/);

		release.values.migration.enabled = true;
		release.values.unknown = true;
		await writeFile(release.valuesPath, stringify(release.values));
		const unknown = validate(release, [
			"migration",
			release.manifestPath,
			release.valuesPath,
		]);
		assert.notEqual(unknown.status, 0);
		assert.match(unknown.stderr, /Helm lint failed/);
	} finally {
		await rm(release.directory, { recursive: true, force: true });
	}
});

test("rollback validation accepts only a distinct immutable release without migrations", async () => {
	const release = await fixture();
	try {
		const currentManifestPath = join(release.directory, "current-images.json");
		const currentManifest = structuredClone(release.manifest);
		currentManifest.commitSha = "2".repeat(40);
		for (const [index, key] of imageKeys.entries()) {
			currentManifest.images[key].digest =
				`sha256:${String(index + 5).repeat(64)}`;
		}
		await writeFile(
			currentManifestPath,
			`${JSON.stringify(currentManifest)}\n`,
		);
		release.values.migration.enabled = false;
		await writeFile(release.valuesPath, stringify(release.values));

		const valid = validate(release, [
			"rollback",
			currentManifestPath,
			release.manifestPath,
			release.valuesPath,
		]);
		assert.equal(valid.status, 0, valid.stderr);
		assert.equal(
			await readFile(release.migrationCheckMarker, "utf8"),
			"checked\n",
		);

		const driftedMigrations = validate(
			release,
			[
				"rollback",
				currentManifestPath,
				release.manifestPath,
				release.valuesPath,
			],
			{ MIGRATION_CHECK_FAIL: "1" },
		);
		assert.notEqual(driftedMigrations.status, 0);
		assert.match(
			driftedMigrations.stderr,
			/Platform migration drift check failed/,
		);

		release.values.migration.enabled = true;
		await writeFile(release.valuesPath, stringify(release.values));
		const migrates = validate(release, [
			"rollback",
			currentManifestPath,
			release.manifestPath,
			release.valuesPath,
		]);
		assert.notEqual(migrates.status, 0);
		assert.match(migrates.stderr, /rollback migration must be disabled/);

		const sameRelease = validate(release, [
			"rollback",
			release.manifestPath,
			release.manifestPath,
			release.valuesPath,
		]);
		assert.notEqual(sameRelease.status, 0);
		assert.match(
			sameRelease.stderr,
			/rollback target must be a different release/,
		);
	} finally {
		await rm(release.directory, { recursive: true, force: true });
	}
});
