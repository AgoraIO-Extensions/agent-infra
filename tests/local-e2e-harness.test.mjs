import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
	corefileWithForwardZones,
	issueCa,
	issueLeaf,
	isUsableCa,
	isUsableLeaf,
	parseDnsForward,
	runtimeTlsBinding,
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

test("Runtime TLS binding covers the business and probe Service DNS", () => {
	const binding = runtimeTlsBinding("agent_example", "agent-infra-e2e");
	const name = binding.serverSecretRef.name.replace(/-runtime-tls$/, "");
	assert.match(name, /^agent-[a-f0-9]{32}$/);
	assert.deepEqual(binding.serviceDnsNames, [
		`${name}.agent-infra-e2e.svc`,
		`${name}-probe.agent-infra-e2e.svc`,
	]);
	assert.notEqual(binding.serverSecretRef.name, "agent-runtime-tls");
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

test("issued Runtime leaf satisfies the Worker TLS Secret contract", {
	skip: !hasOpenssl,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "runtime-tls-test-"));
	try {
		const binding = runtimeTlsBinding("agent_example", "agent-infra-e2e");
		const ca = await issueCa(directory);
		assert.equal(isUsableCa(ca.cert), true);
		const leaf = await issueLeaf(directory, ca, binding.serviceDnsNames);
		assert.equal(isUsableLeaf(leaf, binding.serviceDnsNames, ca.cert), true);
		assert.equal(
			isUsableLeaf(leaf, ["other.agent-infra-e2e.svc"], ca.cert),
			false,
		);
		const otherCa = await issueCa(directory);
		assert.equal(
			isUsableLeaf(leaf, binding.serviceDnsNames, otherCa.cert),
			false,
		);
		assert.equal(isUsableCa(leaf.cert), false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
