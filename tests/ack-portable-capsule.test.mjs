import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmod,
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { materializeCapsule, runCapsule } from "../deploy/ack/run-capsule.ts";

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "ack-portable-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = join(root, "source");
	const capsule = join(root, "private inputs");
	await mkdir(join(source, "deploy/ack"), { recursive: true });
	await mkdir(capsule, { mode: 0o700 });
	const script = `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == plan ]]
[[ "$ACK_PUBLIC_ORIGIN" == 'https://platform.example.test' ]]
[[ "$ACK_KUBECONFIG" == *'private inputs/kubeconfig' ]]
[[ -r "$ACK_BOOTSTRAP_INPUTS_FILE" ]]
[[ -z "\${ACK_RUNTIME_IMAGE_MANIFEST+x}" ]]
[[ -z "\${ACK_CHART_DIR+x}" ]]
printf '%s\\n' "$1" > "$ACK_EVIDENCE_DIR/executed"
`;
	await writeFile(join(source, "deploy/ack/redeploy.sh"), script, {
		mode: 0o700,
	});
	const git = (args) =>
		execFileSync(
			"git",
			["-C", source, "-c", "core.hooksPath=/dev/null", ...args],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		).trim();
	git(["init", "-q"]);
	git(["add", "."]);
	git([
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.test",
		"commit",
		"-qm",
		"fixture",
	]);
	const sourceSha = git(["rev-parse", "HEAD"]);
	const save = async (relative, value) => {
		const path = join(capsule, relative);
		await writeFile(
			path,
			typeof value === "string" ? value : JSON.stringify(value),
			{ mode: 0o600 },
		);
		return path;
	};
	await save("kubeconfig", "private-cluster-material");
	await save("credential", "private-credential-sentinel");
	await save("request.json", {
		credentialFile: "@CAPSULE_ROOT@/credential",
		storageStateFile: "@CAPSULE_ROOT@/state/login.json",
		worktree: "@SOURCE_ROOT@",
	});
	await save("bootstrap.json", {
		childFile: "@CAPSULE_ROOT@/request.json",
		files: { key: "@CAPSULE_ROOT@/credential" },
	});
	const value = {
		schemaVersion: 1,
		sourceSha,
		inputs: ["bootstrap.json", "request.json"],
		directories: ["state", "evidence"],
		environment: {
			ACK_KUBECONFIG: "@CAPSULE_ROOT@/kubeconfig",
			ACK_BOOTSTRAP_INPUTS_FILE: "@CAPSULE_ROOT@/bootstrap.json",
			ACK_PUBLIC_ORIGIN: "https://platform.example.test",
			ACK_EVIDENCE_DIR: "@CAPSULE_ROOT@/evidence",
			ACK_CUSTOM_AGENT_CONFIGS: ["@CAPSULE_ROOT@/request.json"],
		},
	};
	const manifest = await save("capsule.json", value);
	return { root, source, sourceSha, capsule, value, manifest, save };
}

test("the same capsule relocates without editing source templates or credential bytes", async (t) => {
	const f = await fixture(t);
	const before = await readFile(join(f.capsule, "bootstrap.json"));
	const copy = join(f.root, "relocated inputs with spaces");
	await cp(f.capsule, copy, { recursive: true });
	await chmod(copy, 0o700);
	for (const root of [f.capsule, copy]) {
		const canonical = await realpath(root);
		const result = await materializeCapsule(
			join(root, "capsule.json"),
			f.source,
		);
		const bootstrap = JSON.parse(
			await readFile(result.environment.ACK_BOOTSTRAP_INPUTS_FILE),
		);
		const request = JSON.parse(await readFile(bootstrap.childFile));
		assert(bootstrap.childFile.startsWith(join(canonical, ".resolved-")));
		assert.equal(request.worktree, f.source);
		assert.equal(request.storageStateFile, join(canonical, "state/login.json"));
		assert.equal(request.credentialFile, join(canonical, "credential"));
		assert.equal(result.environment.ACK_SOURCE_SHA, f.sourceSha);
		assert.equal(
			result.environment.ACK_CUSTOM_AGENT_CONFIGS,
			bootstrap.childFile,
		);
		assert.equal(
			await readFile(request.credentialFile, "utf8"),
			"private-credential-sentinel",
		);
		assert.equal((await lstat(bootstrap.childFile)).mode & 0o777, 0o600);
		assert.deepEqual(await readFile(join(root, "bootstrap.json")), before);
	}
});

test("the runner invokes the existing workflow without shell interpolation and returns its exit", async (t) => {
	const f = await fixture(t);
	const previous = {
		ACK_RUNTIME_IMAGE_MANIFEST: process.env.ACK_RUNTIME_IMAGE_MANIFEST,
		ACK_CHART_DIR: process.env.ACK_CHART_DIR,
	};
	process.env.ACK_RUNTIME_IMAGE_MANIFEST =
		"/another-installation/manifest.json";
	process.env.ACK_CHART_DIR = "/another-installation/chart";
	let result;
	try {
		result = await runCapsule(f.manifest, "plan", f.source);
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	assert.equal(result.exitCode, 0);
	assert.equal(result.command, "plan");
	assert.equal(
		await readFile(join(f.capsule, "evidence/executed"), "utf8"),
		"plan\n",
	);
	assert(!JSON.stringify(result).includes("private-credential-sentinel"));
	await assert.rejects(
		runCapsule(f.manifest, "plan; touch unwanted", f.source),
		/CAPSULE_COMMAND_INVALID/,
	);
});

for (const scenario of [
	"source",
	"duplicate",
	"traversal",
	"missing",
	"raw-missing",
	"public-input",
	"public-root",
	"symlink-input",
	"symlink-parent",
	"unknown-env",
	"absolute-env",
	"hidden-destroy-confirmation",
]) {
	test(`portable capsule rejects ${scenario} before invoking the workflow`, async (t) => {
		const f = await fixture(t);
		if (scenario === "source") f.value.sourceSha = "f".repeat(40);
		if (scenario === "duplicate") f.value.inputs.push("request.json");
		if (scenario === "traversal")
			await f.save("request.json", { path: "@CAPSULE_ROOT@/../outside" });
		if (scenario === "missing") await rm(join(f.capsule, "request.json"));
		if (scenario === "raw-missing") await rm(join(f.capsule, "credential"));
		if (scenario === "public-input")
			await chmod(join(f.capsule, "request.json"), 0o644);
		if (scenario === "public-root") await chmod(f.capsule, 0o755);
		if (scenario === "symlink-input") {
			await rm(join(f.capsule, "request.json"));
			await symlink(
				join(f.capsule, "bootstrap.json"),
				join(f.capsule, "request.json"),
			);
		}
		if (scenario === "symlink-parent") {
			await symlink(f.source, join(f.capsule, "state"));
		}
		if (scenario === "unknown-env") f.value.environment.PATH = "/attacker";
		if (scenario === "absolute-env")
			f.value.environment.ACK_KUBECONFIG = "/other/machine/kubeconfig";
		if (scenario === "hidden-destroy-confirmation")
			f.value.environment.ACK_CLEAN_CONFIRM = "DELETE_ACK_ENV";
		await f.save("capsule.json", f.value);
		await assert.rejects(runCapsule(f.manifest, "plan", f.source));
		assert(
			!(await readdir(f.capsule)).some((name) => name.startsWith(".resolved-")),
		);
		await assert.rejects(readFile(join(f.capsule, "evidence/executed")), {
			code: "ENOENT",
		});
	});
}

test("each materialization isolates mutable JSON inputs from earlier runs", async (t) => {
	const f = await fixture(t);
	const first = await materializeCapsule(f.manifest, f.source);
	await writeFile(
		first.environment.ACK_BOOTSTRAP_INPUTS_FILE,
		'{"modifiedDuringRun":true}',
	);
	const next = await materializeCapsule(f.manifest, f.source);
	assert.notEqual(
		first.environment.ACK_BOOTSTRAP_INPUTS_FILE,
		next.environment.ACK_BOOTSTRAP_INPUTS_FILE,
	);
	assert.equal(
		JSON.parse(await readFile(next.environment.ACK_BOOTSTRAP_INPUTS_FILE))
			.modifiedDuringRun,
		undefined,
	);
});

test("directory consumers read resolved browser blueprints, not the original templates", async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.capsule, "blueprints"), { mode: 0o700 });
	await f.save("blueprints/codex.json", {
		owner: { stateFile: "@CAPSULE_ROOT@/state/owner.json" },
	});
	f.value.inputs.push("blueprints/codex.json");
	f.value.environment.ACK_BROWSER_BLUEPRINT_DIR = "@CAPSULE_ROOT@/blueprints";
	await f.save("capsule.json", f.value);
	const resolved = await materializeCapsule(f.manifest, f.source);
	const directory = resolved.environment.ACK_BROWSER_BLUEPRINT_DIR;
	assert(directory.includes("/.resolved-"));
	const blueprint = JSON.parse(await readFile(join(directory, "codex.json")));
	assert.equal(
		blueprint.owner.stateFile,
		join(await realpath(f.capsule), "state/owner.json"),
	);
	assert(
		(await readFile(join(f.capsule, "blueprints/codex.json"), "utf8")).includes(
			"@CAPSULE_ROOT@",
		),
	);
});
