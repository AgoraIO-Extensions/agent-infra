import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as preflight from "../deploy/ack/template-model-preflight.mjs";
import { templatePreflightValidationReceipt } from "../deploy/ack/template-validation.mjs";

const {
	projectPodStartupReceipt,
	validateTemplatePreflightJob,
	renderTemplatePreflightPod,
	observeTemplatePreflightLayout,
} = preflight;

const script = new URL(
	"../deploy/ack/template-model-preflight.mjs",
	import.meta.url,
).pathname;

test("template model config binds the relay credential into the V4 option", async () => {
	const source = await readFile(script, "utf8");
	assert.match(
		source,
		/--from-file=model-credential=\$\{modelCredentialFile\}/u,
	);
	assert.match(source, /modelCredentialFile/);
	assert.match(source, /writeFile\(modelCredentialFile, modelCredential/u);
});
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

test("Codex SDK preflight uses Responses and its private Codex companion", () => {
	const job = {
		...baseJob,
		templateId: "codex",
		driver: "codex",
		protocol: "openai-responses-v1",
		transport: "paseo-sdk-pod",
		resourceProfileRef: "codex-sdk-test",
		storageClassName: "disk",
		storageSize: "20Gi",
		modelEgress: [{ destination: { ip: "192.0.2.1" }, port: 443 }],
		dnsEgress: [{ ip: "192.0.2.2" }],
	};
	assert.equal(validateTemplatePreflightJob(job).driver, "codex");
	const { pod, binding } = renderTemplatePreflightPod({
		job,
		owner: "codex-sdk-test",
		publicKey: "public",
		modelConfig: "{}",
		serviceToken: "synthetic-service-token",
	});
	assert.equal(binding, undefined);
	assert.equal(pod.spec.containers.length, 2);
	assert.equal(pod.spec.containers[1].name, "pi-paseo");
	assert.deepEqual(pod.spec.containers[1].env, [
		{ name: "AGENT_INFRA_PASEO_PROVIDER", value: "codex" },
	]);
	assert.equal(pod.spec.shareProcessNamespace, false);
	assert.deepEqual(
		pod.spec.containers[0].env.filter(
			(entry) => entry.name === "AGENT_INFRA_RUNTIME_TRANSPORT",
		),
		[{ name: "AGENT_INFRA_RUNTIME_TRANSPORT", value: "paseo-sdk-pod" }],
	);
	for (const invalid of [
		{ ...job, driver: "pi" },
		{ ...job, protocol: "anthropic-messages-v1" },
		{ ...job, transport: "paseo-sdk" },
	])
		assert.throws(() => validateTemplatePreflightJob(invalid));
});

test("Claude SDK Pod preflight uses Messages and its private Claude companion", () => {
	const job = {
		...baseJob,
		transport: "paseo-sdk-pod",
		resourceProfileRef: "claude-sdk-test",
		storageClassName: "disk",
		storageSize: "20Gi",
		modelEgress: [{ destination: { ip: "192.0.2.1" }, port: 443 }],
		dnsEgress: [{ ip: "192.0.2.2" }],
	};
	const { pod } = renderTemplatePreflightPod({
		job: validateTemplatePreflightJob(job),
		owner: "claude-sdk-test",
		publicKey: "public",
		modelConfig: "{}",
		serviceToken: "synthetic",
	});
	assert.equal(pod.spec.containers.length, 2);
	assert.equal(pod.spec.containers[1].name, "claude-paseo");
	assert.deepEqual(pod.spec.containers[1].env, [
		{ name: "AGENT_INFRA_PASEO_PROVIDER", value: "claude" },
	]);
	assert.equal(pod.spec.shareProcessNamespace, false);
	assert.deepEqual(
		pod.spec.containers[0].env.filter(
			(entry) => entry.name === "AGENT_INFRA_RUNTIME_TRANSPORT",
		),
		[{ name: "AGENT_INFRA_RUNTIME_TRANSPORT", value: "paseo-sdk-pod" }],
	);
	for (const invalid of [
		{ ...job, driver: "pi" },
		{ ...job, protocol: "openai-responses-v1" },
		{ ...job, transport: "paseo-sdk" },
	])
		assert.throws(() => validateTemplatePreflightJob(invalid));
});

test("OpenCode preflight renders the CPU split selected for that SDK image", () => {
	const job = {
		...baseJob,
		templateId: "opencode",
		driver: "acp",
		transport: "paseo-sdk-pod",
		companionCpuLimitPercent: 80,
		resourceProfileRef: "opencode-sdk-test",
		storageClassName: "disk",
		storageSize: "20Gi",
		modelEgress: [{ destination: { ip: "192.0.2.1" }, port: 443 }],
		dnsEgress: [{ ip: "192.0.2.2" }],
	};
	const { pod } = renderTemplatePreflightPod({
		job: validateTemplatePreflightJob(job),
		owner: "opencode-sdk-test",
		publicKey: "public",
		modelConfig: "{}",
		serviceToken: "synthetic",
	});
	assert.deepEqual(
		pod.spec.containers.map((c) => [c.name, c.resources.limits.cpu]),
		[
			["runtime", "200m"],
			["opencode-paseo", "800m"],
		],
	);
	for (const change of [
		{ transport: undefined },
		{ templateId: "pi", driver: "pi" },
		{ companionCpuLimitPercent: 50 },
	]) {
		assert.throws(
			() => validateTemplatePreflightJob({ ...job, ...change }),
			/PREFLIGHT_TRANSPORT_INVALID/u,
		);
	}
});

test("Pi SDK preflight selects the same transport as its session Pod and keeps the model key execution scoped", () => {
	const job = {
		...baseJob,
		templateId: "pi",
		driver: "pi",
		transport: "paseo-sdk",
	};
	const { pod } = renderTemplatePreflightPod({
		job,
		owner: "pi-test",
		publicKey: "public",
		modelConfig: "{}",
		serviceToken: "test",
	});
	assert.deepEqual(
		pod.spec.containers[0].env.filter(
			(e) => e.name === "AGENT_INFRA_RUNTIME_TRANSPORT",
		),
		[{ name: "AGENT_INFRA_RUNTIME_TRANSPORT", value: "paseo-sdk" }],
	);
	assert.equal(
		pod.metadata.annotations["k8s.aliyun.com/eci-auto-imc"],
		"false",
	);
	assert.throws(() =>
		validateTemplatePreflightJob({ ...job, driver: "claude" }),
	);
	assert.throws(() =>
		validateTemplatePreflightJob({ ...job, protocol: "openai-responses-v1" }),
	);
});

test("Codex SDK runner produces receipts from the original Codex Paseo journal after a V1 reply", async () => {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "codex-sdk-runner-")),
	);
	try {
		const save = async (name, value) => {
			const file = join(directory, name);
			await writeFile(file, value, { mode: 0o600 });
			return file;
		};
		const owner = "11111111-1111-4111-8111-111111111111";
		const preflightJob = {
			...baseJob,
			templateId: "codex",
			driver: "codex",
			protocol: "openai-responses-v1",
			transport: "paseo-sdk-pod",
			resourceProfileRef: "codex-sdk-test",
			storageSize: "20Gi",
			storageClassName: "disk",
			modelEgress: [{ destination: { ip: "192.0.2.1" }, port: 443 }],
			dnsEgress: [{ ip: "192.0.2.2" }],
		};
		const job = {
			...preflightJob,
			worktree: process.cwd(),
			outputDirectory: join(directory, "output"),
			containerName: "ack-preflight-codex-11111111",
			agentId: "template-validation-agent-codex-11111111",
			runtimeBaseUrl: "http://127.0.0.1:3003/",
			runtimeModuleSha256: "c".repeat(64),
			grantIssuer: "ack-template-validation",
			workerId: "ack-template-validator",
			grantKeyId: "fixture",
			grantPrivateKeyFile: await save(
				"grant.pem",
				generateKeyPairSync("ed25519").privateKey.export({
					type: "pkcs8",
					format: "pem",
				}),
			),
			runtimeServiceTokenFile: await save(
				"service-token",
				"synthetic-service-token",
			),
			relayKeyFile: await save("relay-key", "synthetic-relay-key"),
		};
		const modelConfig = {
			schemaVersion: 4,
			configVersion: job.runtimeConfigVersion,
			defaultModelOptionId: job.modelOptionId,
			defaultReasoningLevel: job.reasoningLevel,
			modelOptions: [
				{
					modelOptionId: job.modelOptionId,
					protocol: job.protocol,
					authentication: "bearer",
					endpoint: job.approvedRelayOrigin + "/v1",
					model: job.modelId,
					reasoningLevels: [job.reasoningLevel],
				},
			],
		};
		const { pod } = renderTemplatePreflightPod({
			job: preflightJob,
			owner,
			publicKey: "synthetic-public-key",
			modelConfig: JSON.stringify(modelConfig),
			serviceToken: "synthetic-service-token",
		});
		pod.metadata.uid = "33333333-3333-4333-8333-333333333333";
		pod.spec.nodeName = "virtual-kubelet-test";
		pod.status = {
			phase: "Running",
			containerStatuses: [
				{ name: "runtime", imageID: "containerd://" + job.imageDigest },
			],
		};
		const jobFile = await save("job.json", JSON.stringify(job));
		const fixtureFile = await save(
			"fixture.json",
			JSON.stringify({ job, pod, directory }),
		);
		// Only this subprocess replaces kubectl/HTTP. The real proof CLI reads an actual protected journal.
		const preload = await save(
			"fixture.mjs",
			`
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const { job, pod, directory } = JSON.parse(fs.readFileSync(process.env.ACK_SDK_RUNNER_FIXTURE, 'utf8'));
const originalExec = childProcess.execFileSync;
const originalNow = Date.now;
let elapsedDuringSubmit = 0;
let elapsedInTransit = 0;
const monotonicNow = performance.now.bind(performance);
Object.defineProperty(performance, 'now', { value: () => monotonicNow() + elapsedInTransit });
let renewed = false;
let observedHostSecond;
Date.now = () => originalNow() + elapsedDuringSubmit;
childProcess.execFileSync = (command, args, options) => {
  if (command !== 'kubectl') throw new Error('UNEXPECTED_COMMAND');
  if (args[4] === 'get') return JSON.stringify(pod);
  const scriptIndex = args.indexOf('-e');
  const script = args[scriptIndex + 1];
  if (script.includes('console.log(Date.now())')) {
    if (elapsedDuringSubmit) throw new Error('POD_EXEC_BUSY_AFTER_ACCEPT');
    return String(Date.now());
  }
  if (script.includes('createHash')) return job.runtimeModuleSha256;
  const proofArgs = args.slice(scriptIndex + 2);
  fs.appendFileSync(path.join(directory, 'proof-roots.jsonl'), JSON.stringify(proofArgs[0]) + '\\n');
  proofArgs[0] = path.join(directory, proofArgs[0].replace('/var/lib/agent-runtime/', ''));
  return originalExec(process.execPath, ['-e', script, ...proofArgs], options);
};
syncBuiltinESMExports();
globalThis.fetch = async (url, options) => {
  const route = new URL(url).pathname;
  if (route === '/healthz') {
    if (options.redirect !== 'error' || options.headers?.authorization || options.body) throw new Error('UNEXPECTED_HEALTH_REQUEST');
    const outcome = process.env.ACK_SDK_FIXTURE_OUTCOME;
    let hostNow = Date.now();
    if (outcome === 'completed' && observedHostSecond === undefined) hostNow -= 1000;
    if (outcome === 'expired-clock') hostNow += 60000;
    if (outcome === 'delayed-clock') {
      hostNow += 2000;
      elapsedInTransit = 31000;
    }
    const date = new Date(hostNow).toUTCString();
    observedHostSecond = Date.parse(date);
    return new Response(null, { headers: { date } });
  }
  const request = JSON.parse(options.body);
  if (route.endsWith('/authorizations/renew')) {
    renewed = true;
    return Response.json({ schemaVersion: 3, executionId: request.executionId, expiresAt: Date.now()+30000 });
  }
  if (route.endsWith('/turns')) {
    const r = request.businessRequest;
    const claims = JSON.parse(Buffer.from(r.grant.token.split('.')[1], 'base64url'));
    if (observedHostSecond < claims.issuedAt) throw new Error('GRANT_NOT_YET_VALID');
    if (['expired-clock', 'delayed-clock'].includes(process.env.ACK_SDK_FIXTURE_OUTCOME)) {
      fs.writeFileSync(path.join(directory, 'unexpected-clock-submit'), 'sent');
    }
    if (process.env.ACK_SDK_FIXTURE_OUTCOME === 'submit-error') {
      const intentPath = path.join(directory, 'submit-error-output', 'submit-intent.json');
      const observed = { requestId: r.requestId, executionId: r.executionId, intentPresent: fs.existsSync(intentPath) };
      fs.appendFileSync(path.join(directory, 'submitted.jsonl'), JSON.stringify(observed) + '\\n');
      return Response.json({ code: 'RUNTIME_DRIVER_INVALID' }, { status: 503 });
    }
    const ref = '22222222-2222-4222-8222-222222222222';
    const binding = { ref, agentId: r.agentId, conversationId: r.conversationId, sessionGeneration: r.sessionGeneration };
    const root = path.join(directory, 'codex-paseo-driver');
    fs.mkdirSync(path.join(root, ref), { recursive: true });
    fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ sessions: [binding] }));
    const fact = { kind: 'model', phase: 'completed', operationRef: 'model-1', attemptRef: 'attempt-1',
      model: { configVersion: job.runtimeConfigVersion, modelOptionId: job.modelOptionId, modelId: job.modelId, reasoningLevel: job.reasoningLevel } };
    fs.writeFileSync(path.join(root, ref, 'state.json'), JSON.stringify({ binding, nativeId: 'paseo:' + ref,
      messages: ['PRIVATE-JOURNAL-SENTINEL'], turns: [{ executionId: r.executionId, turnId: r.turnId, status: 'completed', configVersion: job.runtimeConfigVersion, operationFacts: [fact] }] }));
    if (process.env.ACK_SDK_FIXTURE_OUTCOME === 'completed') elapsedDuringSubmit = 16000;
    return Response.json({ schemaVersion: 4, hostSessionRef: 'host-session', operationId: r.executionId, result: { outcome: 'accepted', status: 'completed' } });
  }
  if (route.endsWith('/events/read')) {
    if (elapsedDuringSubmit && !renewed) throw new Error('RENEWAL_MISSING');
    const base = { schemaVersion: 1, executionId: request.executionId, occurredAt: new Date().toISOString() };
    if (process.env.ACK_SDK_FIXTURE_OUTCOME !== 'completed') {
      const payload = { kind: 'model', phase: 'unknown', operationRef: 'model-1', attemptRef: 'attempt-1',
        failureCode: 'response_incomplete', durationMs: 37,
        model: { configVersion: job.runtimeConfigVersion, modelOptionId: job.modelOptionId, modelId: job.modelId, reasoningLevel: job.reasoningLevel } };
      return Response.json({ schemaVersion: 4, hostSessionRef: 'host-session', executionId: request.executionId, events: [
        { ...base, adapterEventKey: 'text-1', cursor: 'cursor-1', type: 'text', payload: { delta: 'PRIVATE-JOURNAL-SENTINEL' } },
        process.env.ACK_SDK_FIXTURE_OUTCOME === 'unknown'
          ? { ...base, schemaVersion: 2, adapterEventKey: 'operation-1', cursor: 'cursor-2', type: 'operation', payload }
          : { ...base, adapterEventKey: 'completed-1', cursor: 'cursor-2', type: 'completed', payload: { status: 'failed' } },
      ] });
    }
    return Response.json({ schemaVersion: 4, hostSessionRef: request.hostSessionRef, executionId: request.executionId, events: [
      { ...base, adapterEventKey: 'text-1', cursor: 'cursor-1', type: 'text', payload: { delta: 'READY' } },
      { ...base, adapterEventKey: 'completed-1', cursor: 'cursor-2', type: 'completed', payload: { status: 'completed' } },
    ] });
  }
  throw new Error('UNEXPECTED_HTTP_ROUTE');
};
`,
		);
		const run = (file, outcome) =>
			spawnSync(
				process.execPath,
				[
					"--import",
					preload,
					new URL(
						"../deploy/ack/template-model-preflight-runner.mts",
						import.meta.url,
					).pathname,
					file,
				],
				{
					encoding: "utf8",
					timeout: 15_000,
					env: {
						...process.env,
						ACK_SDK_RUNNER_FIXTURE: fixtureFile,
						ACK_SDK_FIXTURE_OUTCOME: outcome,
					},
				},
			);
		const result = run(jobFile, "completed");
		assert.equal(result.status, 0, result.stdout + result.stderr);
		for (const outcome of ["expired-clock", "delayed-clock"]) {
			const output = join(directory, outcome);
			const clockJob = await save(
				outcome + "-job.json",
				JSON.stringify({ ...job, outputDirectory: output }),
			);
			const rejected = run(clockJob, outcome);
			assert.equal(rejected.status, 1);
			assert.match(rejected.stderr, /actual-runtime-submit/);
			await assert.rejects(stat(join(output, "submit-intent.json")), {
				code: "ENOENT",
			});
		}
		await assert.rejects(stat(join(directory, "unexpected-clock-submit")), {
			code: "ENOENT",
		});
		const failedOutput = join(directory, "submit-error-output");
		const failedJob = await save(
			"submit-error-job.json",
			JSON.stringify({
				...job,
				outputDirectory: failedOutput,
			}),
		);
		const firstSubmit = run(failedJob, "submit-error");
		assert.equal(firstSubmit.status, 1);
		assert.match(firstSubmit.stderr, /RUNTIME_DRIVER_INVALID/);
		const attempted = JSON.parse(
			await readFile(join(directory, "submitted.jsonl"), "utf8"),
		);
		const intentPath = join(failedOutput, "submit-intent.json");
		const intentText = await readFile(intentPath, "utf8");
		const intent = JSON.parse(intentText);
		assert.equal(attempted.intentPresent, true);
		assert.equal((await stat(intentPath)).mode & 0o777, 0o600);
		assert.equal(intent.podUid, pod.metadata.uid);
		assert.equal(intent.frozen.requestId, attempted.requestId);
		assert.equal(intent.frozen.executionId, attempted.executionId);
		assert.equal(intent.sourceCommit, job.sourceCommit);
		assert.equal(intent.imageDigest, job.imageDigest);
		assert.doesNotMatch(
			intentText,
			/synthetic-relay-key|synthetic-service-token|BEGIN PRIVATE KEY|Reply with the single word/,
		);
		const repeated = run(failedJob, "submit-error");
		assert.equal(repeated.status, 1);
		assert.match(repeated.stderr, /original-runtime-submit-unconfirmed/);
		assert.deepEqual(
			JSON.parse(await readFile(join(directory, "submitted.jsonl"), "utf8")),
			attempted,
		);
		assert.equal(await readFile(intentPath, "utf8"), intentText);
		const receipt = JSON.parse(
			await readFile(
				join(job.outputDirectory, "template-model-preflight.receipt.json"),
				"utf8",
			),
		);
		assert.equal(receipt.modelOperationCount, 1);
		assert.equal(receipt.transportEvidence, "original-codex-driver-session");
		assert.equal(receipt.terminalStatus, "completed");
		assert.deepEqual(
			(await readFile(join(directory, "proof-roots.jsonl"), "utf8"))
				.trim()
				.split("\n")
				.map(JSON.parse),
			[
				"/var/lib/agent-runtime/codex-paseo-driver",
				"/var/lib/agent-runtime/codex-paseo-driver",
			],
		);
		assert.equal(
			JSON.stringify(receipt).includes("PRIVATE-JOURNAL-SENTINEL"),
			false,
		);
		for (const outcome of ["unknown", "failed"]) {
			const input = await save(
				outcome + "-job.json",
				JSON.stringify({
					...job,
					outputDirectory: join(directory, outcome + "-output"),
				}),
			);
			const rejected = run(input, outcome);
			assert.equal(rejected.status, 1, rejected.stderr);
			const expected =
				outcome === "failed"
					? { completedStatus: "failed" }
					: {
							eventType: "operation",
							kind: "model",
							phase: "unknown",
							failureCode: "response_incomplete",
							durationMs: 37,
						};
			assert.ok(
				rejected.stdout.split("\n").includes(JSON.stringify(expected)),
				rejected.stdout,
			);
			assert.doesNotMatch(
				rejected.stdout + rejected.stderr,
				/PRIVATE-JOURNAL-SENTINEL/,
			);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Pi SDK container mounts only its workspace, state and scoped launch channel", () => {
	const job = {
		...baseJob,
		resourceProfileRef: "pi-test",
		storageClassName: "disk",
		storageSize: "1Gi",
		modelEgress: [{ destination: { ip: "192.0.2.1" }, port: 443 }],
		dnsEgress: [{ ip: "192.0.2.2" }],
		templateId: "pi",
		driver: "pi",
		transport: "paseo-sdk-pod",
	};
	const { pod } = renderTemplatePreflightPod({
		job,
		owner: "pi-test",
		publicKey: "public",
		modelConfig: "{}",
		serviceToken: "test",
	});
	const [host, pi] = pod.spec.containers;
	assert.equal(pi.image, host.image);
	assert.equal(pi.env, undefined);
	assert.equal(pod.spec.shareProcessNamespace, false);
	assert.deepEqual(
		pi.volumeMounts
			.filter((m) => m.name === "data")
			.map((m) => m.subPath)
			.sort(),
		["pi-paseo-state", "pi-paseo-workspaces"],
	);
	assert.deepEqual(
		pi.volumeMounts
			.filter((m) => m.name === "pi-requests")
			.map((m) => m.readOnly),
		[true],
	);
	assert.equal(pi.securityContext.allowPrivilegeEscalation, false);
	for (const c of [host, pi]) assert.equal(c.resources.limits.cpu, "500m");
});
test("Pi validation receipt keeps the execution and its verified SDK transport", () => {
	const measured = {
		templateId: "pi",
		executionId: "e",
		transport: "paseo-sdk",
		transportEvidence: "original-pi-driver-session",
	};
	const receipt = templatePreflightValidationReceipt(measured);
	assert.equal(receipt.schemaVersion, 3);
	assert.equal(receipt.executionId, "e");
	assert.equal(receipt.transport, "paseo-sdk");
	assert.equal(receipt.transportEvidence, measured.transportEvidence);
	assert.throws(() =>
		templatePreflightValidationReceipt({
			...measured,
			transportEvidence: undefined,
		}),
	);
});

test("SDK session proof reads only original model facts and keeps other journal contents private", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-proof-")));
	try {
		const ref = "aa123456-1234-1234-1234-123456789012";
		const binding = {
			ref,
			agentId: "a",
			conversationId: "c",
			sessionGeneration: 1,
		};
		await mkdir(join(root, ref));
		await writeFile(
			join(root, "index.json"),
			JSON.stringify({ sessions: [binding] }),
		);
		const file = join(root, ref, "state.json");
		const state = {
			binding,
			nativeId: "paseo:" + ref,
			messages: ["PRIVATE-JOURNAL-SENTINEL"],
			turns: [
				{
					turnId: "t",
					executionId: "e",
					status: "completed",
					configVersion: "v",
					operationFacts: [
						{ kind: "model", phase: "completed", operationRef: "model-1" },
						{ kind: "tool", summary: "PRIVATE-JOURNAL-SENTINEL" },
					],
				},
			],
		};
		const script = await readFile(
			new URL("../deploy/ack/pi-session-proof.cjs", import.meta.url),
			"utf8",
		);
		const run = (mode) =>
			spawnSync(
				process.execPath,
				[
					"-e",
					script,
					root,
					"a",
					"c",
					"1",
					"e",
					"t",
					"v",
					...(mode ? [mode] : []),
				],
				{ encoding: "utf8" },
			);
		await writeFile(file, JSON.stringify(state));
		assert.equal(run().stdout, "1");
		assert.deepEqual(JSON.parse(run("model-facts").stdout), [
			{ kind: "model", phase: "completed", operationRef: "model-1" },
		]);
		for (const content of [
			"PRIVATE-JOURNAL-SENTINEL",
			JSON.stringify({ ...state, nativeId: "legacy" }),
			JSON.stringify({
				...state,
				turns: [{ ...state.turns[0], turnId: "another" }],
			}),
			JSON.stringify({
				...state,
				binding: { ...binding, conversationId: "foreign-conversation" },
			}),
			JSON.stringify({ ...state, turns: [state.turns[0], state.turns[0]] }),
		]) {
			await writeFile(file, content);
			for (const mode of [undefined, "model-facts"]) {
				const result = run(mode);
				assert.equal(result.status, 1);
				assert.equal(result.stdout + result.stderr, "");
			}
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("preflight target provenance binds the real cluster, namespace UID and installation before and after execution", () => {
	const target = {
		sourceCommit: baseJob.sourceCommit,
		clusterUid: "cluster-a",
		namespace: baseJob.namespace,
		namespaceUid: "namespace-a",
		installationId: "installation-a",
	};
	const job = { ...baseJob, validationContext: target };
	const cluster = { metadata: { uid: target.clusterUid } };
	const namespace = {
		metadata: {
			name: target.namespace,
			uid: target.namespaceUid,
			labels: { "agent-infra.agora.io/bootstrap-id": target.installationId },
		},
	};
	assert.deepEqual(
		preflight.assertTemplatePreflightTarget(job, cluster, namespace),
		target,
	);
	for (const actual of [
		{ ...namespace, metadata: { ...namespace.metadata, uid: "replaced" } },
		{
			...namespace,
			metadata: {
				...namespace.metadata,
				labels: { "agent-infra.agora.io/bootstrap-id": "foreign" },
			},
		},
		{
			...namespace,
			metadata: {
				...namespace.metadata,
				deletionTimestamp: "2026-11-11T00:00:00Z",
			},
		},
	])
		assert.throws(
			() => preflight.assertTemplatePreflightTarget(job, cluster, actual),
			/PREFLIGHT_TARGET_INVALID/,
		);
	assert.throws(
		() =>
			preflight.assertTemplatePreflightTarget(
				job,
				{ metadata: { uid: "other-cluster" } },
				namespace,
			),
		/PREFLIGHT_TARGET_INVALID/,
	);
	assert.throws(
		() =>
			preflight.assertTemplatePreflightTarget(
				{ ...job, sourceCommit: "f".repeat(40) },
				cluster,
				namespace,
			),
		/PREFLIGHT_TARGET_INVALID/,
	);
});

const ecsJob = {
	...baseJob,
	expectedNodePrefix: "cn-hangzhou.10.0.1.219",
	placement: {
		nodeSelector: {
			"kubernetes.io/hostname": "cn-hangzhou.10.0.1.219",
			"kubernetes.io/arch": "amd64",
			"kubernetes.io/os": "linux",
		},
	},
};
test("accepts an explicitly pinned ECS template preflight", () => {
	assert.equal(
		validateTemplatePreflightJob(ecsJob).expectedNodePrefix,
		ecsJob.placement.nodeSelector["kubernetes.io/hostname"],
	);
});
for (const prefix of [undefined, "", "cn-hangzhou.", "other-node"]) {
	test(`rejects ECS placement without exact node evidence: ${prefix}`, () => {
		assert.throws(() =>
			validateTemplatePreflightJob({ ...ecsJob, expectedNodePrefix: prefix }),
		);
	});
}
for (const key of [
	"kubernetes.io/hostname",
	"kubernetes.io/arch",
	"kubernetes.io/os",
]) {
	test(`rejects ECS placement missing ${key}`, () => {
		const nodeSelector = { ...ecsJob.placement.nodeSelector };
		delete nodeSelector[key];
		assert.throws(() =>
			validateTemplatePreflightJob({ ...ecsJob, placement: { nodeSelector } }),
		);
	});
}

const expectedPod = {
	name: "ack-preflight-claude-fixture",
	owner: "fixture-owner",
};
const startupPod = {
	metadata: {
		name: expectedPod.name,
		namespace: baseJob.namespace,
		uid: "pod-uid-3771",
		creationTimestamp: "2026-10-30T00:00:00Z",
		labels: {
			"agent-infra.validation-source": baseJob.sourceCommit,
			"agent-infra.validation-owner": expectedPod.owner,
			"agent-infra.validation-scope": baseJob.scope,
		},
	},
	spec: { containers: [{ name: "runtime", image: baseJob.imageReference }] },
	status: {
		containerStatuses: [
			{
				name: "runtime",
				state: { running: { startedAt: "2026-10-30T00:00:10Z" } },
			},
		],
		conditions: [
			{
				type: "Ready",
				status: "True",
				lastTransitionTime: "2026-10-30T00:00:12Z",
			},
		],
	},
};
const event = (reason, at = "2026-10-30T00:00:01Z", extra = {}) => ({
	involvedObject: { kind: "Pod", uid: startupPod.metadata.uid },
	type: "Normal",
	reason,
	eventTime: at,
	...extra,
});
const project = (events, pod = startupPod, job = baseJob) =>
	projectPodStartupReceipt({ job, expectedPod, pod, events });

test("startup receipt distinguishes partial cache hits from real image presence", () => {
	const receipt = project([
		event("SuccessfulHitImageCache"),
		event("ImageCacheNotFullMatch"),
		event("ImageCacheAutoCreated"),
		event("ImageCacheAutoEliminated"),
		event("Pulling"),
		event("Pulled", "2026-10-30T00:00:05Z"),
	]);
	assert.equal(receipt.sourceCommit, baseJob.sourceCommit);
	assert.equal(receipt.imageDigest, baseJob.imageDigest);
	assert.match(receipt.podUidSha256, /^[a-f0-9]{64}$/u);
	assert.deepEqual(receipt.durationsSeconds, {
		createToContainer: 10,
		createToReady: 12,
		containerToReady: 2,
	});
	assert.deepEqual(receipt.cache, {
		hit: true,
		partialMatch: true,
		autoCreated: true,
		autoEvicted: true,
		imageAlreadyPresent: false,
	});
	assert.deepEqual(receipt.pull, { status: "observed", seconds: 4 });
	const already = project([
		event("Pulled", "2026-10-30T00:00:05Z", {
			message: `Container image "${baseJob.imageReference}" already present on machine`,
		}),
	]);
	assert.equal(already.cache.imageAlreadyPresent, true);
	assert.deepEqual(already.pull, { status: "unknown", seconds: null });
	assert.equal(
		project([event("SuccessfulHitImageCache")]).cache.imageAlreadyPresent,
		null,
	);
});

test("missing events and wrong-UID events cannot manufacture a cache miss or pull proof", () => {
	for (const events of [
		undefined,
		[],
		[
			event("Pulled", undefined, {
				involvedObject: { kind: "Pod", uid: "another-pod" },
			}),
		],
	]) {
		const receipt = project(events);
		assert.equal(
			receipt.eventRead,
			events === undefined ? "unavailable" : "unknown",
		);
		assert.deepEqual(receipt.cache, {
			hit: null,
			partialMatch: null,
			autoCreated: null,
			autoEvicted: null,
			imageAlreadyPresent: null,
		});
		assert.deepEqual(receipt.pull, { status: "unknown", seconds: null });
	}
});

test("startup binding rejects wrong owner, name, source, image, or extra containers", () => {
	for (const mutate of [
		(pod) => {
			pod.metadata.name = "ack-preflight-other";
		},
		(pod) => {
			pod.metadata.namespace = "another-namespace";
		},
		(pod) => {
			pod.metadata.labels["agent-infra.validation-owner"] = "another-owner";
		},
		(pod) => {
			pod.metadata.labels["agent-infra.validation-source"] = "f".repeat(40);
		},
		(pod) => {
			pod.spec.containers[0].image = "wrong-image";
		},
		(pod) => {
			pod.spec.containers.push({ ...pod.spec.containers[0] });
		},
		(pod) => {
			delete pod.metadata.uid;
		},
	]) {
		const pod = structuredClone(startupPod);
		mutate(pod);
		assert.throws(() => project([], pod), /STARTUP_RECEIPT_BINDING_INVALID/u);
	}
	assert.throws(
		() => project([], startupPod, { ...baseJob, sourceCommit: "f".repeat(40) }),
		/STARTUP_RECEIPT_BINDING_INVALID/u,
	);
});

test("missing, invalid, backwards, or unbounded times remain diagnostic unknown", () => {
	for (const invalid of [
		undefined,
		"private-secret-value",
		"2026-02-30T00:00:00Z",
		"2026-10-29T00:00:00Z",
		"2026-11-30T00:00:00Z",
	]) {
		const pod = structuredClone(startupPod);
		pod.status.conditions[0].lastTransitionTime = invalid;
		const receipt = project([], pod);
		assert.equal(receipt.timingReadback, "unknown");
		assert.deepEqual(receipt.durationsSeconds, {
			createToContainer: null,
			createToReady: null,
			containerToReady: null,
		});
	}
	for (const events of [
		[event("Pulling", "bad-time"), event("Pulled", "2026-10-30T00:00:05Z")],
		[
			event("Pulling", "2026-10-30T00:00:05Z"),
			event("Pulled", "2026-10-30T00:00:01Z"),
		],
		[event("Pulling"), event("Pulled", "2026-11-30T00:00:05Z")],
	])
		assert.deepEqual(project(events).pull, {
			status: "unknown",
			seconds: null,
		});
});

test("startup projection outputs only allowlisted fields even from sensitive events", () => {
	const marker = "private-secret-cache-id-message";
	const pod = structuredClone(startupPod);
	pod.spec.containers[0].env = [{ name: "TOKEN", value: marker }];
	const receipt = project(
		[
			event("SuccessfulHitImageCache", undefined, {
				message: marker,
				metadata: { name: marker },
				count: marker,
			}),
			event(marker, undefined, { message: marker }),
			event("Pulled", undefined, {
				message: `Container image "${marker}" already present on machine`,
			}),
		],
		pod,
	);
	const serialized = JSON.stringify(receipt);
	for (const raw of [
		marker,
		pod.metadata.name,
		pod.metadata.namespace,
		pod.metadata.uid,
		expectedPod.owner,
		baseJob.imageReference,
	])
		assert.equal(serialized.includes(raw), false);
	assert.equal(receipt.cache.imageAlreadyPresent, null);
});

test("an already-present message with invalid event times cannot prove cache or image state", () => {
	const message = `Container image "${baseJob.imageReference}" already present on machine`;
	for (const invalid of [
		{ eventTime: "invalid-time" },
		{ eventTime: "2026-10-29T00:00:00Z" },
		{ eventTime: "2026-10-30T00:00:13Z" },
		{
			firstTimestamp: "2026-10-30T00:00:05Z",
			lastTimestamp: "2026-10-30T00:00:01Z",
		},
		{
			firstTimestamp: "2026-10-30T00:00:01Z",
			lastTimestamp: "2026-10-30T00:00:05Z",
			eventTime: "invalid-time",
		},
	]) {
		const receipt = project([
			event("SuccessfulHitImageCache"),
			event("Pulled", undefined, { message, ...invalid }),
		]);
		assert.equal(receipt.eventRead, "unknown");
		assert.equal(receipt.cache.imageAlreadyPresent, null);
		assert.equal(receipt.cache.hit, null);
		assert.deepEqual(receipt.pull, { status: "unknown", seconds: null });
	}
});

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
	"ready-events-unavailable",
	"ready-events-other-pod",
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
		const relayKey = join(directory, "relay-key");
		const { privateKey } = generateKeyPairSync("ed25519");
		await writeFile(
			grant,
			privateKey.export({ type: "pkcs8", format: "pem" }),
			{ mode: 0o600 },
		);
		await writeFile(token, secret, { mode: 0o600 });
		await writeFile(relayKey, "synthetic-relay-credential-0123456789012345", {
			mode: 0o600,
		});
		const output = join(directory, "output");
		const job = {
			...baseJob,
			outputDirectory: output,
			grantPrivateKeyFile: grant,
			runtimeServiceTokenFile: token,
			relayKeyFile: relayKey,
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
if(args.includes('create')&&args.includes('secret')){
 const mounted=args.find(a=>a.startsWith('--from-file=service-token=')).split('=').slice(2).join('=');
 fs.writeFileSync(${JSON.stringify(token)},'rotated-test-token');
 if(fs.readFileSync(mounted,'utf8')!==secret)process.exit(72);
 console.log('{}');process.exit(0);
}
if(args.includes('apply')){fs.readFileSync(0);process.exit(0);}
if(args.includes('create')){const pod=JSON.parse(fs.readFileSync(0));pod.metadata.uid='fixture-pod-uid';pod.metadata.creationTimestamp='2026-10-30T00:00:00Z';fs.writeFileSync(state,JSON.stringify(pod));process.exit(0);}
if(args.includes('wait')){if(scenario.startsWith('ready-'))process.exit(0);console.error(secret);process.exit(1);}
if(args.includes('events')){if(scenario==='ready-events-unavailable'){console.error(secret);process.exit(1);}console.log(JSON.stringify({items:scenario==='ready-events-other-pod'?[{involvedObject:{kind:'Pod',uid:'other-pod'},type:'Normal',reason:'Pulled',message:secret}]:[]}));process.exit(0);}
if(args.includes('get')){
 if(scenario==='readback-failed'){console.error(secret);process.exit(1);}
 const pod=JSON.parse(fs.readFileSync(state));pod.status={phase:'Pending',containerStatuses:[{state:{waiting:{reason:scenario==='unsafe-reason'?secret:'ContainerCreating',message:secret}}}]};
 if(scenario.startsWith('ready-'))pod.status={phase:'Running',containerStatuses:[{name:'runtime',imageID:'docker-pullable://runtime@sha256:'+'c'.repeat(64),state:{running:{startedAt:'2026-10-30T00:00:10Z'}}}],conditions:[{type:'Ready',status:'True',lastTransitionTime:'2026-10-30T00:00:12Z'}]};
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
		const mounted = calls
			.flat()
			.find((arg) => arg.startsWith("--from-file=service-token="))
			.slice("--from-file=service-token=".length);
		assert.equal(mounted.startsWith(output + "/"), false);
		await assert.rejects(lstat(mounted), { code: "ENOENT" });
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
		if (scenario.startsWith("ready-")) {
			assert(calls.some((args) => args.includes("port-forward")));
			const startup = JSON.parse(
				await readFile(join(output, "pod-startup.receipt.json"), "utf8"),
			);
			assert.equal(startup.sourceCommit, job.sourceCommit);
			assert.equal(startup.durationsSeconds.createToReady, 12);
			assert.equal(
				startup.eventRead,
				scenario === "ready-events-unavailable" ? "unavailable" : "unknown",
			);
			assert.equal(JSON.stringify(startup).includes(secret), false);
			assert.equal(startup.cache.imageAlreadyPresent, null);
			assert(
				calls.some((args) =>
					args.includes("involvedObject.uid=fixture-pod-uid"),
				),
			);
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

const executorPolicy = {
	resources: {
		requests: { cpu: "250m", memory: "256Mi" },
		limits: { cpu: "1", memory: "512Mi" },
	},
	tmpSizeLimit: "128Mi",
	placement: { architecture: "amd64" },
};
const executorModelEgress = [{ destination: { ip: "192.0.2.1" }, port: 443 }];
const executorDnsEgress = [
	{ namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
];
const executorJob = {
	...baseJob,
	templateId: "codex",
	driver: "codex",
	protocol: "openai-responses-v1",
	imageReference: `ghcr.io/agoraio-extensions/agent-infra/agent-runtime-codex@${baseJob.imageDigest}`,
	resourceProfileRef: "small",
	modelEgress: executorModelEgress,
	dnsEgress: executorDnsEgress,
	resources: {
		requests: { cpu: "100m", memory: "128Mi" },
		limits: baseJob.expectedResourceLimits,
	},
	codexSessionExecutor: executorPolicy,
	storageSize: "20Gi",
	storageClassName: "test-essd",
	placement: {
		nodeSelector: { type: "virtual-kubelet", "kubernetes.io/arch": "amd64" },
		tolerations: [
			{
				key: "virtual-kubelet.io/provider",
				operator: "Equal",
				value: "alibabacloud",
				effect: "NoSchedule",
			},
		],
	},
};

test("Codex SDK preflight retains global Native policy without creating a Native executor", () => {
	const fixture = executorFixture({
		...executorJob,
		transport: "paseo-sdk-pod",
	});
	assert.equal(fixture.rendered.binding, undefined);
	assert.equal(fixture.rendered.pod.spec.containers.length, 2);
	assert.equal(fixture.rendered.pod.spec.initContainers, undefined);
	assert.equal(fixture.rendered.pod.spec.containers[1].env[0].value, "codex");
	assert.equal(fixture.observe().observedExecutorResources, undefined);
	assert.equal(fixture.observe().observedInitResources, undefined);
});

test("single-container preflight keeps the full control resource envelope", () => {
	const job = {
		...executorJob,
		codexSessionExecutor: undefined,
		resources: {
			requests: {
				...executorJob.resources.requests,
				"ephemeral-storage": "256Mi",
			},
			limits: { ...executorJob.resources.limits, "ephemeral-storage": "1Gi" },
		},
		expectedResourceLimits: {
			...executorJob.expectedResourceLimits,
			"ephemeral-storage": "1Gi",
		},
	};
	assert.doesNotThrow(() => validateTemplatePreflightJob(job));
	const fixture = executorFixture(job);
	assert.deepEqual(
		fixture.rendered.pod.spec.containers[0].resources,
		job.resources,
	);
	assert.doesNotThrow(fixture.observe);
	fixture.observed.spec.containers[0].resources.limits["ephemeral-storage"] =
		"1025Mi";
	assert.throws(fixture.observe, /EXECUTOR_LAYOUT_DRIFT/u);
	for (const limits of [
		{ ...job.resources.limits, gpu: "1" },
		{ ...job.resources.limits, "ephemeral-storage": "0" },
	])
		assert.throws(() =>
			validateTemplatePreflightJob({
				...job,
				resources: { ...job.resources, limits },
			}),
		);
});

function executorFixture(job = executorJob) {
	const rendered = renderTemplatePreflightPod({
		job,
		owner: "test-owner-123",
		publicKey: "synthetic-public-key",
		modelConfig: "{}",
		serviceToken: "synthetic-service-token",
	});
	rendered.pod.metadata.uid = "owned-pod";
	rendered.pvc.metadata.uid = "owned-pvc";
	rendered.serviceAccount.metadata.uid = "owned-service-account";
	rendered.networkPolicy.metadata.uid = "owned-network-policy";
	const observed = structuredClone(rendered.pod);
	observed.spec.nodeName = job.expectedNodePrefix ?? "virtual-kubelet-test";
	const node = {
		metadata: {
			name: observed.spec.nodeName,
			uid: "approved-node-uid",
			labels: { "kubernetes.io/arch": "amd64", "kubernetes.io/os": "linux" },
		},
	};
	observed.status = {
		phase: "Running",
		containerStatuses: observed.spec.containers.map((container) => ({
			name: container.name,
			ready: true,
			restartCount: 0,
			imageID: `containerd://${job.imageDigest}`,
			containerID: `containerd://${container.name}`,
			state: { running: { startedAt: "2026-10-30T00:00:10Z" } },
		})),
		...(rendered.binding
			? {
					initContainerStatuses: [
						{
							name: "codex-session-workspace-init",
							restartCount: 0,
							imageID: `containerd://${job.imageDigest}`,
							state: { terminated: { exitCode: 0 } },
						},
					],
				}
			: {}),
	};
	const pvc = structuredClone(rendered.pvc);
	pvc.status = { phase: "Bound", capacity: { storage: "20Gi" } };
	const serviceAccount = structuredClone(rendered.serviceAccount);
	const networkPolicy = structuredClone(rendered.networkPolicy);
	return {
		rendered,
		observed,
		pvc,
		serviceAccount,
		networkPolicy,
		node,
		observe: () =>
			observeTemplatePreflightLayout(
				job,
				rendered,
				observed,
				pvc,
				serviceAccount,
				networkPolicy,
				node,
			),
	};
}

test("accepts Kubernetes omission of an empty imagePullSecrets array", () => {
	const fixture = executorFixture();
	assert.deepEqual(fixture.rendered.pod.spec.imagePullSecrets, []);
	assert.doesNotThrow(fixture.observe);
	delete fixture.observed.spec.imagePullSecrets;
	assert.doesNotThrow(fixture.observe);
	assert.equal(Object.hasOwn(fixture.observed.spec, "imagePullSecrets"), false);
});

test("rejects pull Secret and unrelated layout drift", () => {
	for (const value of [null, {}, "invalid", [{ name: "unexpected" }]]) {
		const fixture = executorFixture();
		fixture.observed.spec.imagePullSecrets = value;
		assert.throws(fixture.observe, /EXECUTOR_LAYOUT_DRIFT/u);
	}
	const requiredJob = {
		...executorJob,
		imagePullSecret: "expected-pull-secret",
	};
	for (const value of [[], [{ name: "different" }], undefined]) {
		const fixture = executorFixture(requiredJob);
		if (value === undefined) delete fixture.observed.spec.imagePullSecrets;
		else fixture.observed.spec.imagePullSecrets = value;
		assert.throws(fixture.observe, /EXECUTOR_LAYOUT_DRIFT/u);
	}
	const fixture = executorFixture();
	delete fixture.observed.spec.imagePullSecrets;
	fixture.observed.spec.containers[0].imagePullPolicy = "Always";
	assert.throws(fixture.observe, /EXECUTOR_LAYOUT_DRIFT/u);
});

const inheritedExecutorJob = {
	...executorJob,
	placement: undefined,
	expectedNodePrefix: "cn-hangzhou.10.0.1.219",
	codexSessionExecutor: {
		resources: executorPolicy.resources,
		tmpSizeLimit: "128Mi",
	},
	resources: {
		requests: {
			...executorJob.resources.requests,
			"ephemeral-storage": "256Mi",
		},
		limits: { ...executorJob.resources.limits, "ephemeral-storage": "1Gi" },
	},
	expectedResourceLimits: {
		...executorJob.expectedResourceLimits,
		"ephemeral-storage": "1Gi",
	},
};

for (const [templateId, driver] of [
	["codex", "codex"],
	["claude", "claude"],
	["opencode", "acp"],
	["pi", "pi"],
])
	test(`${templateId} runner placement gate rejects inherited scheduling injections before model execution`, () => {
		const job = {
			...inheritedExecutorJob,
			templateId,
			driver,
			protocol:
				templateId === "codex"
					? "openai-responses-v1"
					: "anthropic-messages-v1",
		};
		const fixture = executorFixture(job);
		const check = (pod) =>
			preflight.assertTemplatePreflightPlacement(job, pod, fixture.node);
		fixture.observed.spec.tolerations = [
			"node.kubernetes.io/not-ready",
			"node.kubernetes.io/unreachable",
		].map((key) => ({
			key,
			operator: "Exists",
			effect: "NoExecute",
			tolerationSeconds: 300,
		}));
		assert.equal(check(fixture.observed).nodeArchitecture, "amd64");
		for (const change of [
			{ nodeSelector: { type: "virtual-kubelet" } },
			{ runtimeClassName: "foreign" },
			{ tolerations: executorJob.placement.tolerations },
			{
				tolerations: [
					{
						key: "node.kubernetes.io/not-ready",
						operator: "Exists",
						effect: "NoSchedule",
					},
				],
			},
			{
				tolerations: [
					{
						key: "node.kubernetes.io/not-ready",
						operator: "Exists",
						effect: "NoExecute",
						tolerationSeconds: 600,
					},
				],
			},
		]) {
			const pod = structuredClone(fixture.observed);
			Object.assign(pod.spec, change);
			assert.throws(() => check(pod), /EXECUTOR_LAYOUT_DRIFT/u);
		}
	});

test("binds admitted ephemeral storage for both executor containers", () => {
	const job = structuredClone(inheritedExecutorJob);
	job.codexSessionExecutor.resources.requests["ephemeral-storage"] = "32Mi";
	job.codexSessionExecutor.resources.limits["ephemeral-storage"] = "256Mi";
	for (const role of ["executor", "init"]) {
		const fixture = executorFixture(job);
		const actual =
			role === "executor"
				? fixture.observed.spec.containers[1]
				: fixture.observed.spec.initContainers[0];
		actual.resources.limits["ephemeral-storage"] = "0.25Gi";
		assert.doesNotThrow(fixture.observe);
		actual.resources.limits["ephemeral-storage"] = "512Mi";
		assert.throws(fixture.observe, /EXECUTOR_LAYOUT_DRIFT/u);
	}
});

test("inherited executor placement adds no scheduling fields and observes full control resources on the approved node", () => {
	const fixture = executorFixture(inheritedExecutorJob);
	for (const key of ["nodeSelector", "tolerations", "runtimeClassName"])
		assert.equal(Object.hasOwn(fixture.rendered.pod.spec, key), false);
	assert.deepEqual(
		fixture.rendered.pod.spec.containers[0].resources,
		inheritedExecutorJob.resources,
	);
	const control = fixture.observed.spec.containers[0];
	control.resources.requests["ephemeral-storage"] = "0.25Gi";
	control.resources.limits["ephemeral-storage"] = "1024Mi";
	const receipt = fixture.observe();
	assert.equal(receipt.nodeUidSha256, preflightHash("approved-node-uid"));
	assert.equal(receipt.nodeArchitecture, "amd64");
	assert.equal(control.resources.limits["ephemeral-storage"], "1024Mi");
});

for (const [name, change] of [
	[
		"node suffix",
		(f) => {
			f.observed.spec.nodeName += "-other";
		},
	],
	[
		"node identity",
		(f) => {
			f.node.metadata.name = "foreign-node";
		},
	],
	[
		"missing node UID",
		(f) => {
			delete f.node.metadata.uid;
		},
	],
	[
		"architecture",
		(f) => {
			f.node.metadata.labels["kubernetes.io/arch"] = "arm64";
		},
	],
	[
		"provider",
		(f) => {
			f.node.metadata.labels.type = "virtual-kubelet";
		},
	],
	[
		"injected selector",
		(f) => {
			f.observed.spec.nodeSelector = { type: "virtual-kubelet" };
		},
	],
	[
		"injected toleration",
		(f) => {
			f.observed.spec.tolerations = executorJob.placement.tolerations;
		},
	],
	[
		"RuntimeClass",
		(f) => {
			f.observed.spec.runtimeClassName = "foreign";
		},
	],
	[
		"missing ephemeral",
		(f) => {
			delete f.observed.spec.containers[0].resources.limits[
				"ephemeral-storage"
			];
		},
	],
	[
		"ephemeral amount",
		(f) => {
			f.observed.spec.containers[0].resources.limits["ephemeral-storage"] =
				"1025Mi";
		},
	],
	[
		"undeclared resource",
		(f) => {
			f.observed.spec.containers[0].resources.requests.gpu = "1";
		},
	],
])
	test(`inherited executor observation rejects ${name}`, () => {
		const fixture = executorFixture(inheritedExecutorJob);
		change(fixture);
		assert.throws(fixture.observe, /EXECUTOR_LAYOUT_.*DRIFT/u);
	});

for (const expectedNodePrefix of [undefined, "", "virtual-kubelet-test", "*"])
	test(`inherited executor requires an explicit ordinary node target: ${expectedNodePrefix}`, () => {
		assert.throws(
			() =>
				validateTemplatePreflightJob({
					...inheritedExecutorJob,
					expectedNodePrefix,
				}),
			/TEMPLATE_PLACEMENT_INVALID/u,
		);
	});

test("a complete control envelope must also be declared in expected limits", () => {
	assert.throws(() =>
		validateTemplatePreflightJob({
			...inheritedExecutorJob,
			expectedResourceLimits: baseJob.expectedResourceLimits,
		}),
	);
});

test("executor capacity job requires the official image and bounded matching ECI policy", () => {
	assert.equal(
		validateTemplatePreflightJob(executorJob).codexSessionExecutor,
		executorPolicy,
	);
	for (const change of [
		{ resourceProfileRef: undefined },
		{ storageSize: undefined },
		{ storageClassName: undefined },
		{ imageReference: baseJob.imageReference },
		{ driver: "claude" },
		{
			resources: {
				requests: { cpu: "invalid", memory: "128Mi" },
				limits: baseJob.expectedResourceLimits,
			},
		},
		{
			codexSessionExecutor: {
				...executorPolicy,
				placement: { architecture: "arm64" },
			},
		},
		{
			codexSessionExecutor: {
				...executorPolicy,
				placement: { architecture: "amd64", runtimeClassName: "foreign" },
			},
		},
		{
			placement: {
				...executorJob.placement,
				nodeSelector: {
					...executorJob.placement.nodeSelector,
					"kubernetes.io/hostname": "other-node",
				},
			},
		},
		{ placement: { ...executorJob.placement, tolerations: [] } },
	])
		assert.throws(() =>
			validateTemplatePreflightJob({ ...executorJob, ...change }),
		);
});

test("executor capacity rendering binds a fixed synthetic Conversation and exact credential-free subPath", () => {
	const { rendered, observe } = executorFixture();
	assert.match(rendered.pod.metadata.name, /^sandbox-preflight-/u);
	assert.equal(rendered.binding.podName, rendered.pod.metadata.name);
	assert.equal(
		rendered.binding.conversationId,
		"validation-conversation-test-owner-123",
	);
	assert.equal(rendered.pod.spec.shareProcessNamespace, false);
	assert.deepEqual(
		rendered.pod.spec.initContainers[0].resources,
		executorPolicy.resources,
	);
	assert.deepEqual(
		rendered.pod.spec.containers[1].resources,
		executorPolicy.resources,
	);
	assert.deepEqual(
		rendered.pod.spec.containers[1].env.map((item) => item.name),
		[
			"AGENT_INFRA_CODEX_SESSION_EXECUTOR_BINDING",
			"AGENT_INFRA_RUNTIME_POD_UID",
		],
	);
	assert.deepEqual(rendered.pod.spec.containers[1].volumeMounts, [
		{
			name: "workspace",
			mountPath: rendered.binding.workspaceRoot,
			subPath: rendered.binding.workspaceSubPath,
		},
		{ name: "executor-tmp", mountPath: "/tmp" },
	]);
	assert.deepEqual(observe(), {
		observedExecutorResources: executorPolicy.resources,
		observedInitResources: executorPolicy.resources,
		storageClassName: "test-essd",
		pvcUidSha256: preflightHash("owned-pvc"),
		serviceAccountUidSha256: preflightHash("owned-service-account"),
		networkPolicyUidSha256: preflightHash("owned-network-policy"),
		networkPolicySpecSha256: preflightHash(
			JSON.stringify(rendered.networkPolicy.spec),
		),
		networkDataplaneVerified: false,
	});
});
const preflightHash = (value) =>
	createHash("sha256").update(value).digest("hex");

for (const [name, mutate] of [
	[
		"retiring Pod",
		({ observed }) =>
			(observed.metadata.deletionTimestamp = "2026-10-30T00:01:00Z"),
	],
	[
		"retiring PVC",
		({ pvc }) => (pvc.metadata.deletionTimestamp = "2026-10-30T00:01:00Z"),
	],
	[
		"retiring network policy",
		({ networkPolicy }) =>
			(networkPolicy.metadata.deletionTimestamp = "2026-10-30T00:01:00Z"),
	],

	[
		"extra container",
		({ observed }) =>
			observed.spec.containers.push(
				structuredClone(observed.spec.containers[1]),
			),
	],
	["missing init", ({ observed }) => (observed.spec.initContainers = [])],
	[
		"shared PID",
		({ observed }) => (observed.spec.shareProcessNamespace = true),
	],
	["host namespace", ({ observed }) => (observed.spec.hostNetwork = true)],
	[
		"foreign RuntimeClass",
		({ observed }) => (observed.spec.runtimeClassName = "foreign"),
	],
	[
		"ephemeral container",
		({ observed }) =>
			(observed.spec.ephemeralContainers = [{ name: "foreign" }]),
	],
	["wrong node", ({ observed }) => (observed.spec.nodeName = "foreign-node")],
	[
		"service account drift",
		({ serviceAccount }) =>
			(serviceAccount.automountServiceAccountToken = true),
	],
	[
		"service account token",
		({ serviceAccount }) => (serviceAccount.secrets = [{ name: "foreign" }]),
	],
	[
		"foreign network UID",
		({ networkPolicy }) => (networkPolicy.metadata.uid = "foreign"),
	],
	[
		"network ingress widened",
		({ networkPolicy }) => (networkPolicy.spec.ingress = [{}]),
	],
	[
		"network egress widened",
		({ networkPolicy }) => networkPolicy.spec.egress.push({}),
	],

	[
		"foreign Pod UID",
		({ observed }) => (observed.metadata.uid = "foreign-pod"),
	],
	[
		"control root UID",
		({ observed }) =>
			(observed.spec.containers[0].securityContext.runAsUser = 0),
	],
	[
		"executor privilege",
		({ observed }) =>
			(observed.spec.containers[1].securityContext.privileged = true),
	],
	[
		"executor capability",
		({ observed }) =>
			(observed.spec.containers[1].securityContext.capabilities.add = [
				"SYS_ADMIN",
			]),
	],
	[
		"executor credential env",
		({ observed }) =>
			observed.spec.containers[1].env.push({
				name: "TOKEN",
				value: "synthetic",
			}),
	],
	[
		"executor full PVC",
		({ observed }) =>
			delete observed.spec.containers[1].volumeMounts[0].subPath,
	],
	[
		"executor Host mount",
		({ observed }) =>
			observed.spec.containers[1].volumeMounts.push({
				name: "workspace",
				mountPath: "/host",
			}),
	],
	[
		"executor resource drift",
		({ observed }) =>
			(observed.spec.containers[1].resources.limits.memory = "256Mi"),
	],
	[
		"init failure",
		({ observed }) =>
			(observed.status.initContainerStatuses[0].state.terminated.exitCode = 1),
	],
	[
		"executor restart",
		({ observed }) => (observed.status.containerStatuses[1].restartCount = 1),
	],
	[
		"foreign executor image",
		({ observed }) =>
			(observed.status.containerStatuses[1].imageID = "sha256:foreign"),
	],
	["foreign PVC UID", ({ pvc }) => (pvc.metadata.uid = "foreign-pvc")],
	[
		"foreign PVC owner",
		({ pvc }) =>
			(pvc.metadata.labels["agent-infra.validation-owner"] = "foreign"),
	],
	[
		"foreign storage class",
		({ pvc }) => (pvc.spec.storageClassName = "foreign"),
	],
	["unbound PVC", ({ pvc }) => (pvc.status.phase = "Pending")],
	["unmeasured disk size", ({ pvc }) => (pvc.status.capacity.storage = "40Gi")],
])
	test(`executor capacity readback rejects ${name}`, () => {
		const fixture = executorFixture();
		mutate(fixture);
		assert.throws(fixture.observe);
	});

test("executor readback permits safe API defaults without accepting security overrides", () => {
	const fixture = executorFixture();
	fixture.observed.spec.tolerations.push({
		key: "node.kubernetes.io/not-ready",
		operator: "Exists",
		effect: "NoExecute",
		tolerationSeconds: 300,
	});
	for (const container of [
		...fixture.observed.spec.containers,
		...fixture.observed.spec.initContainers,
	]) {
		container.terminationMessagePath = "/dev/termination-log";
		container.terminationMessagePolicy = "File";
		container.imagePullPolicy = "IfNotPresent";
	}
	fixture.observed.spec.volumes[0].persistentVolumeClaim.readOnly = false;
	for (const key of ["hostPID", "hostIPC", "hostNetwork"])
		delete fixture.observed.spec[key];
	fixture.networkPolicy.spec.ingress = undefined;
	assert.equal(fixture.observe().storageClassName, "test-essd");
});

for (const seconds of [undefined, 300]) {
	test(`executor readback permits standard NoExecute defaults with seconds=${seconds}`, () => {
		const fixture = executorFixture();
		for (const key of [
			"node.kubernetes.io/not-ready",
			"node.kubernetes.io/unreachable",
		]) {
			fixture.observed.spec.tolerations.push({
				key,
				operator: "Exists",
				effect: "NoExecute",
				...(seconds === undefined ? {} : { tolerationSeconds: seconds }),
			});
		}
		assert.equal(fixture.observe().storageClassName, "test-essd");
	});
}

for (const changed of [
	{ tolerationSeconds: null },
	{ tolerationSeconds: 600 },
	{ value: "" },
	{ operator: "Equal", value: "unreviewed" },
	{ effect: "NoSchedule" },
	{ key: "node.kubernetes.io/disk-pressure" },
]) {
	test(`executor readback rejects unapproved default toleration changes ${JSON.stringify(changed)}`, () => {
		const fixture = executorFixture();
		fixture.observed.spec.tolerations.push({
			key: "node.kubernetes.io/not-ready",
			operator: "Exists",
			effect: "NoExecute",
			...changed,
		});
		assert.throws(fixture.observe, /EXECUTOR_LAYOUT_DRIFT/u);
	});
}

test("non-Codex global executor policy measures only its real control container and PVC", () => {
	const job = {
		...executorJob,
		templateId: "claude",
		driver: "claude",
		protocol: "anthropic-messages-v1",
		imageReference: baseJob.imageReference,
	};
	const fixture = executorFixture(job);
	assert.equal(fixture.rendered.binding, undefined);
	assert.equal(fixture.rendered.pod.spec.containers.length, 1);
	assert.equal(fixture.rendered.pod.spec.initContainers, undefined);
	assert.equal(fixture.observe().observedExecutorResources, undefined);
	assert.equal(fixture.observe().observedInitResources, undefined);
	assert.equal(fixture.observe().storageClassName, "test-essd");
});

test("PVC observation accepts API canonical quantity aliases while retaining positive exact capacity", () => {
	const fixture = executorFixture({ ...executorJob, storageSize: "1.5Gi" });
	fixture.pvc.spec.resources.requests.storage = "1536Mi";
	fixture.pvc.status.capacity.storage = "1610612736";
	assert.equal(fixture.observe().storageClassName, "test-essd");
	for (const invalid of ["0", "invalid", "2Gi"]) {
		fixture.pvc.status.capacity.storage = invalid;
		assert.throws(fixture.observe, /EXECUTOR_PVC_DRIFT/u);
	}
});

for (const scenario of [
	"ready-failed",
	"foreign-pvc-cleanup",
	"foreign-secret-cleanup",
	"private-file-cleanup",
])
	test(`executor CLI creates and safely cleans owned resources: ${scenario}`, async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "ack-executor-ready-"));
		t.after(() => rm(directory, { recursive: true, force: true }));
		const bin = join(directory, "bin");
		await mkdir(bin);
		const log = join(directory, "calls.jsonl");
		const state = join(directory, "objects.json");
		const grant = join(directory, "grant.pem");
		const token = join(directory, "token");
		const relayKey = join(directory, "relay-key");
		const { privateKey } = generateKeyPairSync("ed25519");
		await writeFile(
			grant,
			privateKey.export({ type: "pkcs8", format: "pem" }),
			{ mode: 0o600 },
		);
		const serviceToken = "synthetic-service-token-0123456789";
		await writeFile(token, `${serviceToken}\n`, {
			mode: 0o600,
		});
		await writeFile(relayKey, "synthetic-model-token-0123456789-0123456789", {
			mode: 0o600,
		});
		const output = join(directory, "output");
		const file = join(directory, "job.json");
		await writeFile(
			file,
			JSON.stringify({
				...executorJob,
				outputDirectory: output,
				grantPrivateKeyFile: grant,
				runtimeServiceTokenFile: token,
				relayKeyFile: relayKey,
			}),
			{ mode: 0o600 },
		);
		await writeFile(
			join(bin, "kubectl"),
			`#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2),scenario=${JSON.stringify(scenario)},log=${JSON.stringify(log)},state=${JSON.stringify(state)};
fs.appendFileSync(log,JSON.stringify(args)+'\\n');
const plural={pods:'Pod',secrets:'Secret',pvc:'PersistentVolumeClaim',persistentvolumeclaims:'PersistentVolumeClaim',serviceaccounts:'ServiceAccount',serviceaccount:'ServiceAccount',networkpolicies:'NetworkPolicy',networkpolicy:'NetworkPolicy'};
if(args.includes('create')&&args.includes('secret')){
 const prefix='--from-file=service-token=';
 const path=args.find(arg=>arg.startsWith(prefix)).slice(prefix.length);
 const bytes=fs.readFileSync(path);
 console.log(JSON.stringify({apiVersion:'v1',kind:'Secret',metadata:{},data:{'service-token':bytes.toString('base64')}}));
 process.exit(0);
}
if(args.includes('create')){const object=JSON.parse(fs.readFileSync(0));object.metadata.uid=object.kind+'-owned-uid';object.metadata.resourceVersion='1';const objects=fs.existsSync(state)?JSON.parse(fs.readFileSync(state)):{};objects[object.kind]=object;fs.writeFileSync(state,JSON.stringify(objects));console.log(JSON.stringify(object));process.exit(0);}
if(args.includes('wait')){process.exit(args.includes('--for=delete')?0:1);}
if(args.includes('get')){const kind=plural[args[args.indexOf('get')+1]],object=JSON.parse(fs.readFileSync(state))[kind];if(kind==='Pod')object.status={phase:'Pending',containerStatuses:[{state:{waiting:{reason:'ContainerCreating'}}}]};if((scenario==='foreign-pvc-cleanup'&&kind==='PersistentVolumeClaim')||(scenario==='foreign-secret-cleanup'&&kind==='Secret'))object.metadata.uid='foreign-uid';console.log(JSON.stringify(object));process.exit(0);}
if(args.includes('delete')){const request=JSON.parse(fs.readFileSync(0));if(!request.preconditions?.uid?.endsWith('-owned-uid'))process.exit(4);fs.appendFileSync(log,JSON.stringify({deleteUid:request.preconditions.uid})+'\\n');process.exit(0);}
process.exit(5);
`,
			{ mode: 0o700 },
		);
		const nodeArgs = [];
		if (scenario === "private-file-cleanup") {
			const fault = join(directory, "fail-private-cleanup.cjs");
			await writeFile(
				fault,
				`
const fs = require("node:fs/promises");
const { basename, dirname } = require("node:path");
const remove = fs.rm;
fs.rm = async (path, ...options) => {
  if (dirname(path) === process.env.TMPDIR && basename(path).startsWith("ack-template-private-")) {
    throw new Error("simulated private directory cleanup failure");
  }
  return remove(path, ...options);
};
require("node:module").syncBuiltinESMExports();
`,
			);
			nodeArgs.push("--require", fault);
		}
		const result = spawnSync(process.execPath, [...nodeArgs, script, file], {
			encoding: "utf8",
			timeout: 15000,
			env: {
				...process.env,
				TMPDIR: directory,
				PATH: `${bin}:${process.env.PATH}`,
			},
		});
		assert.equal(result.status, 1);
		assert.match(
			result.stderr,
			scenario === "ready-failed"
				? /TEMPLATE_POD_READINESS_FAILED/u
				: scenario === "private-file-cleanup"
					? /PREFLIGHT_PRIVATE_CLEANUP_FAILED/u
					: /PREFLIGHT_CLEANUP_FAILED/u,
		);
		assert.doesNotMatch(result.stdout, /"status":"passed"/u);
		const { Secret } = JSON.parse(await readFile(state, "utf8"));
		assert.equal(
			Buffer.from(Secret.data["service-token"], "base64").toString(),
			serviceToken,
		);
		assert.equal(
			`${result.stdout}${result.stderr}`.includes("synthetic-service-token"),
			false,
		);
		const calls = (await readFile(log, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(
			calls.filter(
				(args) =>
					Array.isArray(args) &&
					args.includes("create") &&
					!args.includes("secret"),
			).length,
			5,
		);
		const deleted = calls
			.filter((entry) => !Array.isArray(entry))
			.map((entry) => entry.deleteUid);
		assert(deleted.includes("Pod-owned-uid"));
		assert.equal(
			deleted.includes("PersistentVolumeClaim-owned-uid"),
			scenario !== "foreign-pvc-cleanup",
		);
		assert.equal(
			deleted.includes("Secret-owned-uid"),
			scenario !== "foreign-secret-cleanup",
		);

		const identity = JSON.parse(
			await readFile(join(output, "owned-resource-identities.json")),
		);
		assert.equal(identity.resources.length, 5);
		assert.equal(identity.sourceCommit, executorJob.sourceCommit);
		assert.equal(identity.templateId, executorJob.templateId);
		assert.equal(
			identity.resources.every((resource) =>
				resource.uid.endsWith("-owned-uid"),
			),
			true,
		);
		assert.equal(
			JSON.stringify(identity).includes("synthetic-service-token"),
			false,
		);
		const outputs = await readdir(output);
		assert.equal(
			outputs.some(
				(name) =>
					name.startsWith(".attestation-") ||
					name.startsWith(".service-token-") ||
					name.startsWith(".model-credential-"),
			),
			false,
		);
		assert.equal(
			(await readdir(directory)).some((name) =>
				name.startsWith("ack-template-private-"),
			),
			scenario === "private-file-cleanup",
		);
	});

test("capacity networking is default deny with only exact approved model and DNS destinations", () => {
	const { rendered } = executorFixture();
	assert.equal(rendered.serviceAccount.automountServiceAccountToken, false);
	assert.equal(
		rendered.pod.spec.serviceAccountName,
		rendered.serviceAccount.metadata.name,
	);
	assert.deepEqual(rendered.networkPolicy.spec.ingress, []);
	assert.deepEqual(rendered.networkPolicy.spec.policyTypes, [
		"Ingress",
		"Egress",
	]);
	assert.deepEqual(rendered.networkPolicy.spec.egress, [
		{
			to: [{ ipBlock: { cidr: "192.0.2.1/32" } }],
			ports: [{ protocol: "TCP", port: 443 }],
		},
		{
			to: [
				{
					namespaceSelector: {
						matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
					},
					podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
				},
			],
			ports: [
				{ protocol: "UDP", port: 53 },
				{ protocol: "TCP", port: 53 },
			],
		},
	]);
	for (const change of [
		{ modelEgress: [] },
		{ modelEgress: [{ destination: { cidr: "0.0.0.0/0" }, port: 443 }] },
		{ modelEgress: [{ destination: { ip: "192.0.2.1" }, port: 5432 }] },
		{
			modelEgress: [
				{
					destination: { namespace: "foreign", podLabels: { app: "database" } },
					port: 443,
				},
			],
		},
		{ dnsEgress: [] },
		{ dnsEgress: [{ cidr: "0.0.0.0/0" }] },
		{ dnsEgress: [{ namespace: "kube-system", podLabels: {} }] },
		{ dnsEgress: [{ namespace: "*", podLabels: { app: "dns" } }] },
		{
			dnsEgress: [
				{ namespace: "kube-system", podLabels: { "invalid key": "dns" } },
			],
		},
	])
		assert.throws(
			() => validateTemplatePreflightJob({ ...executorJob, ...change }),
			/PREFLIGHT_EGRESS_INVALID/u,
		);
});

test("only explicitly approved provider topology labels are accepted after scheduling", () => {
	const job = {
		...executorJob,
		allowedPodTopologyLabelValues: {
			"topology.kubernetes.io/region": ["test-region"],
			"topology.kubernetes.io/zone": ["test-zone-a"],
		},
	};
	const fixture = executorFixture(job);
	fixture.observed.metadata.labels["topology.kubernetes.io/region"] =
		"test-region";
	fixture.observed.metadata.labels["topology.kubernetes.io/zone"] =
		"test-zone-a";
	assert.equal(fixture.observe().storageClassName, "test-essd");
	fixture.observed.metadata.labels["topology.kubernetes.io/zone"] =
		"foreign-zone";
	assert.throws(fixture.observe, /PREFLIGHT_TOPOLOGY_DRIFT/u);
	for (const invalid of [
		{ "arbitrary-label": ["value"] },
		{ "topology.kubernetes.io/region": [] },
		{ "topology.kubernetes.io/zone": ["*"] },
	])
		assert.throws(
			() =>
				validateTemplatePreflightJob({
					...executorJob,
					allowedPodTopologyLabelValues: invalid,
				}),
			/PREFLIGHT_TOPOLOGY_INVALID/u,
		);
});

for (const role of ["control", "executor", "init"]) {
	test(`capacity observation accepts numeric resource aliases for ${role} without changing raw evidence`, () => {
		const fixture = executorFixture();
		const container =
			role === "control"
				? fixture.observed.spec.containers[0]
				: role === "executor"
					? fixture.observed.spec.containers[1]
					: fixture.observed.spec.initContainers[0];
		container.resources =
			role === "control"
				? {
						requests: { cpu: "0.1", memory: "0.125Gi" },
						limits: { cpu: "1000m", memory: "2048Mi" },
					}
				: {
						requests: { cpu: "0.25", memory: "0.25Gi" },
						limits: { cpu: "1000m", memory: "0.5Gi" },
					};
		const raw = structuredClone(container.resources);
		const receipt = fixture.observe();
		assert.deepEqual(container.resources, raw);
		if (role === "executor")
			assert.deepEqual(receipt.observedExecutorResources, raw);
		if (role === "init") assert.deepEqual(receipt.observedInitResources, raw);
	});
}

test("capacity observation accepts numeric tmp size aliases without changing the live projection", () => {
	const fixture = executorFixture();
	for (const volume of fixture.observed.spec.volumes) {
		if (volume.emptyDir) volume.emptyDir.sizeLimit = "0.125Gi";
	}
	fixture.observe();
	assert.equal(fixture.observed.spec.volumes[1].emptyDir.sizeLimit, "0.125Gi");
	assert.equal(fixture.observed.spec.volumes[2].emptyDir.sizeLimit, "0.125Gi");
});

for (const [role, field, value] of [
	["control", "cpu", "0.2"],
	["executor", "memory", "0.125Gi"],
	["init", "cpu", "0.5"],
]) {
	test(`resource normalization still rejects changed ${role} ${field}`, () => {
		const fixture = executorFixture();
		const container =
			role === "control"
				? fixture.observed.spec.containers[0]
				: role === "executor"
					? fixture.observed.spec.containers[1]
					: fixture.observed.spec.initContainers[0];
		container.resources.requests[field] = value;
		assert.throws(fixture.observe, /EXECUTOR_LAYOUT_DRIFT/u);
	});
}

for (const role of ["control", "executor", "init"]) {
	test(`resource normalization still rejects extra ${role} resource fields`, () => {
		const fixture = executorFixture();
		const container =
			role === "control"
				? fixture.observed.spec.containers[0]
				: role === "executor"
					? fixture.observed.spec.containers[1]
					: fixture.observed.spec.initContainers[0];
		container.resources.limits["ephemeral-storage"] = "1Gi";
		assert.throws(fixture.observe, /EXECUTOR_LAYOUT_DRIFT/u);
	});
}

test("tmp size normalization still rejects changed or missing limits", () => {
	for (const size of ["0.25Gi", undefined, "invalid", "0"]) {
		const fixture = executorFixture();
		fixture.observed.spec.volumes[2].emptyDir.sizeLimit = size;
		assert.throws(fixture.observe, /EXECUTOR_LAYOUT_DRIFT/u);
	}
});

test("API canonical values match fractional executor policy quantities without rewriting the policy", () => {
	const job = {
		...executorJob,
		codexSessionExecutor: {
			...executorPolicy,
			resources: {
				requests: { cpu: "0.25", memory: "0.25Gi" },
				limits: { cpu: "1", memory: "0.5Gi" },
			},
			tmpSizeLimit: "0.125Gi",
		},
	};
	const fixture = executorFixture(job);
	fixture.observed.spec.containers[1].resources = structuredClone(
		executorPolicy.resources,
	);
	fixture.observed.spec.initContainers[0].resources = structuredClone(
		executorPolicy.resources,
	);
	fixture.observed.spec.volumes[2].emptyDir.sizeLimit = "128Mi";
	const receipt = fixture.observe();
	assert.equal(receipt.observedExecutorResources.limits.memory, "512Mi");
	assert.equal(receipt.observedInitResources.requests.cpu, "250m");
	assert.equal(job.codexSessionExecutor.resources.limits.memory, "0.5Gi");
	assert.equal(job.codexSessionExecutor.tmpSizeLimit, "0.125Gi");
});

test("Codex SDK ACS preflight binds both containers and preserves provider annotations", () => {
	const job = {
		...executorJob,
		codexSessionExecutor: undefined,
		transport: "paseo-sdk-pod",
		sessionRuntimePlacement: { architecture: "amd64", compute: "acs" },
	};
	assert.doesNotThrow(() => validateTemplatePreflightJob(job));
	const fixture = executorFixture(job);
	assert.deepEqual(
		fixture.rendered.pod.spec.containers.map((c) => c.name),
		["runtime", "pi-paseo"],
	);
	const hostEnvironment = fixture.rendered.pod.spec.containers[0].env;
	assert.equal(typeof fixture.rendered.attestation, "string");
	const probe = {
		job: {
			...job,
			namespace: "ack-community-m1-4405",
			sessionRuntimePlacement: undefined,
		},
		owner: "trial-test",
		publicKey: "synthetic",
		modelConfig: "{}",
		serviceToken: "synthetic-private-probe-token",
		textOnly: true,
	};
	const trial = renderTemplatePreflightPod(probe);
	assert.equal(trial.attestation, undefined);
	assert.equal(
		trial.pod.spec.containers[0].env.some(
			(e) => e.valueFrom?.secretKeyRef?.key === "attestation",
		),
		false,
	);
	assert.throws(
		() =>
			renderTemplatePreflightPod({
				...probe,
				job: {
					...probe.job,
					sessionRuntimePlacement: job.sessionRuntimePlacement,
				},
			}),
		/PREFLIGHT_TRIAL_JOB_INVALID/,
	);
	assert.equal(
		hostEnvironment.some((entry) => entry.name.includes("CONTAINER_BOUNDARY")),
		false,
	);
	assert.ok(
		hostEnvironment.find(
			(entry) => entry.name === "AGENT_INFRA_RUNTIME_SESSION_SCOPE",
		)?.value,
	);
	assert.ok(
		hostEnvironment.find(
			(entry) => entry.name === "AGENT_INFRA_RUNTIME_SESSION_SCOPE_ATTESTATION",
		)?.valueFrom.secretKeyRef,
	);
	assert.equal(
		fixture.rendered.pod.metadata.annotations[
			"network.alibabacloud.com/enable-network-policy-agent"
		],
		"true",
	);
	fixture.observed.metadata.annotations["alibabacloud.com/instance-id"] =
		"acs-sdk01";
	for (const c of fixture.observed.spec.containers)
		c.resources.requests["ephemeral-storage"] = "30Gi";
	assert.doesNotThrow(fixture.observe);
	fixture.observed.spec.containers[1].resources.requests.cpu = "2";
	assert.throws(fixture.observe, /EXECUTOR_LAYOUT_DRIFT/);
});

test("ECI trial checks the observed provider instance before admitting the model request", () => {
	const pod = {
		metadata: { annotations: {} },
		spec: { nodeName: "virtual-kubelet-example" },
	};
	const observed = () => preflight.observedTrialEciInstance(pod);
	assert.throws(observed, /PREFLIGHT_COMPUTE_DRIFT/);
	pod.metadata.annotations["k8s.aliyun.com/eci-instance-id"] = "eci-example01";
	assert.equal(observed(), "eci-example01");
	pod.metadata.annotations["alibabacloud.com/instance-id"] = "acs-example02";
	assert.throws(observed, /PREFLIGHT_COMPUTE_DRIFT/);
});

test("ACS preflight checks compute identity and narrowly accepts the provider storage default", () => {
	const job = {
		...executorJob,
		codexSessionExecutor: undefined,
		transport: "paseo-sdk-pod",
		sessionRuntimePlacement: { architecture: "amd64", compute: "acs" },
	};
	const fixture = executorFixture(job);
	assert.equal(
		fixture.rendered.pod.metadata.labels["alibabacloud.com/acs"],
		"true",
	);
	fixture.observed.metadata.annotations = {
		...fixture.observed.metadata.annotations,
		"alibabacloud.com/instance-id": "acs-synthetic01",
	};
	fixture.observed.spec.containers[0].resources.requests["ephemeral-storage"] =
		"30Gi";
	assert.doesNotThrow(fixture.observe);
	fixture.observed.metadata.annotations["alibabacloud.com/instance-id"] =
		"eci-synthetic01";
	assert.throws(fixture.observe, /PREFLIGHT_COMPUTE_DRIFT/);
	assert.throws(
		() => validateTemplatePreflightJob({ ...job, templateId: "claude" }),
		/PREFLIGHT_TRANSPORT_INVALID/,
	);
});

test("template CLI follows the live Worker binding through rollback in the trial namespace", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "ack-template-trial-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const job = {
		...baseJob,
		namespace: "ack-community-m1-4405",
		outputDirectory: join(dir, "output"),
	};
	await mkdir(job.outputDirectory, { mode: 0o755 });
	const path = join(dir, "job.json");
	await writeFile(path, JSON.stringify(job), { mode: 0o600 });
	await writeFile(
		join(dir, "kubectl"),
		'#!/bin/sh\n[ "$5" = get ] && [ "$6" = pods,deployments,replicasets ] || exit 71\ncat "$MOCK_WORKERS"\n',
		{ mode: 0o700 },
	);
	const mock = join(dir, "workers.json");
	const run = (...args) =>
		spawnSync(process.execPath, [script, path, ...args], {
			encoding: "utf8",
			env: {
				...process.env,
				PATH: dir + ":" + process.env.PATH,
				MOCK_WORKERS: mock,
			},
		});
	const pod = (env) => ({
		kind: "Pod",
		spec: { containers: [{ name: "platform-worker", env }] },
		status: { phase: "Running" },
	});
	const active = pod([
		{
			name: "AGENT_INFRA_SIG_CORE_SDK_TRIAL_IMAGE",
			value:
				"ghcr.io/agoraio-extensions/agent-infra/agent-runtime-codex@" +
				job.imageDigest,
		},
	]);
	const off = pod([]);
	for (const [workers, args, error] of [
		[[active], [], "PREFLIGHT_TRIAL_JOB_INVALID"],
		[[active, off], [], "PREFLIGHT_TRIAL_WORKER_INVALID"],
		[[off], ["--codex-trial"], "PREFLIGHT_TRIAL_WORKER_INVALID"],
		[[off], [], "PREFLIGHT_OUTPUT_NOT_PRIVATE"],
	]) {
		await writeFile(mock, JSON.stringify({ items: workers }));
		const result = run(...args);
		assert.equal(result.status, 1);
		assert.equal(result.stderr, error + "\n");
	}
});

test("normal virtual Codex SDK measurements bind both compute backends to provider identity", () => {
	const job = {
		transport: "paseo-sdk-pod",
		placement: { nodeSelector: { type: "virtual-kubelet" } },
	};
	const eci = { "k8s.aliyun.com/eci-instance-id": "eci-test1" };
	const acs = { "alibabacloud.com/instance-id": "acs-test2" };
	const observed = (j, annotations) =>
		preflight.observedSdkComputeInstance(j, { metadata: { annotations } });
	assert.equal(observed(job, eci), "eci-test1");
	assert.throws(() => observed(job, acs), /PREFLIGHT_COMPUTE_DRIFT/);
	assert.throws(() => observed(job, {}), /PREFLIGHT_COMPUTE_DRIFT/);
	const sessionAcs = {
		...job,
		sessionRuntimePlacement: { compute: "acs", architecture: "amd64" },
	};
	assert.equal(observed(sessionAcs, acs), "acs-test2");
	assert.throws(
		() => observed(sessionAcs, { ...acs, ...eci }),
		/PREFLIGHT_COMPUTE_DRIFT/,
	);
	assert.equal(observed({ ...job, transport: undefined }, {}), undefined);
});
