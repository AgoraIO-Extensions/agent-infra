import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import {
	createHash,
	createPublicKey,
	generateKeyPairSync,
	randomUUID,
	sign,
	verify,
} from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	codexSessionExecutorBindingDigestV1,
	createCodexSessionExecutorBindingV1,
	executorControlRequestV1,
	executorIdentityFileRootV1,
	executorIdentityFileV1,
	executorRunnerControlOriginV1,
	issueExecutorStartIdentityV1,
} from "@agent-infra/agent-runtime";
import {
	type SessionInstanceReadRequestV1,
	sessionInstanceRequestSigningPayloadV1,
} from "@agent-infra/contracts/runtime";
import { startExecutorDrainGatewayV1 } from "./executor-drain-gateway.js";
import { consumeExecutorIdentityV1 } from "./executor-identity-startup.js";
import { createSessionInstanceReaderV1 } from "./session-instance.js";

assert.equal(process.platform, "linux");
const binding = createCodexSessionExecutorBindingV1({
	namespace: "instance-evidence",
	podName: "sandbox-evidence",
	sandboxId: "evidence",
	agentId: "agent-evidence",
	conversationId: "session-evidence",
	sessionGeneration: 2,
	resourceFence: 3,
	imageDigest: `registry.example/runtime@sha256:${"a".repeat(64)}`,
});
const delivery = join(executorIdentityFileRootV1, executorIdentityFileV1);
if (process.argv[2] === "runner") {
	const identity = await consumeExecutorIdentityV1(
		"runner",
		binding,
		process.env,
	);
	// A real same-UID business descendant cannot inspect either key-holding process.
	execFileSync(
		process.execPath,
		[
			"-e",
			`
 const fs=require("node:fs"), assert=require("node:assert/strict");
 for(const pid of [${process.ppid},${process.pid}]) for(const path of ["mem","environ","fd"]){
  assert.throws(()=>path==="fd"?fs.readdirSync("/proc/"+pid+"/"+path):fs.readFileSync("/proc/"+pid+"/"+path));
 }
 assert.throws(()=>fs.readFileSync(${JSON.stringify(delivery)}));
 `,
		],
		{
			stdio: "pipe",
			env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
			timeout: 5000,
		},
	);
	const runner = await startExecutorDrainGatewayV1({
		binding,
		identity,
		epoch: "runner-evidence",
		nativeHome: "/tmp/evidence-native",
	});
	process.send?.({ ready: true });
	process.once("message", () => {
		void runner.close().then(() => process.disconnect?.());
	});
} else {
	await mkdir(binding.workspaceRoot, { recursive: true });
	const directory = await mkdtemp(join(tmpdir(), "host-evidence-"));
	const issuer = generateKeyPairSync("ed25519");
	const worker = generateKeyPairSync("ed25519");
	const start = {
		schemaVersion: 2 as const,
		purpose: "executor-instance-startup-v2" as const,
		podUid: "original-pod",
		bindingDigest: codexSessionExecutorBindingDigestV1(binding),
		startupRef: "original-start",
		expiresAt: Date.now() + 60_000,
		instance: {
			attemptId: randomUUID(),
			recordRef: randomUUID(),
			sandboxId: binding.sandboxId,
			configurationRevision: 1,
			configurationVersion: "evidence-config",
			generation: 2,
			resourceFence: 3,
		},
	};
	const materials = issueExecutorStartIdentityV1(start, issuer.privateKey);
	const environment = {
		PATH: "/opt/codex/bin:/usr/local/bin:/usr/bin:/bin",
		AGENT_INFRA_RUNTIME_POD_UID: start.podUid,
		AGENT_INFRA_EXECUTOR_STARTUP_REF: start.startupRef,
		AGENT_INFRA_EXECUTOR_STARTUP_DEADLINE: String(start.expiresAt),
		AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY: issuer.publicKey
			.export({ format: "pem", type: "spki" })
			.toString(),
	};
	await writeFile(delivery, JSON.stringify(materials.host), {
		flag: "wx",
		mode: 0o400,
	});
	const identity = await consumeExecutorIdentityV1(
		"host",
		binding,
		environment,
	);
	await writeFile(delivery, JSON.stringify(materials.runner), {
		flag: "wx",
		mode: 0o400,
	});
	const child = fork(fileURLToPath(import.meta.url), ["runner"], {
		env: environment,
		execArgv: ["--disable-sigusr1"],
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	let childError = "";
	child.stderr?.on("data", (chunk) => {
		childError += String(chunk);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("runner startup timeout")),
				10_000,
			);
			child.once("message", () => {
				clearTimeout(timer);
				resolve();
			});
			child.once("exit", () => {
				clearTimeout(timer);
				reject(new Error(`runner exited: ${childError}`));
			});
		});
		const reader = createSessionInstanceReaderV1({
			identity,
			binding,
			podUid: start.podUid,
			runnerEpoch: "runner-evidence",
			profileDigest: "b".repeat(64),
			hostKeyId: "original-host-key",
			worker: {
				workerId: "worker",
				issuer: "platform",
				keyId: "worker-key",
				publicKey: worker.publicKey,
			},
			isBusinessStateEmpty: () => true,
			readPreparation: async (signal) => {
				const result = (await executorControlRequestV1(
					identity,
					executorRunnerControlOriginV1,
					"/control/status",
					{ epoch: "runner-evidence", generation: 2, resourceFence: 3 },
					signal,
				)) as {
					epoch: string;
					runnerIdentityConsumed: boolean;
					deliveryFilesRemoved: boolean;
					executorReady: boolean;
					emptyBusinessState: boolean;
				};
				return { ...result, runnerEpoch: result.epoch };
			},
		});
		const at = Date.now();
		const body: SessionInstanceReadRequestV1 = {
			schemaVersion: 1,
			requestId: randomUUID(),
			traceId: randomUUID(),
			nonce: randomUUID(),
			workerId: "worker",
			namespace: binding.namespace,
			agentId: binding.agentId,
			sessionId: binding.conversationId,
			sandboxId: binding.sandboxId,
			podUid: start.podUid,
			generation: 2,
			resourceFence: 3,
			startupRef: start.startupRef,
			bindingDigest: start.bindingDigest,
			profileDigest: "b".repeat(64),
			scope: {
				phase: "reserve",
				reserveRef: "reserve",
				reserveDeliveryFence: 1,
			},
			authorization: "unsigned",
		};
		const claims = {
			issuer: "platform",
			workerId: "worker",
			audience: "runtime_host_session_instance",
			purpose: "session-instance-read-v1",
			issuedAt: at,
			expiresAt: at + 10_000,
			requestDigest: createHash("sha256")
				.update(sessionInstanceRequestSigningPayloadV1(body))
				.digest("hex"),
		};
		const signed = [
			JSON.stringify({
				alg: "EdDSA",
				typ: "session-instance-read-v1",
				kid: "worker-key",
			}),
			JSON.stringify(claims),
		]
			.map((value) => Buffer.from(value).toString("base64url"))
			.join(".");
		body.authorization = `${signed}.${sign(null, Buffer.from(signed), worker.privateKey).toString("base64url")}`;
		const result = await reader(body);
		assert.deepEqual(result.checks, {
			hostIdentityConsumed: true,
			runnerIdentityConsumed: true,
			deliveryFilesRemoved: true,
			executorReady: true,
			emptyBusinessState: true,
		});
		const [header, payload, signature] = result.signature.split(".") as [
			string,
			string,
			string,
		];
		assert.equal(
			verify(
				null,
				Buffer.from(`${header}.${payload}`),
				createPublicKey(identity.privateKey),
				Buffer.from(signature, "base64url"),
			),
			true,
		);
		await assert.rejects(reader(body), {
			code: "RUNTIME_SESSION_INSTANCE_DENIED",
		});
		assert.equal(
			JSON.stringify(result).includes(materials.host.privateKey),
			false,
		);
		child.send({ close: true });
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("runner close timeout")),
				5000,
			);
			child.once("exit", (code) => {
				clearTimeout(timer);
				code === 0 ? resolve() : reject(new Error("runner close failed"));
			});
		});
		process.stdout.write(
			"real separate Host/runner consumption, authenticated live preparation, signed evidence, replay refusal and same-UID key isolation passed\n",
		);
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await rm(directory, { recursive: true, force: true });
	}
}
