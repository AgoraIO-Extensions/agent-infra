import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	codexSessionExecutorBindingDigestV1,
	createCodexSessionExecutorBindingV1,
	executorControlRequestV1,
	executorRunnerControlOriginV1,
	issueExecutorStartIdentityV1,
	verifyExecutorStartIdentityV1,
} from "@agent-infra/agent-runtime";
import { WebSocket } from "ws";
import { startExecutorDrainGatewayV1 } from "./executor-drain-gateway.js";
import { openExecutorDrainHostV1 } from "./executor-drain-host.js";

/** Run in the pinned Codex image, with an isolated writable workspace and tini. */
async function run() {
	assert.equal(process.platform, "linux");
	const binding = createCodexSessionExecutorBindingV1({
		namespace: "executor-regression",
		podName: "sandbox-drain-regression",
		sandboxId: "drain-regression",
		agentId: "agent-drain-regression",
		conversationId: "conversation-drain-regression",
		sessionGeneration: 2,
		resourceFence: 3,
		imageDigest: `registry.example.test/runtime@sha256:${"a".repeat(64)}`,
	});
	await mkdir(binding.workspaceRoot, { recursive: true });
	const directory = await mkdtemp(join(tmpdir(), "executor-drain-"));
	const worker = generateKeyPairSync("ed25519");
	const scope = {
		podUid: "original-pod",
		startupRef: "original-start",
		bindingDigest: codexSessionExecutorBindingDigestV1(binding),
		expiresAt: Date.now() + 60_000,
	};
	const materials = issueExecutorStartIdentityV1(scope, worker.privateKey);
	const getIdentity = (role: "host" | "runner") =>
		verifyExecutorStartIdentityV1(materials[role], {
			...scope,
			role,
			issuerKey: worker.publicKey,
			now: Date.now(),
		});
	const hostIdentity = getIdentity("host");
	const epoch = randomUUID();
	const runner = await startExecutorDrainGatewayV1({
		binding,
		epoch,
		identity: getIdentity("runner"),
		nativeHome: directory,
	});
	let socket: WebSocket | undefined;
	try {
		const host = await openExecutorDrainHostV1(
			{
				binding,
				epoch,
				async assertCurrent() {},
				onFailure: () => () => {},
				async close() {},
			},
			hostIdentity,
			directory,
		);
		try {
			const drain = host.drain;
			assert.ok(drain);
			for (const sample of [
				{
					identity: { ...hostIdentity, podUid: "another-pod" },
					resourceFence: 3,
				},
				{ identity: hostIdentity, resourceFence: 2 },
			]) {
				await assert.rejects(
					executorControlRequestV1(
						sample.identity,
						executorRunnerControlOriginV1,
						"/control/attach",
						{
							executionId: "execution-original",
							epoch,
							generation: 2,
							resourceFence: sample.resourceFence,
						},
					),
					/CODEX_EXECUTOR_CONTROL_REJECTED/,
				);
			}
			await drain.arm("execution-original");
			await drain.bindNativeTurn("execution-original", "turn-original");
			const client = new WebSocket(drain.endpoint());
			socket = client;
			await once(client, "open");
			let id = 0;
			const pending = new Map<
				number,
				(frame: {
					error?: object;
					result?: { chunks?: { chunk: string; seq: number }[] };
				}) => void
			>();
			client.on("message", (message) => {
				const reply = JSON.parse(message.toString());
				pending.get(reply.id)?.(reply);
			});
			const request = (method: string, params: unknown) =>
				new Promise<Parameters<NonNullable<ReturnType<typeof pending.get>>>[0]>(
					(done, reject) => {
						const requestId = ++id;
						const timer = setTimeout(() => {
							pending.delete(requestId);
							reject(new Error("Executor replay request timed out"));
						}, 5_000);
						pending.set(requestId, (frame) => {
							pending.delete(requestId);
							clearTimeout(timer);
							done(frame);
						});
						client.send(JSON.stringify({ method, params, id: requestId }));
					},
				);
			assert.ok(
				(
					await request("initialize", {
						clientName: "stop-drain-regression",
						resumeSessionId: null,
					})
				).result,
			);
			client.send(JSON.stringify({ method: "initialized", params: {} }));
			const launch = {
				processId: "registered-original",
				argv: ["/bin/sh", "-c", 'sleep 60 & echo "$$"; wait'],
				cwd: pathToFileURL(binding.workspaceRoot).href,
				env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
				tty: false,
				pipeStdin: false,
				arg0: null,
				sandbox: null,
				enforceManagedNetwork: false,
			};
			assert.ok((await request("process/start", launch)).result);
			const output = (
				await request("process/read", {
					processId: launch.processId,
					afterSeq: 0,
					maxBytes: 8192,
					waitMs: 500,
				})
			).result?.chunks;
			assert.ok(output?.length);
			const group = Number(Buffer.from(output[0].chunk, "base64").toString());
			assert.ok(Number.isSafeInteger(group) && group > 1);
			process.kill(-group, 0);
			await drain.sealStop(
				"execution-original",
				"stop-original",
				8,
				Date.now() + 20_000,
			);
			await assert.rejects(
				drain.sealStop(
					"execution-original",
					"stop-original",
					7,
					Date.now() + 20_000,
				),
			);
			assert.ok(
				(
					await request("process/start", {
						...launch,
						processId: "late-launch",
					})
				).error,
			);
			assert.equal(await drain.confirm("execution-original"), true);
			assert.throws(() => process.kill(-group, 0), { code: "ESRCH" });
			assert.equal(drain.proven("execution-original"), true);
			assert.equal(drain.proven("execution-other"), false);
			assert.equal(await drain.confirm("execution-original"), true);
			await drain.arm("execution-next");
			assert.notEqual(drain.endpoint(), client.url);
			const originalProcess = await request("process/start", {
				...launch,
				processId: "late-original-frame",
			});
			assert.ok(originalProcess.error);
			process.stdout.write(
				"stock Codex launch, exact Stop, replay rejection and next execution passed\n",
			);
		} finally {
			socket?.terminate();
			await host.close();
		}
	} finally {
		await runner.close();
		await rm(directory, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
	await run();
