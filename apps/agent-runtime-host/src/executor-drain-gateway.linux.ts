import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	codexSessionExecutorBindingDigestV1,
	createCodexSessionExecutorBindingV1,
	executorControlRequestV1,
	executorRunnerControlOriginV1,
	issueExecutorStartIdentityV1,
	pinCodexSessionExecutorEpochV1,
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
		...(process.argv.includes("--instance-v2")
			? {
					schemaVersion: 2 as const,
					purpose: "executor-instance-startup-v2" as const,
					instance: {
						attemptId: randomUUID(),
						recordRef: randomUUID(),
						sandboxId: binding.sandboxId,
						configurationRevision: 1,
						configurationVersion: "configuration-one",
						generation: binding.sessionGeneration,
						resourceFence: binding.resourceFence,
					},
				}
			: {}),
		podUid: "original-pod",
		startupRef: "original-start",
		bindingDigest: codexSessionExecutorBindingDigestV1(binding),
		expiresAt:
			Date.now() +
			(process.argv.includes("--bootstrap-expired") ? 3000 : 60_000),
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
	const openRunner = () =>
		startExecutorDrainGatewayV1({
			binding,
			epoch,
			identity: getIdentity("runner"),
			nativeHome: directory,
		});
	if (process.argv.includes("--unverified-launch-isolation")) {
		try {
			await assert.rejects(async () => {
				const unexpected = await openRunner();
				await unexpected.close();
			}, /CODEX_EXECUTOR_LAUNCH_NOT_ISOLATED/);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
		return;
	}
	const runner = await openRunner();
	let socket: WebSocket | undefined;
	const launchInterrupted = process.argv.includes("--lost-launch");
	const originalAdmission = {
		binding,
		podUid: scope.podUid,
		epoch,
		async assertCurrent() {},
		onFailure: () => () => {},
		async close() {},
	};
	try {
		if (process.argv.includes("--instance-v2"))
			await pinCodexSessionExecutorEpochV1(
				directory,
				originalAdmission,
				hostIdentity,
				"configuration-one",
			);
		const host = await openExecutorDrainHostV1(
			originalAdmission,
			hostIdentity,
			directory,
		);
		let hostClosed = false;
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
			if (process.argv.includes("--delayed-read")) {
				const slow = {
					processId: "slow-output",
					argv: ["/bin/sh", "-c", "sleep 3; printf delayed-output"],
					cwd: pathToFileURL(binding.workspaceRoot).href,
					env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
					tty: false,
					pipeStdin: false,
					arg0: null,
					sandbox: null,
					enforceManagedNetwork: false,
				};
				assert.ok((await request("process/start", slow)).result);
				const read = await request("process/read", {
					processId: slow.processId,
					afterSeq: 0,
					maxBytes: 8192,
					waitMs: 5000,
				});
				assert.ok(
					read.result?.chunks?.some((chunk) =>
						Buffer.from(chunk.chunk, "base64")
							.toString()
							.includes("delayed-output"),
					),
				);
				const since = Date.now();
				for (const waitMs of [
					30001,
					-1,
					1.5,
					Number.MAX_SAFE_INTEGER,
					null,
					"5000",
				]) {
					assert.ok(
						(
							await request("process/read", {
								processId: slow.processId,
								afterSeq: 0,
								maxBytes: 8192,
								waitMs,
							})
						).error,
					);
				}
				assert.ok(
					Date.now() - since < 2000,
					"invalid waits must fail before reaching the server",
				);
				process.stdout.write("bounded delayed process/read passed\n");
				return;
			}
			if (process.argv.includes("--rejected-start")) {
				const withLiveGroup = process.argv.includes("--with-live-group");
				if (withLiveGroup)
					assert.ok(
						(
							await request("process/start", {
								processId: "live-before-rejection",
								argv: ["/bin/sh", "-c", "sleep 60"],
								cwd: pathToFileURL(binding.workspaceRoot).href,
								env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
								tty: false,
								pipeStdin: false,
								arg0: null,
								sandbox: null,
								enforceManagedNetwork: false,
							})
						).result,
					);
				const response = await request("process/start", {
					processId: "rejected-original",
					argv: ["/bin/sh", "-c", "exit 0"],
					cwd: pathToFileURL(join(directory, "missing-directory")).href,
					env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
					tty: false,
					pipeStdin: false,
					arg0: null,
					sandbox: null,
					enforceManagedNetwork: false,
				});
				assert.ok(
					response.error,
					"the stock server must explicitly reject the launch",
				);
				const stop = !process.argv.includes("--natural");
				if (withLiveGroup) {
					assert.equal(await drain.confirm("execution-original"), false);
					assert.equal(drain.proven("execution-original"), false);
				}
				if (stop)
					await drain.sealStop(
						"execution-original",
						"stop-original",
						8,
						Date.now() + 20_000,
					);
				const started = Date.now();
				assert.equal(
					await drain.confirm("execution-original"),
					true,
					"an explicitly rejected launch must not permanently block drain",
				);
				assert.ok(Date.now() - started < 5000);
				const file = join(
					directory,
					"executor-drain",
					`${createHash("sha256").update("execution-original").digest("hex")}.json`,
				);
				const persisted = JSON.parse(await readFile(file, "utf8"));
				assert.equal(
					persisted.attempts.length,
					withLiveGroup ? 2 : 1,
					"retain every original admission",
				);
				assert.equal(
					persisted.attempts[withLiveGroup ? 1 : 0].handle,
					"rejected-original",
				);
				assert.equal(
					persisted.attempts[withLiveGroup ? 1 : 0].rejection.code,
					-32603,
				);
				assert.equal(persisted.evidence.groups.length, withLiveGroup ? 1 : 0);
				assert.equal(persisted.evidence.rejectedStarts.length, 1);
				assert.equal(persisted.stop.stopFence, stop ? 8 : 1);
				assert.equal(persisted.scope.epoch, epoch);
				assert.equal(drain.proven("execution-original"), true);
				await drain.arm("execution-next");
				assert.notEqual(drain.endpoint(), client.url);
				process.stdout.write(
					`stock explicit start rejection, ${stop ? "Stop" : "natural drain"}, durable evidence and next execution passed\n`,
				);
				return;
			}
			const detached = process.argv.includes("--detached-descendant");
			const launch = {
				processId: "registered-original",
				argv: detached
					? [
							"/usr/local/bin/node",
							"-e",
							'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{detached:true,stdio:"ignore"});child.unref();process.stdout.write(process.pid+" "+child.pid);',
						]
					: ["/bin/sh", "-c", 'sleep 60 & echo "$$"; wait'],
				cwd: pathToFileURL(binding.workspaceRoot).href,
				env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
				tty: false,
				pipeStdin: false,
				arg0: null,
				sandbox: null,
				enforceManagedNetwork: false,
			};
			if (launchInterrupted) {
				// Deliberately drop the launch acknowledgement. The next serialized
				// request is the independent witness that the original group exists.
				client.send(
					JSON.stringify({ method: "process/start", params: launch, id: ++id }),
				);
			} else {
				assert.ok((await request("process/start", launch)).result);
			}
			const output = (
				await request("process/read", {
					processId: launch.processId,
					afterSeq: 0,
					maxBytes: 8192,
					waitMs: 500,
				})
			).result?.chunks;
			const firstChunk = output?.[0];
			assert.ok(firstChunk);
			const ids = Buffer.from(firstChunk.chunk, "base64")
				.toString()
				.trim()
				.split(/\s+/);
			const group = Number(ids[0]);
			const childPid = Number(ids[1]);
			assert.ok(Number.isSafeInteger(group) && group > 1);
			if (detached) {
				assert.ok(Number.isSafeInteger(childPid) && childPid > 1);
				process.kill(childPid, 0);
			} else process.kill(-group, 0);
			if (launchInterrupted) {
				await host.close();
				hostClosed = true;
				const reopened = await openExecutorDrainHostV1(
					originalAdmission,
					hostIdentity,
					directory,
				);
				try {
					const file = join(
						directory,
						"executor-drain",
						`${createHash("sha256").update("execution-original").digest("hex")}.json`,
					);
					const persisted = JSON.parse(await readFile(file, "utf8"));
					assert.equal(persisted.scope.epoch, epoch);
					assert.equal(persisted.confirmed, false);
					assert.equal(persisted.attempts.length, 1);
					assert.equal(persisted.attempts[0].handle, launch.processId);
					assert.equal(
						await reopened.drain?.confirm("execution-original"),
						false,
					);
					await assert.rejects(
						reopened.drain?.arm("execution-after-crash") ?? Promise.resolve(),
					);
					process.kill(-group, 0);
				} finally {
					await reopened.close();
				}
				return;
			}
			assert.equal(await drain.confirm("execution-original"), false);
			assert.equal(drain.proven("execution-original"), false);
			await assert.rejects(drain.arm("execution-before-drain"));
			if (detached) process.kill(childPid, 0);
			else process.kill(-group, 0);
			if (process.argv.includes("--bootstrap-expired")) {
				const until = scope.expiresAt - Date.now() + 25;
				if (until > 0)
					await new Promise((resolve) => setTimeout(resolve, until));
			}
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
			if (detached)
				assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
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
			if (!hostClosed) await host.close();
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
