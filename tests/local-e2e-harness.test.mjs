import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
	corefileWithForwardZones,
	isUsableCa,
	parseDnsForward,
	selectPlatformManifest,
} from "../deploy/local/runtime-material.mjs";

const execFileAsync = promisify(execFile);
const digest = (character) => `sha256:${character.repeat(64)}`;

test("local E2E Harness exposes the staged lifecycle without environment access", async () => {
	const { stdout } = await execFileAsync(process.execPath, [
		"deploy/local/e2e-harness.mjs",
		"help",
	]);
	assert.match(
		stdout,
		/sync\|images\|build\|deploy\|runtime\|verify\|all\|reset/,
	);
});

test("cluster DNS forward block is marked, replaceable and removable", () => {
	const base = ".:53 {\n    forward . /etc/resolv.conf\n}\n";
	const zones = parseDnsForward("example.com=192.0.2.1,198.51.100.1");
	const once = corefileWithForwardZones(base, zones);
	assert.match(
		once,
		/example\.com:53 \{[\s\S]*forward \. 192\.0\.2\.1 198\.51\.100\.1/,
	);
	assert.equal(corefileWithForwardZones(once, zones), once);
	assert.equal(corefileWithForwardZones(once, []), base);
	assert.throws(() => parseDnsForward("example.com=not an ip"));
	assert.deepEqual(parseDnsForward(""), []);
});

test("Runtime binding resolves only one current-platform image manifest", () => {
	const manifest = (architecture, value) => ({
		mediaType: "application/vnd.oci.image.manifest.v1+json",
		digest: value,
		platform: {
			os: architecture ? "linux" : "unknown",
			architecture: architecture ?? "unknown",
		},
	});
	const index = {
		mediaType: "application/vnd.oci.image.index.v1+json",
		manifests: [
			manifest("arm64", digest("a")),
			manifest(undefined, digest("b")),
		],
	};
	assert.equal(selectPlatformManifest(index, "linux/arm64"), digest("a"));
	assert.throws(() => selectPlatformManifest(index, "linux/amd64"));
	assert.throws(() =>
		selectPlatformManifest(
			{
				...index,
				manifests: [
					manifest("arm64", digest("a")),
					manifest("arm64", digest("c")),
				],
			},
			"linux/arm64",
		),
	);
	assert.equal(
		selectPlatformManifest(
			{ mediaType: "application/vnd.oci.image.manifest.v1+json" },
			"linux/arm64",
		),
		null,
	);
});

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

test("Worker trusted CA bundle accepts only CA certificates", {
	skip: !hasOpenssl,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "worker-trust-test-"));
	// An explicit config keeps the extensions identical across OpenSSL versions.
	const issue = async (name, ca) => {
		await writeFile(
			join(directory, `${name}.cnf`),
			`[req]\ndistinguished_name = dn\nprompt = no\nx509_extensions = v3\n[dn]\nCN = fixture-${name}\n[v3]\nbasicConstraints = critical, CA:${ca ? "TRUE" : "FALSE"}\n`,
		);
		const result = spawnSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"60",
				"-config",
				`${name}.cnf`,
				"-keyout",
				`${name}.key`,
				"-out",
				`${name}.crt`,
			],
			{ cwd: directory, stdio: "ignore" },
		);
		assert.equal(result.status, 0);
		return readFile(join(directory, `${name}.crt`), "utf8");
	};
	try {
		const ca = await issue("ca", true);
		const leaf = await issue("leaf", false);
		assert.equal(isUsableCa(ca), true);
		assert.equal(isUsableCa(`${ca}\n${ca}`), true);
		assert.equal(isUsableCa(leaf), false);
		assert.equal(isUsableCa(`${ca}\n${leaf}`), false);
		assert.equal(
			isUsableCa(ca, { minRemainingMs: 365 * 24 * 60 * 60 * 1000 }),
			false,
		);
		assert.equal(isUsableCa("not a certificate"), false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
