#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "yaml";

import { runCommand } from "./run-command.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const chart = resolve(repositoryRoot, "deploy/helm/agent-infra");
const imageKeys = ["web", "platformApi", "platformWorker", "runtimeHost"];
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const placeholderDigest = `sha256:${"0".repeat(64)}`;
const timeoutMs = {
	git: 30_000,
	helm: 2 * 60_000,
	migration: 5 * 60_000,
};

function fail(message) {
	throw new Error(message);
}

function expectKeys(value, keys, name) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		fail(`${name} must be an object`);
	}
	const actual = Object.keys(value).toSorted();
	const expected = [...keys].toSorted();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		fail(`${name} has invalid fields`);
	}
}

function validateManifest(manifest) {
	expectKeys(
		manifest,
		["schemaVersion", "commitSha", "platform", "images"],
		"image manifest",
	);
	if (manifest.schemaVersion !== 1) fail("image manifest version is invalid");
	if (!/^[a-f0-9]{40}$/.test(manifest.commitSha)) {
		fail("image manifest commit SHA is invalid");
	}
	if (!/^linux\/(?:amd64|arm64)$/.test(manifest.platform)) {
		fail("image manifest platform is invalid");
	}
	expectKeys(manifest.images, imageKeys, "image manifest images");
	for (const key of imageKeys) {
		const image = manifest.images[key];
		expectKeys(image, ["repository", "digest"], `${key} image`);
		if (typeof image.repository !== "string" || image.repository.length === 0) {
			fail(`${key} image repository is invalid`);
		}
		if (!digestPattern.test(image.digest) || image.digest === placeholderDigest) {
			fail(`${key} image digest is invalid`);
		}
	}
}

function validateImageReferences(manifest, values) {
	for (const key of imageKeys) {
		const configured = values?.images?.[key];
		if (
			configured?.repository !== manifest.images[key].repository ||
			configured?.digest !== manifest.images[key].digest
		) {
			fail(`${key} image does not match the immutable build manifest`);
		}
	}
}

function validateCheckout(commitSha) {
	const git = process.env.GIT_BIN ?? "git";
	const head = runCommand(git, ["rev-parse", "HEAD"], {
		cwd: repositoryRoot,
		name: "Git HEAD validation",
		timeoutMs: timeoutMs.git,
	});
	const status = runCommand(
		git,
		["status", "--porcelain", "--untracked-files=all"],
		{
			cwd: repositoryRoot,
			name: "Git status validation",
			timeoutMs: timeoutMs.git,
		},
	);
	if (head !== commitSha || status) {
		fail("checkout does not match image manifest");
	}
}

function validateHelm(valuesPath) {
	const helm = process.env.HELM_BIN ?? "helm";
	runCommand(helm, ["lint", chart, "--values", valuesPath, "--strict"], {
		cwd: repositoryRoot,
		name: "Helm lint",
		timeoutMs: timeoutMs.helm,
	});
	runCommand(
		helm,
		["template", "release-validation", chart, "--values", valuesPath],
		{
			cwd: repositoryRoot,
			name: "Helm render",
			timeoutMs: timeoutMs.helm,
		},
	);
}

function validateMigrations() {
	const configured = process.env.MIGRATION_CHECK_BIN;
	runCommand(
		configured ?? process.execPath,
		configured
			? []
			: [
					resolve(
						repositoryRoot,
						"packages/platform-store/src/check-migrations.mjs",
					),
				],
		{
			cwd: repositoryRoot,
			name: "Platform migration drift check",
			timeoutMs: timeoutMs.migration,
		},
	);
}

async function readJson(path, name) {
	try {
		return JSON.parse(await readFile(resolve(path), "utf8"));
	} catch {
		fail(`${name} is invalid`);
	}
}

async function readValues(path) {
	try {
		return parse(await readFile(resolve(path), "utf8"));
	} catch {
		fail("release values are invalid");
	}
}

async function main() {
	const [action, ...args] = process.argv.slice(2);
	if (action === "rollback") {
		const [currentManifestPath, targetManifestPath, valuesPath, ...extra] = args;
		if (
			!currentManifestPath ||
			!targetManifestPath ||
			!valuesPath ||
			extra.length > 0
		) {
			fail(
				"usage: validate.mjs rollback <current-image-manifest.json> <target-image-manifest.json> <target-values.yaml>",
			);
		}
		const currentManifest = await readJson(
			currentManifestPath,
			"current image manifest",
		);
		const targetManifest = await readJson(
			targetManifestPath,
			"target image manifest",
		);
		const values = await readValues(valuesPath);
		validateManifest(currentManifest);
		validateManifest(targetManifest);
		validateCheckout(targetManifest.commitSha);
		if (currentManifest.commitSha === targetManifest.commitSha) {
			fail("rollback target must be a different release");
		}
		validateImageReferences(targetManifest, values);
		if (values?.migration?.enabled !== false) {
			fail("rollback migration must be disabled");
		}
		validateHelm(resolve(valuesPath));
		validateMigrations();
		console.info("rollback validation passed");
		return;
	}

	const [manifestPath, valuesPath, ...extra] = args;
	if (
		!["migration", "release"].includes(action) ||
		!manifestPath ||
		!valuesPath ||
		extra.length > 0
	) {
		fail(
			"usage: validate.mjs <release|migration> <image-manifest.json> <values.yaml>",
		);
	}
	const manifest = await readJson(manifestPath, "image manifest");
	const values = await readValues(valuesPath);
	validateManifest(manifest);
	validateCheckout(manifest.commitSha);
	validateImageReferences(manifest, values);
	if (values?.migration?.enabled !== true) {
		fail(`${action} migration must be enabled`);
	}
	validateHelm(resolve(valuesPath));
	validateMigrations();
	console.info(`${action} validation passed`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : "release validation failed");
	process.exitCode = 1;
});
