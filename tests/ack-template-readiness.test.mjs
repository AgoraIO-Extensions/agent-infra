import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateTemplatePreflightJob } from "../deploy/ack/template-model-preflight.mjs";

const script = new URL(
	"../deploy/ack/template-model-preflight.mjs",
	import.meta.url,
).pathname;
const baseJob = {
	schemaVersion: 1,
	scope: "isolated-template-real-model",
	kubeconfig: "/private/kubeconfig",
	namespace: "test-ack",
	sourceCommit: "a".repeat(40),
	templateId: "claude",
	driver: "claude",
	protocol: "anthropic-messages-v1",
	operatorApprovalRef: "approved-fixture",
	worktree: "/private/source",
	outputDirectory: "/private/output",
	imageReference: `registry.example.test/runtime@sha256:${"b".repeat(64)}`,
	imageDigest: `sha256:${"b".repeat(64)}`,
	modelId: "test-model",
	modelOptionId: "test:model",
	reasoningLevel: "high",
	configurationRevision: "rev-1",
	runtimeConfigVersion: "v1",
	approvedRelayOrigin: "https://relay.example.test",
	grantPrivateKeyFile: "/private/grant",
	runtimeServiceTokenFile: "/private/token",
	relayKeyFile: "/private/key",
	expectedResourceLimits: { cpu: "1", memory: "2Gi" },
	placement: { nodeSelector: { type: "virtual-kubelet" } },
};

test("template readiness budget defaults and bounds are validated without changing the input", () => {
	assert.equal(
		validateTemplatePreflightJob(baseJob).podReadyTimeoutSeconds,
		900,
	);
	assert.equal(Object.hasOwn(baseJob, "podReadyTimeoutSeconds"), false);
	for (const value of [60, 900, 1800])
		assert.equal(
			validateTemplatePreflightJob({
				...baseJob,
				podReadyTimeoutSeconds: value,
			}).podReadyTimeoutSeconds,
			value,
		);
	for (const value of [
		null,
		0,
		59,
		1801,
		60.5,
		"900",
		true,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])
		assert.throws(
			() =>
				validateTemplatePreflightJob({
					...baseJob,
					podReadyTimeoutSeconds: value,
				}),
			/POD_READY_TIMEOUT_INVALID/u,
		);
});

for (const scenario of [
	"default-wait-failed",
	"custom-wait-failed",
	"unsafe-reason",
	"readback-failed",
	"identity-drift",
	"ready-continues",
	"invalid-budget",
]) {
	test(`template readiness executes and cleans its owned resources: ${scenario}`, async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "ack-ready-"));
		t.after(() => rm(directory, { recursive: true, force: true }));
		const bin = join(directory, "bin");
		await mkdir(bin);
		const log = join(directory, "calls.jsonl");
		const state = join(directory, "pod.json");
		const secret = "fixture-secret-must-not-appear";
		const grant = join(directory, "grant.pem");
		const token = join(directory, "token");
		const { privateKey } = generateKeyPairSync("ed25519");
		await writeFile(
			grant,
			privateKey.export({ type: "pkcs8", format: "pem" }),
			{ mode: 0o600 },
		);
		await writeFile(token, secret, { mode: 0o600 });
		const output = join(directory, "output");
		const job = {
			...baseJob,
			outputDirectory: output,
			grantPrivateKeyFile: grant,
			runtimeServiceTokenFile: token,
			...(scenario === "custom-wait-failed"
				? { podReadyTimeoutSeconds: 1800 }
				: {}),
			...(scenario === "invalid-budget"
				? { podReadyTimeoutSeconds: 1801 }
				: {}),
		};
		const file = join(directory, "job.json");
		await writeFile(file, JSON.stringify(job), { mode: 0o600 });
		await writeFile(
			join(bin, "kubectl"),
			`#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2),scenario=${JSON.stringify(scenario)},secret=${JSON.stringify(secret)};
const log=${JSON.stringify(log)},state=${JSON.stringify(state)};
fs.appendFileSync(log,JSON.stringify(args)+'\\n');
if(args.includes('create')&&args.includes('secret')){console.log('{}');process.exit(0);}
if(args.includes('apply')){fs.readFileSync(0);process.exit(0);}
if(args.includes('create')){fs.writeFileSync(state,fs.readFileSync(0));process.exit(0);}
if(args.includes('wait')){if(scenario==='ready-continues')process.exit(0);console.error(secret);process.exit(1);}
if(args.includes('get')){
 if(scenario==='readback-failed'){console.error(secret);process.exit(1);}
 const pod=JSON.parse(fs.readFileSync(state));pod.status={phase:'Pending',containerStatuses:[{state:{waiting:{reason:scenario==='unsafe-reason'?secret:'ContainerCreating',message:secret}}}]};
 if(scenario==='identity-drift')pod.metadata.labels['agent-infra.validation-owner']='different-owner';
 console.log(JSON.stringify(pod));process.exit(0);
}
if(args.includes('port-forward')){console.error(secret);process.exit(1);}
`,
			{ mode: 0o700 },
		);
		const result = spawnSync(process.execPath, [script, file], {
			encoding: "utf8",
			timeout: 15_000,
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		});
		assert.equal(result.status, 1);
		assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
		if (scenario === "invalid-budget") {
			await assert.rejects(readFile(log), { code: "ENOENT" });
			assert.match(result.stderr, /POD_READY_TIMEOUT_INVALID/u);
			return;
		}
		const calls = (await readFile(log, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const wait = calls.find((args) => args.includes("wait"));
		assert.equal(
			wait.at(-1),
			scenario === "custom-wait-failed" ? "--timeout=1800s" : "--timeout=900s",
		);
		const pod = JSON.parse(await readFile(state, "utf8"));
		const deleted = calls
			.filter((args) => args.includes("delete"))
			.map((args) =>
				args.slice(args.indexOf("delete") + 1, args.indexOf("delete") + 3),
			);
		assert.deepEqual(deleted, [
			["pod", pod.metadata.name],
			["secret", pod.metadata.name],
		]);
		const receiptFile = join(output, "pod-readiness-failure.json");
		if (scenario === "ready-continues") {
			assert(calls.some((args) => args.includes("port-forward")));
			await assert.rejects(readFile(receiptFile), { code: "ENOENT" });
			return;
		}
		assert.equal(
			calls.some(
				(args) => args.includes("port-forward") || args.includes("exec"),
			),
			false,
		);
		const receiptBytes = await readFile(receiptFile, "utf8");
		assert.equal(receiptBytes.includes(secret), false);
		const receipt = JSON.parse(receiptBytes);
		assert.equal(receipt.stage, "pod-ready");
		assert.equal(receipt.modelCallAttempted, false);
		assert.equal(receipt.imageDigest, job.imageDigest);
		assert.equal(receipt.sourceSha, job.sourceCommit);
		assert.equal(
			receipt.podReadyTimeoutSeconds,
			scenario === "custom-wait-failed" ? 1800 : 900,
		);
		assert.equal(
			receipt.readback,
			scenario === "readback-failed"
				? "unavailable"
				: scenario === "identity-drift"
					? "identity-mismatch"
					: "matched",
		);
		if (receipt.readback === "matched")
			assert.deepEqual(receipt.waitingReasons, [
				scenario === "unsafe-reason" ? "Unknown" : "ContainerCreating",
			]);
		assert.match(result.stderr, /TEMPLATE_POD_READINESS_FAILED/u);
	});
}
