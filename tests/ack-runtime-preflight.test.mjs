import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL(
	"../deploy/ack/runtime-isolation-preflight.mjs",
	import.meta.url,
);
for (const scenario of [
	"passed",
	"runtime-class",
	"unsupported",
	"landlock-unavailable",
	"landlock-denied",
	"runtime-class-enosys",
	"kernel-unavailable",
	"kernel-timeout",
	"invalid-kernel-release",
	"ownership-changed",
	"invalid-image",
]) {
	test(`ACK Runtime isolation probe: ${scenario}`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "ack-runtime-test-"));
		const binary = join(directory, "kubectl");
		try {
			await writeFile(
				binary,
				`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PROBE_TEST_LOG, JSON.stringify(args)+'\\n');
const state = process.env.PROBE_TEST_STATE;
const scenario = process.env.PROBE_TEST_SCENARIO;
if(args.includes('create')) fs.writeFileSync(state, fs.readFileSync(0));
if(args.includes('get')) {
 const pod = JSON.parse(fs.readFileSync(state));
 pod.metadata.uid = '11111111-2222-4333-8444-555555555555';
 pod.spec.nodeName = 'controlled-node';
 if(scenario === 'ownership-changed') pod.metadata.labels['agent-infra.agora.io/runtime-preflight']='another-owner';
 process.stdout.write(JSON.stringify(pod));
}
if(args.includes('exec')) {
 if(args.includes('uname')) {
  if(scenario === 'kernel-timeout') {
   setTimeout(() => process.stdout.write('5.10.134-18.0.13.lifsea8.x86_64\\n'), 6500);
  } else if(scenario === 'kernel-unavailable') {
   process.stderr.write('RAW_SECRET_SENTINEL\\n');
   process.exitCode=1;
  } else process.stdout.write('5.10.134-18.0.13.lifsea8.x86_64\\n' + (scenario === 'invalid-kernel-release' ? 'RAW_SECRET_SENTINEL\\n' : ''));
 } else if(['landlock-unavailable', 'landlock-denied', 'runtime-class-enosys', 'unsupported'].includes(scenario)) {
  process.stdout.write('RAW_SECRET_SENTINEL\\n');
  process.stderr.write((scenario === 'unsupported'
   ? 'setpriv: failed to execute /bin/true: Function not implemented'
   : 'setpriv: landlock_create_ruleset failed: ' + (scenario === 'landlock-denied' ? 'Operation not permitted' : 'Function not implemented')) + '\\nRAW_SECRET_SENTINEL\\n');
  process.exitCode=127;
 }
}
`,
				{ mode: 0o700 },
			);
			const state = join(directory, "pod.json");
			const log = join(directory, "calls.jsonl");
			const result = spawnSync(process.execPath, [script.pathname], {
				encoding: "utf8",
				env: {
					...process.env,
					ACK_KUBECONFIG: join(directory, "config"),
					ACK_RUNTIME_IMAGE:
						scenario === "invalid-image"
							? "runtime:latest"
							: `registry.example.test/runtime@sha256:${"a".repeat(64)}`,
					ACK_RUNTIME_DRIVER: "codex",
					ACK_RUNTIME_CLASS: scenario.startsWith("runtime-class") ? "runv" : "",
					ACK_RUNTIME_PLACEMENT_FILE: "",
					KUBECTL_BIN: binary,
					PROBE_TEST_LOG: log,
					PROBE_TEST_STATE: state,
					PROBE_TEST_SCENARIO: scenario,
				},
			});
			assert.equal(
				result.status,
				[
					"passed",
					"runtime-class",
					"kernel-unavailable",
					"kernel-timeout",
					"invalid-kernel-release",
				].includes(scenario)
					? 0
					: 1,
			);
			assert.equal(
				(result.stdout + result.stderr).includes("RAW_SECRET_SENTINEL"),
				false,
			);
			if (scenario === "invalid-image") {
				await assert.rejects(readFile(log), { code: "ENOENT" });
				return;
			}
			const calls = (await readFile(log, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			assert.equal(
				calls.some((args) => args.includes("delete")),
				scenario !== "ownership-changed",
			);
			const pod = JSON.parse(await readFile(state, "utf8"));
			assert.equal(pod.spec.automountServiceAccountToken, false);
			assert.equal(
				pod.spec.securityContext.seccompProfile.type,
				"RuntimeDefault",
			);
			assert.equal(
				pod.spec.containers[0].securityContext.allowPrivilegeEscalation,
				false,
			);
			assert.equal(
				pod.spec.runtimeClassName,
				scenario.startsWith("runtime-class") ? "runv" : undefined,
			);
			if (scenario !== "ownership-changed") {
				const execute = calls.find(
					(args) => args.includes("setpriv") || args.includes("bwrap"),
				);
				assert.deepEqual(
					execute.slice(execute.indexOf("--") + 1),
					scenario.startsWith("runtime-class")
						? [
								"bwrap",
								"--unshare-user",
								"--unshare-pid",
								"--unshare-net",
								"--die-with-parent",
								"--ro-bind",
								"/",
								"/",
								"--proc",
								"/proc",
								"--dev",
								"/dev",
								"/bin/true",
							]
						: [
								"setpriv",
								"--no-new-privs",
								"--landlock-access",
								"fs:ioctl-dev",
								"--",
								"/bin/true",
							],
				);
			}
			if (scenario === "passed")
				assert.equal(
					JSON.parse(result.stdout.trim().split("\n").at(-1))
						.businessConversationVerified,
					false,
				);
			if (scenario === "landlock-unavailable") {
				const failure = JSON.parse(result.stderr.trim());
				assert.equal(failure.status, "failed");
				assert.equal(failure.stage, "landlock-installation");
				assert.equal(failure.reason, "landlock_unavailable");
				assert.equal(failure.exitCode, 127);
				assert.equal(failure.kernelRelease, "5.10.134-18.0.13.lifsea8.x86_64");
				assert.equal(failure.node, "controlled-node");
				assert.equal(failure.podUid, "11111111-2222-4333-8444-555555555555");
				assert.equal(
					result.stderr.includes("landlock_create_ruleset failed"),
					false,
				);
			}
			if (
				["unsupported", "landlock-denied", "runtime-class-enosys"].includes(
					scenario,
				)
			) {
				const failure = JSON.parse(result.stderr.trim());
				assert.equal(
					failure.stage,
					scenario === "runtime-class-enosys"
						? "native-namespace"
						: "landlock-installation",
				);
				assert.equal(failure.exitCode, 127);
				assert.equal(failure.reason, undefined);
			}
			if (
				[
					"kernel-unavailable",
					"kernel-timeout",
					"invalid-kernel-release",
				].includes(scenario)
			) {
				const success = JSON.parse(result.stdout.trim().split("\n").at(-1));
				assert.equal(success.status, "passed");
				assert.equal(success.kernelRelease, undefined);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}
