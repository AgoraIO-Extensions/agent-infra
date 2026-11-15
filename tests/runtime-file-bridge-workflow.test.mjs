// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions and shell parameter expansions are literal workflow text here.
/**
 * #3230：linux/amd64 FileBridge origin 资格 workflow 的独立策略与形状测试。
 * 解析真实 workflow 文件，并直接执行其中的输入校验、来源校验、拉取、资格与 receipt 脚本；
 * Docker、uname 与 CLI 进程用本地 stub 代替，不访问网络或 Registry。
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import YAML from "yaml";

import { validateWorkflowDocuments } from "../.github/scripts/verify-workflow-policy.mjs";
import {
	fileBridgeDriversForRole,
	fileBridgeQualificationArguments,
} from "../deploy/release/runtime-probe.mjs";
import { fileBridgeProbeOrigin } from "./support/runtime-file-bridge-probe.mjs";

const root = resolve(import.meta.dirname, "..");
const workflowDirectory = join(root, ".github/workflows");
const workflowName = "qualify-runtime-file-bridge.yml";
const workflow = YAML.parse(
	readFileSync(join(workflowDirectory, workflowName), "utf8"),
);
const job = workflow.jobs.qualify;
const pins = [
	"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
	"actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
	"actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
];
const stepNames = [
	"Validate qualification inputs",
	"Checkout tool source",
	"Verify merged tool source",
	"Set up Node.js",
	"Pull the exact image",
	"Qualify FileBridge origin",
	"Write qualification receipt",
	"Upload qualification receipt",
];
// Hex letters as well as digits, so case and length mutations are observable.
const imageDigest = `sha256:${"1a".repeat(32)}`;
const image = `ghcr.io/agoraio-extensions/agent-infra/agent-runtime-codex@${imageDigest}`;
const valid = Object.freeze({
	TOOL_SOURCE_SHA: "b".repeat(40),
	IMAGE_REFERENCE: image,
	IMAGE_SOURCE_SHA: "c".repeat(40),
	IMAGE_ROLE: "codex",
	TARGET_NAMESPACE: "agent-infra-probe-target",
	PLATFORM: "linux/amd64",
});
const sha256 = (bytes) =>
	`sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function step(name) {
	const matches = job.steps.filter((candidate) => candidate.name === name);
	assert.equal(matches.length, 1, name);
	return matches[0];
}

function temporaryDirectory(t, prefix) {
	const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function stubs(directory, files) {
	const bin = join(directory, "bin");
	mkdirSync(bin, { recursive: true });
	for (const [name, script] of Object.entries(files)) {
		writeFileSync(join(bin, name), `#!/bin/sh\n${script}`);
		chmodSync(join(bin, name), 0o755);
	}
	return bin;
}

/** Runs the exact `run` text of one workflow step with bash, as the runner does. */
function runStep(name, { env, cwd, bin }) {
	return spawnSync("bash", ["-e", "-c", step(name).run], {
		cwd,
		encoding: "utf8",
		env: {
			PATH: [bin, dirname(process.execPath), process.env.PATH]
				.filter(Boolean)
				.join(":"),
			HOME: cwd,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			...env,
		},
		timeout: 60_000,
	});
}

function repository(t) {
	const directory = temporaryDirectory(t, "file-bridge-workflow-git");
	const git = (...args) =>
		execFileSync(
			"git",
			[
				"-c",
				"user.name=probe",
				"-c",
				"user.email=probe@example.invalid",
				"-c",
				"core.hooksPath=/dev/null",
				...args,
			],
			{
				cwd: directory,
				encoding: "utf8",
				env: {
					...process.env,
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
				},
			},
		).trim();
	git("init", "-q", "-b", "main");
	const commit = (message) => {
		writeFileSync(join(directory, "file.txt"), `${message}\n`);
		git("add", "file.txt");
		git("commit", "-q", "-m", message);
		return git("rev-parse", "HEAD");
	};
	return { directory, git, commit };
}

test("the qualification workflow is a main-only linux/amd64 dispatch with read-only package access", () => {
	assert.equal(workflow.name, "Qualify runtime FileBridge origin");
	assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
	const inputs = workflow.on.workflow_dispatch.inputs;
	assert.deepEqual(Object.keys(inputs), [
		"tool_source_sha",
		"image",
		"image_source_sha",
		"role",
		"namespace",
	]);
	for (const [name, input] of Object.entries(inputs)) {
		assert.equal(input.required, true, name);
		assert.equal(Object.hasOwn(input, "default"), false, name);
		assert.equal(input.type, name === "role" ? "choice" : "string", name);
	}
	// The approved role set is exactly the CLI's: Drivers such as acp are not roles.
	assert.deepEqual(inputs.role.options, [
		"runtimeHost",
		"codex",
		"claude",
		"opencode",
		"pi",
	]);
	for (const role of inputs.role.options) fileBridgeDriversForRole(role);
	assert.throws(() => fileBridgeDriversForRole("acp"));
	assert.deepEqual(workflow.permissions, {});
	assert.equal(workflow.env, undefined);
	assert.deepEqual(Object.keys(workflow.jobs), ["qualify"]);
	assert.equal(
		job.if,
		"github.repository == 'AgoraIO-Extensions/agent-infra' && github.ref == 'refs/heads/main'",
	);
	assert.equal(job["runs-on"], "ubuntu-24.04");
	assert.deepEqual(job.permissions, { contents: "read", packages: "read" });
	for (const key of ["environment", "container", "services", "strategy"])
		assert.equal(Object.hasOwn(job, key), false, key);
	assert.deepEqual(job.env, {
		TOOL_SOURCE_SHA: "${{ inputs.tool_source_sha }}",
		IMAGE_REFERENCE: "${{ inputs.image }}",
		IMAGE_SOURCE_SHA: "${{ inputs.image_source_sha }}",
		IMAGE_ROLE: "${{ inputs.role }}",
		TARGET_NAMESPACE: "${{ inputs.namespace }}",
		PLATFORM: "linux/amd64",
	});
	// Finite: every step budget fits inside the job budget.
	assert.equal(job["timeout-minutes"], 60);
	assert.equal(step("Pull the exact image")["timeout-minutes"], 15);
	assert.equal(step("Qualify FileBridge origin")["timeout-minutes"], 40);
	// One run per exact input tuple; a duplicate waits instead of cancelling it.
	assert.deepEqual(workflow.concurrency, {
		group:
			"qualify-runtime-file-bridge-${{ inputs.tool_source_sha }}-${{ inputs.image }}-${{ inputs.image_source_sha }}-${{ inputs.role }}-${{ inputs.namespace }}",
		"cancel-in-progress": false,
	});
});

test("inputs reach scripts only as environment values and only the pull step holds the token", () => {
	assert.deepEqual(
		job.steps.map(({ name }) => name),
		stepNames,
	);
	assert.doesNotMatch(JSON.stringify(workflow), /secrets\./i);
	for (const candidate of job.steps) {
		if (candidate.run)
			assert.doesNotMatch(candidate.run, /\$\{\{/, candidate.name);
		if (candidate.uses)
			assert.ok(pins.includes(candidate.uses), candidate.uses);
		assert.equal(
			JSON.stringify(candidate).includes("github.token"),
			candidate.name === "Pull the exact image",
			candidate.name,
		);
	}
	assert.deepEqual(step("Pull the exact image").env, {
		GHCR_TOKEN: "${{ github.token }}",
	});
	assert.deepEqual(step("Checkout tool source").with, {
		"fetch-depth": 0,
		"persist-credentials": false,
		ref: "${{ inputs.tool_source_sha }}",
	});
	// Validation runs first and unconditionally; any failure skips the rest
	// until the receipt, which only records validated inputs.
	for (const name of stepNames.slice(0, 6))
		assert.equal(step(name).if, undefined, name);
	for (const name of stepNames.slice(6))
		assert.equal(
			step(name).if,
			"${{ always() && steps.validate.outcome == 'success' }}",
			name,
		);
	assert.equal(step("Validate qualification inputs").id, "validate");
	assert.deepEqual(step("Upload qualification receipt").with, {
		name: "runtime-file-bridge-qualification-${{ github.run_id }}-${{ github.run_attempt }}",
		path: "${{ runner.temp }}/file-bridge-qualification/",
		"if-no-files-found": "error",
		"retention-days": 30,
	});
});

test("the workflow pulls only the exact image and never builds, tags or publishes", () => {
	const scripts = job.steps
		.filter(({ run }) => run)
		.map(({ run }) => run)
		.join("\n");
	assert.doesNotMatch(
		scripts,
		/\bdocker\s+(?:build|buildx|push|tag|save|load|import|commit|run|exec|compose|manifest)\b|\bbuildx\b|build-images\.mjs|custom-base-image\.mjs|\bkubectl\b|\bhelm\b|\bcurl\b|\bwget\b|\bgh\s|\b(?:npm|pnpm|npx|yarn)\b|\b(?:cosign|oras|crane|skopeo|regctl)\b/,
	);
	assert.deepEqual(scripts.match(/docker pull[^\n]*/g), [
		'docker pull --platform "$PLATFORM" "$IMAGE_REFERENCE"',
	]);
	assert.deepEqual(scripts.match(/docker login[^\n]*/g), [
		"docker login ghcr.io --username github-actions --password-stdin",
	]);
	assert.deepEqual(scripts.match(/runtime-probe\.mjs[^\n]*/g), [
		"runtime-probe.mjs --file-bridge-qualification \\",
	]);
});

test("input validation rejects malformed or injected values without evaluating them", (t) => {
	const directory = temporaryDirectory(t, "file-bridge-workflow-inputs");
	const marker = join(directory, "evaluated");
	const validate = (env) =>
		runStep("Validate qualification inputs", {
			env: { ...valid, ...env },
			cwd: directory,
		});
	const accepted = validate({});
	assert.equal(accepted.status, 0, accepted.stderr);
	for (const role of workflow.on.workflow_dispatch.inputs.role.options)
		assert.equal(validate({ IMAGE_ROLE: role }).status, 0, role);
	for (const reference of [
		`ghcr.io/agoraio-extensions/agent-infra/agent-runtime-host@${imageDigest}`,
		`ghcr.io/agoraio-extensions/agent-infra/agent_runtime.next-1@${imageDigest}`,
	])
		assert.equal(validate({ IMAGE_REFERENCE: reference }).status, 0, reference);
	assert.equal(validate({ TARGET_NAMESPACE: "a".repeat(63) }).status, 0);

	const injected = [
		`$(touch ${marker})`,
		`\`touch ${marker}\``,
		`;touch ${marker}`,
		`|touch ${marker}`,
		`&& touch ${marker}`,
		`\ntouch ${marker}`,
	];
	const digest = imageDigest.slice("sha256:".length);
	const repositoryPath = "ghcr.io/agoraio-extensions/agent-infra";
	const cases = [
		["TOOL_SOURCE_SHA", ""],
		["TOOL_SOURCE_SHA", "b".repeat(39)],
		["TOOL_SOURCE_SHA", "b".repeat(41)],
		["TOOL_SOURCE_SHA", "B".repeat(40)],
		["TOOL_SOURCE_SHA", "main"],
		["TOOL_SOURCE_SHA", `${"b".repeat(40)}\n${"b".repeat(40)}`],
		["IMAGE_SOURCE_SHA", "c".repeat(12)],
		["IMAGE_SOURCE_SHA", `refs/heads/${"c".repeat(40)}`],
		["IMAGE_REFERENCE", ""],
		["IMAGE_REFERENCE", `${repositoryPath}/agent-runtime-codex:latest`],
		[
			"IMAGE_REFERENCE",
			`${repositoryPath}/agent-runtime-codex:release@${imageDigest}`,
		],
		[
			"IMAGE_REFERENCE",
			`docker.io/agoraio-extensions/agent-infra/agent-runtime-codex@${imageDigest}`,
		],
		["IMAGE_REFERENCE", `ghcr.io/other/agent-runtime-codex@${imageDigest}`],
		["IMAGE_REFERENCE", `${repositoryPath}/Agent-Runtime-Codex@${imageDigest}`],
		["IMAGE_REFERENCE", `${repositoryPath}/../codex@${imageDigest}`],
		["IMAGE_REFERENCE", `${repositoryPath}/a/b@${imageDigest}`],
		[
			"IMAGE_REFERENCE",
			`${repositoryPath}/agent-runtime-codex@sha256:${digest.toUpperCase()}`,
		],
		[
			"IMAGE_REFERENCE",
			`${repositoryPath}/agent-runtime-codex@sha512:${digest}${digest}`,
		],
		[
			"IMAGE_REFERENCE",
			`${repositoryPath}/agent-runtime-codex@sha256:${"1".repeat(63)}`,
		],
		["IMAGE_REFERENCE", `${image}\n${image}`],
		["IMAGE_ROLE", ""],
		["IMAGE_ROLE", "acp"],
		["IMAGE_ROLE", "Codex"],
		["IMAGE_ROLE", "runtimehost"],
		["IMAGE_ROLE", "codex claude"],
		["TARGET_NAMESPACE", ""],
		["TARGET_NAMESPACE", "Agent-Infra"],
		["TARGET_NAMESPACE", "-namespace"],
		["TARGET_NAMESPACE", "namespace-"],
		["TARGET_NAMESPACE", "a".repeat(64)],
		["TARGET_NAMESPACE", "agent-infra.svc"],
		["PLATFORM", "linux/arm64"],
		...injected.flatMap((value) =>
			Object.keys(valid)
				.filter((name) => name !== "PLATFORM")
				.flatMap((name) => [
					[name, value],
					[name, `${valid[name]}${value}`],
				]),
		),
	];
	for (const [name, value] of cases) {
		const result = validate({ [name]: value });
		assert.equal(result.status, 1, `${name}=${JSON.stringify(value)}`);
		assert.match(result.stderr, /must be/);
		// Errors are fixed texts; a rejected value is never echoed back.
		if (value.length >= 12)
			assert.ok(!`${result.stdout}${result.stderr}`.includes(value), name);
	}
	assert.equal(existsSync(marker), false);
});

test("the merged-source guard requires the exact checkout and main ancestry", (t) => {
	const { directory, git, commit } = repository(t);
	const first = commit("first");
	const merged = commit("merged");
	git("checkout", "-q", "-b", "side", first);
	const unmerged = commit("unmerged");
	git("update-ref", "refs/remotes/origin/main", merged);
	const verify = (head, toolSource) => {
		git("checkout", "-q", "--detach", head);
		return runStep("Verify merged tool source", {
			env: { ...valid, TOOL_SOURCE_SHA: toolSource },
			cwd: directory,
		});
	};
	assert.equal(verify(merged, merged).status, 0);
	assert.equal(verify(first, first).status, 0);
	assert.notEqual(verify(unmerged, unmerged).status, 0);
	assert.notEqual(verify(merged, first).status, 0);
	git("checkout", "-q", "--detach", merged);
	writeFileSync(join(directory, "untracked.txt"), "dirty\n");
	assert.notEqual(verify(merged, merged).status, 0);
});

test("the pull step sends the token only on stdin, pulls one exact reference and always logs out", (t) => {
	const directory = temporaryDirectory(t, "file-bridge-workflow-pull");
	const bin = stubs(directory, {
		uname: 'echo "${FAKE_MACHINE:-x86_64}"\n',
		docker: [
			'printf "%s\\n" "$*" >> "$FAKE_DOCKER_LOG"',
			'case "$1" in',
			'  info) echo "${FAKE_DOCKER_PLATFORM:-linux/x86_64}" ;;',
			'  login) cat > "$FAKE_DOCKER_STDIN" ;;',
			'  pull) exit "${FAKE_PULL_STATUS:-0}" ;;',
			"esac",
			"",
		].join("\n"),
	});
	const token = `synthetic-ghcr-token-${"z".repeat(24)}`;
	const pull = (env = {}) => {
		const log = join(directory, "docker.log");
		const stdin = join(directory, "docker.stdin");
		rmSync(log, { force: true });
		rmSync(stdin, { force: true });
		const result = runStep("Pull the exact image", {
			env: {
				...valid,
				GHCR_TOKEN: token,
				FAKE_DOCKER_LOG: log,
				FAKE_DOCKER_STDIN: stdin,
				...env,
			},
			cwd: directory,
			bin,
		});
		return {
			result,
			calls: existsSync(log)
				? readFileSync(log, "utf8").trim().split("\n")
				: [],
			stdin: existsSync(stdin) ? readFileSync(stdin, "utf8") : undefined,
		};
	};
	const passed = pull();
	assert.equal(passed.result.status, 0, passed.result.stderr);
	assert.deepEqual(passed.calls, [
		"info --format {{.OSType}}/{{.Architecture}}",
		"login ghcr.io --username github-actions --password-stdin",
		`pull --platform linux/amd64 ${image}`,
		"logout ghcr.io",
	]);
	assert.equal(passed.stdin, `${token}\n`);
	assert.ok(!passed.calls.join("\n").includes(token));
	assert.ok(!`${passed.result.stdout}${passed.result.stderr}`.includes(token));

	const failed = pull({ FAKE_PULL_STATUS: "1" });
	assert.notEqual(failed.result.status, 0);
	assert.equal(failed.calls.at(-1), "logout ghcr.io");

	// Not a linux/amd64 runner: stop before any credential use.
	for (const env of [
		{ FAKE_MACHINE: "aarch64" },
		{ FAKE_DOCKER_PLATFORM: "linux/aarch64" },
	]) {
		const refused = pull(env);
		assert.notEqual(refused.result.status, 0);
		assert.ok(!refused.calls.some((call) => call.startsWith("login")));
		assert.equal(refused.stdin, undefined);
	}
});

test("the qualification step runs the existing strict CLI with the dispatched inputs", (t) => {
	const { directory, commit } = repository(t);
	const head = commit("tool");
	const runnerTemp = temporaryDirectory(t, "file-bridge-workflow-runner");
	const argvPath = join(runnerTemp, "argv");
	const bin = stubs(runnerTemp, {
		node: [
			'for argument in "$@"; do printf "%s\\000" "$argument"; done > "$FAKE_NODE_ARGV"',
			"echo FileBridge origin image qualification passed",
			'exit "${FAKE_NODE_STATUS:-0}"',
			"",
		].join("\n"),
	});
	const qualify = (env = {}) =>
		runStep("Qualify FileBridge origin", {
			env: {
				...valid,
				TOOL_SOURCE_SHA: head,
				RUNNER_TEMP: runnerTemp,
				FAKE_NODE_ARGV: argvPath,
				...env,
			},
			cwd: directory,
			bin,
		});
	const passed = qualify();
	assert.equal(passed.status, 0, passed.stderr);
	const argv = readFileSync(argvPath, "utf8").split("\0").slice(0, -1);
	const output = join(runnerTemp, "file-bridge-qualification/evidence.json");
	assert.deepEqual(argv, [
		"deploy/release/runtime-probe.mjs",
		"--file-bridge-qualification",
		"--role",
		valid.IMAGE_ROLE,
		"--image-source",
		valid.IMAGE_SOURCE_SHA,
		"--platform",
		"linux/amd64",
		"--namespace",
		valid.TARGET_NAMESPACE,
		image,
		output,
	]);
	assert.deepEqual(fileBridgeQualificationArguments(argv.slice(2)), {
		role: valid.IMAGE_ROLE,
		imageSource: valid.IMAGE_SOURCE_SHA,
		platform: "linux/amd64",
		namespace: valid.TARGET_NAMESPACE,
		reference: image,
		output,
	});
	assert.equal(
		readFileSync(
			join(runnerTemp, "file-bridge-qualification/qualification.log"),
			"utf8",
		),
		"FileBridge origin image qualification passed\n",
	);
	// A CLI failure fails the step through the log pipe.
	assert.notEqual(qualify({ FAKE_NODE_STATUS: "1" }).status, 0);
	// The CLI never runs from a checkout other than the dispatched tool source.
	rmSync(argvPath);
	assert.notEqual(qualify({ TOOL_SOURCE_SHA: "d".repeat(40) }).status, 0);
	assert.equal(existsSync(argvPath), false);
});

test("the receipt binds evidence, hashes, tool source, run and attempt, and fails unbound evidence", (t) => {
	const { directory, git, commit } = repository(t);
	const head = commit("tool");
	const tree = git("rev-parse", "HEAD^{tree}");
	const runnerTemp = temporaryDirectory(t, "file-bridge-workflow-receipt");
	const output = join(runnerTemp, "file-bridge-qualification");
	const inspection = {
		Id: `sha256:${"2".repeat(64)}`,
		RepoDigests: [image],
		Os: "linux",
		Architecture: "amd64",
		Config: {
			Labels: {
				"org.opencontainers.image.revision": valid.IMAGE_SOURCE_SHA,
				"io.agora.agent.standard-template": "codex",
			},
		},
	};
	const bin = stubs(runnerTemp, {
		uname: "echo x86_64\n",
		docker: [
			'case "$1" in',
			`  image) echo '${JSON.stringify(inspection)}' ;;`,
			`  info) echo '${JSON.stringify({ ServerVersion: "28.0.4", OSType: "linux", Architecture: "x86_64", KernelVersion: "6.11.0", OperatingSystem: "Ubuntu 24.04", Driver: "overlay2" })}' ;;`,
			"  *) exit 1 ;;",
			"esac",
			"",
		].join("\n"),
	});
	const evidence = (overrides = {}) => ({
		schemaVersion: 1,
		kind: "runtime-image-file-bridge-qualification",
		status: "passed",
		tool: { commitSha: head, sourceDirty: false, sourceTree: tree },
		image: {
			reference: image,
			digest: imageDigest,
			platform: "linux/amd64",
			role: valid.IMAGE_ROLE,
			sourceCommit: valid.IMAGE_SOURCE_SHA,
			sourceRepository: "https://github.com/AgoraIO-Extensions/agent-infra",
		},
		sourceRelation: { imageSourceInToolHistory: true, sameSource: false },
		fileBridgeOrigin: {
			role: valid.IMAGE_ROLE,
			namespace: valid.TARGET_NAMESPACE,
			origin: fileBridgeProbeOrigin(valid.TARGET_NAMESPACE),
			imageReference: image,
		},
		...overrides,
	});
	const run = ({ files, outcome = "success" }) => {
		rmSync(output, { recursive: true, force: true });
		mkdirSync(output, { recursive: true });
		for (const [name, value] of Object.entries(files))
			writeFileSync(join(output, name), value);
		const result = runStep("Write qualification receipt", {
			env: {
				...valid,
				TOOL_SOURCE_SHA: head,
				RUNNER_TEMP: runnerTemp,
				RUNNER_OS: "Linux",
				RUNNER_ARCH: "X64",
				GITHUB_REPOSITORY: "AgoraIO-Extensions/agent-infra",
				GITHUB_RUN_ID: "123456789",
				GITHUB_RUN_ATTEMPT: "2",
				GITHUB_EVENT_NAME: "workflow_dispatch",
				GITHUB_REF: "refs/heads/main",
				GITHUB_WORKFLOW_REF: `AgoraIO-Extensions/agent-infra/.github/workflows/${workflowName}@refs/heads/main`,
				GITHUB_WORKFLOW_SHA: "e".repeat(40),
				GITHUB_TRIGGERING_ACTOR: "synthetic-dispatcher",
				CHECKOUT_OUTCOME: "success",
				SOURCE_OUTCOME: "success",
				PULL_OUTCOME: "success",
				QUALIFY_OUTCOME: outcome,
			},
			cwd: directory,
			bin,
		});
		const receipt = JSON.parse(
			readFileSync(join(output, "receipt.json"), "utf8"),
		);
		const sums = readFileSync(join(output, "SHA256SUMS"), "utf8");
		return { result, receipt, sums };
	};
	const log = "FileBridge origin image qualification passed\n";
	const evidenceText = `${JSON.stringify(evidence(), null, 2)}\n`;
	const passed = run({
		files: { "evidence.json": evidenceText, "qualification.log": log },
	});
	assert.equal(passed.result.status, 0, passed.result.stderr);
	assert.deepEqual(passed.receipt, {
		schemaVersion: 1,
		kind: "runtime-image-file-bridge-qualification-run",
		status: "passed",
		evidenceBoundToInputs: true,
		run: {
			repository: "AgoraIO-Extensions/agent-infra",
			id: "123456789",
			attempt: "2",
			event: "workflow_dispatch",
			ref: "refs/heads/main",
			workflowRef: `AgoraIO-Extensions/agent-infra/.github/workflows/${workflowName}@refs/heads/main`,
			workflowSha: "e".repeat(40),
			triggeringActor: "synthetic-dispatcher",
			runner: { os: "Linux", arch: "X64", machine: "x86_64" },
		},
		inputs: {
			toolSourceSha: head,
			image,
			imageSourceSha: valid.IMAGE_SOURCE_SHA,
			role: valid.IMAGE_ROLE,
			namespace: valid.TARGET_NAMESPACE,
			platform: "linux/amd64",
		},
		steps: {
			checkout: "success",
			source: "success",
			pull: "success",
			qualify: "success",
		},
		toolSource: { commit: head, tree },
		daemon: {
			serverVersion: "28.0.4",
			osType: "linux",
			architecture: "x86_64",
			kernelVersion: "6.11.0",
			operatingSystem: "Ubuntu 24.04",
			storageDriver: "overlay2",
		},
		image: {
			id: inspection.Id,
			repoDigests: [image],
			os: "linux",
			architecture: "amd64",
			revision: valid.IMAGE_SOURCE_SHA,
			standardTemplate: "codex",
		},
		files: {
			"evidence.json": sha256(evidenceText),
			"qualification.log": sha256(log),
		},
	});
	const receiptBytes = readFileSync(join(output, "receipt.json"));
	assert.equal(
		passed.sums,
		[
			`${sha256(evidenceText).slice(7)}  evidence.json`,
			`${sha256(log).slice(7)}  qualification.log`,
			`${sha256(receiptBytes).slice(7)}  receipt.json`,
			"",
		].join("\n"),
	);

	// A failed CLI keeps its log and a failed receipt; nothing claims a pass.
	const failed = run({
		files: {
			"qualification.log": "FileBridge origin image identity is unavailable\n",
		},
		outcome: "failure",
	});
	assert.equal(failed.result.status, 1);
	assert.equal(failed.receipt.status, "failed");
	assert.equal(failed.receipt.files["evidence.json"], null);
	assert.deepEqual(
		failed.sums
			.trim()
			.split("\n")
			.map((line) => line.split("  ")[1]),
		["qualification.log", "receipt.json"],
	);

	// Passed evidence that differs from the dispatched tuple in any one bound
	// field, or omits it, does not qualify that tuple.
	const without = (object, key) =>
		Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
	const { image: base, fileBridgeOrigin: nested } = evidence();
	const otherImage = image.replace("codex", "pi");
	for (const overrides of [
		{ image: { ...base, role: "claude" } },
		{ image: { ...base, platform: "linux/arm64" } },
		{ image: { ...base, reference: otherImage } },
		{ image: { ...base, digest: `sha256:${"f".repeat(64)}` } },
		{ image: { ...base, digest: imageDigest.toUpperCase() } },
		{ image: without(base, "digest") },
		{ image: { ...base, sourceCommit: "f".repeat(40) } },
		{
			image: {
				...base,
				sourceRepository: "https://github.com/other/agent-infra",
			},
		},
		{ image: without(base, "sourceRepository") },
		{ tool: { ...evidence().tool, commitSha: "f".repeat(40) } },
		{ fileBridgeOrigin: { ...nested, role: "claude" } },
		{ fileBridgeOrigin: { ...nested, namespace: "agent-infra-other" } },
		{ fileBridgeOrigin: { ...nested, imageReference: otherImage } },
		{ fileBridgeOrigin: without(nested, "imageReference") },
		{
			fileBridgeOrigin: {
				...nested,
				origin: fileBridgeProbeOrigin("agent-infra-other"),
			},
		},
		{ fileBridgeOrigin: { ...nested, origin: `${nested.origin}/` } },
		{ fileBridgeOrigin: without(nested, "origin") },
		{ sourceRelation: { imageSourceInToolHistory: false, sameSource: false } },
		{ status: "failed" },
	]) {
		const unbound = run({
			files: {
				"evidence.json": JSON.stringify(evidence(overrides)),
				"qualification.log": log,
			},
		});
		assert.equal(unbound.result.status, 1, JSON.stringify(overrides));
		assert.equal(unbound.receipt.status, "failed");
		assert.equal(unbound.receipt.evidenceBoundToInputs, false);
	}
	const interrupted = run({
		files: { "evidence.json": evidenceText, "qualification.log": log },
		outcome: "cancelled",
	});
	assert.equal(interrupted.receipt.status, "failed");
});

test("the shared workflow policy covers the qualification workflow", () => {
	const workflows = Object.fromEntries(
		readdirSync(workflowDirectory)
			.filter((name) => name.endsWith(".yml"))
			.map((name) => [
				name,
				YAML.parse(readFileSync(join(workflowDirectory, name), "utf8")),
			]),
	);
	assert.ok(Object.hasOwn(workflows, workflowName));
	assert.deepEqual(validateWorkflowDocuments(workflows), []);
	const unpinned = structuredClone(workflows);
	unpinned[workflowName].jobs.qualify.steps[1].uses = "actions/checkout@v4";
	assert.ok(
		validateWorkflowDocuments(unpinned).some((error) =>
			error.includes("full commit SHA"),
		),
	);
});
