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
	"unsupported",
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
if(args.includes('create')) fs.writeFileSync(state, fs.readFileSync(0));
if(args.includes('get')) {
 const pod = JSON.parse(fs.readFileSync(state));
 pod.spec.nodeName = 'controlled-node';
 if(process.env.PROBE_TEST_SCENARIO === 'ownership-changed') pod.metadata.labels['agent-infra.agora.io/runtime-preflight']='another-owner';
 process.stdout.write(JSON.stringify(pod));
}
if(args.includes('exec') && process.env.PROBE_TEST_SCENARIO === 'unsupported') process.exitCode=1;
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
					ACK_RUNTIME_PLACEMENT_FILE: "",
					KUBECTL_BIN: binary,
					PROBE_TEST_LOG: log,
					PROBE_TEST_STATE: state,
					PROBE_TEST_SCENARIO: scenario,
				},
			});
			assert.equal(result.status, scenario === "passed" ? 0 : 1);
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
			if (scenario !== "ownership-changed") {
				const execute = calls.find((args) => args.includes("exec"));
				assert.deepEqual(execute.slice(execute.indexOf("--") + 1), [
					"setpriv",
					"--no-new-privs",
					"--landlock-access",
					"fs:ioctl-dev",
					"--",
					"/bin/true",
				]);
			}
			if (scenario === "passed")
				assert.equal(
					JSON.parse(result.stdout.trim().split("\n").at(-1))
						.businessConversationVerified,
					false,
				);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}
