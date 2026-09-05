import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parse, stringify } from "yaml";

const repositoryRoot = resolve(import.meta.dirname, "..");
const validator = resolve(repositoryRoot, "deploy/release/validate.mjs");
const imageKeys = ["web", "platformApi", "platformWorker", "runtimeHost"];

function validate(...args) {
	return spawnSync(process.execPath, [validator, ...args], {
		cwd: repositoryRoot,
		encoding: "utf8",
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
	const manifestPath = join(directory, "images.json");
	const valuesPath = join(directory, "values.yaml");
	await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
	await writeFile(valuesPath, stringify(values));
	return { directory, manifest, manifestPath, values, valuesPath };
}

test("release validation accepts only matching immutable image references", async () => {
	const release = await fixture();
	try {
		const valid = validate("release", release.manifestPath, release.valuesPath);
		assert.equal(valid.status, 0, valid.stderr);

		release.values.images.platformWorker.digest = `sha256:${"f".repeat(64)}`;
		await writeFile(release.valuesPath, stringify(release.values));
		const mismatch = validate(
			"release",
			release.manifestPath,
			release.valuesPath,
		);
		assert.notEqual(mismatch.status, 0);
		assert.match(mismatch.stderr, /platformWorker image does not match/);
	} finally {
		await rm(release.directory, { recursive: true, force: true });
	}
});

test("migration validation fails closed before deployment", async () => {
	const release = await fixture();
	try {
		const valid = validate(
			"migration",
			release.manifestPath,
			release.valuesPath,
		);
		assert.equal(valid.status, 0, valid.stderr);

		release.values.migration.enabled = false;
		await writeFile(release.valuesPath, stringify(release.values));
		const disabled = validate(
			"migration",
			release.manifestPath,
			release.valuesPath,
		);
		assert.notEqual(disabled.status, 0);
		assert.match(disabled.stderr, /migration must be enabled/);

		release.values.migration.enabled = true;
		release.values.unknown = true;
		await writeFile(release.valuesPath, stringify(release.values));
		const unknown = validate(
			"migration",
			release.manifestPath,
			release.valuesPath,
		);
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

		const valid = validate(
			"rollback",
			currentManifestPath,
			release.manifestPath,
			release.valuesPath,
		);
		assert.equal(valid.status, 0, valid.stderr);

		release.values.migration.enabled = true;
		await writeFile(release.valuesPath, stringify(release.values));
		const migrates = validate(
			"rollback",
			currentManifestPath,
			release.manifestPath,
			release.valuesPath,
		);
		assert.notEqual(migrates.status, 0);
		assert.match(migrates.stderr, /rollback migration must be disabled/);

		const sameRelease = validate(
			"rollback",
			release.manifestPath,
			release.manifestPath,
			release.valuesPath,
		);
		assert.notEqual(sameRelease.status, 0);
		assert.match(
			sameRelease.stderr,
			/rollback target must be a different release/,
		);
	} finally {
		await rm(release.directory, { recursive: true, force: true });
	}
});
