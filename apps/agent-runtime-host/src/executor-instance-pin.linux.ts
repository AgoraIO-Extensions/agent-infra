import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	codexSessionExecutorBindingDigestV1,
	createCodexSessionExecutorBindingV1,
	executorControlRequestV1,
	executorRunnerControlOriginV1,
	issueExecutorStartIdentityV1,
	openCodexSessionExecutorAdmissionV1,
	pinCodexSessionExecutorEpochV1,
	verifyExecutorStartIdentityV1,
} from "@agent-infra/agent-runtime";
import { WebSocket } from "ws";
import { startExecutorDrainGatewayV1 } from "./executor-drain-gateway.js";
import { openExecutorDrainHostV1 } from "./executor-drain-host.js";
import { protectExecutorIdentityProcessV1 } from "./executor-identity-process.js";
import { executorChildrenV1 } from "./executor-process-group.js";

assert.equal(process.platform, "linux");
protectExecutorIdentityProcessV1();
const binding = createCodexSessionExecutorBindingV1({
	namespace: "instance-regression",
	podName: "sandbox-instance",
	sandboxId: "instance",
	agentId: "agent-instance",
	conversationId: "conversation-instance",
	sessionGeneration: 2,
	resourceFence: 3,
	imageDigest: `registry.example/runtime@sha256:${"a".repeat(64)}`,
});
await mkdir(binding.workspaceRoot, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "executor-instance-linux-"));
const issuer = generateKeyPairSync("ed25519");
const originals = new Map<string, string>();
let oldHost: ReturnType<typeof verifyExecutorStartIdentityV1> | undefined;
try {
	for (const [index, podUid] of ["pod-original", "pod-successor"].entries()) {
		const start = {
			schemaVersion: 2 as const,
			purpose: "executor-instance-startup-v2" as const,
			podUid,
			bindingDigest: codexSessionExecutorBindingDigestV1(binding),
			startupRef: `executor-${randomUUID()}`,
			expiresAt: Date.now() + 3000,
			instance: {
				attemptId: randomUUID(),
				recordRef: randomUUID(),
				sandboxId: binding.sandboxId,
				configurationRevision: 1,
				configurationVersion: "configuration-one",
				generation: 2,
				resourceFence: 3,
			},
		};
		const material = issueExecutorStartIdentityV1(start, issuer.privateKey);
		const getIdentity = (role: "host" | "runner") =>
			verifyExecutorStartIdentityV1(material[role], {
				...start,
				role,
				issuerKey: issuer.publicKey,
				now: Date.now(),
			});
		const hostIdentity = getIdentity("host");
		const runnerIdentity = getIdentity("runner");
		const epoch = randomUUID();
		const runner = await startExecutorDrainGatewayV1({
			binding,
			identity: runnerIdentity,
			epoch,
			nativeHome: directory,
		});
		const admission = await openCodexSessionExecutorAdmissionV1(
			binding,
			podUid,
		);
		let socket: WebSocket | undefined;
		let host: Awaited<ReturnType<typeof openExecutorDrainHostV1>> | undefined;
		try {
			const pin = await pinCodexSessionExecutorEpochV1(
				directory,
				admission,
				hostIdentity,
				"configuration-one",
			);
			assert.ok(pin);
			assert.equal((await pin.read(randomUUID())).epoch, epoch);
			host = await openExecutorDrainHostV1(admission, hostIdentity, directory);
			const drain = host.drain;
			assert.ok(drain);
			if (oldHost)
				await assert.rejects(
					executorControlRequestV1(
						oldHost,
						executorRunnerControlOriginV1,
						"/control/status",
						{ epoch, generation: 2, resourceFence: 3 },
					),
				);
			const execution = `execution-${index}`;
			await drain.arm(execution);
			await drain.bindNativeTurn(execution, `turn-${index}`);
			socket = new WebSocket(drain.endpoint());
			await once(socket, "open");
			let sequence = 0;
			const pending = new Map<
				number,
				(value: Record<string, unknown>) => void
			>();
			socket.on("message", (bytes) => {
				const value = JSON.parse(bytes.toString());
				pending.get(value.id)?.(value);
			});
			const client = socket;
			const request = (method: string, params: unknown) =>
				new Promise<Record<string, unknown>>((resolve, reject) => {
					const id = ++sequence;
					const timer = setTimeout(
						() => reject(new Error("fixture request timeout")),
						5000,
					);
					pending.set(id, (value) => {
						clearTimeout(timer);
						pending.delete(id);
						resolve(value);
					});
					client.send(JSON.stringify({ id, method, params }));
				});
			assert.ok(
				(
					await request("initialize", {
						clientName: "instance-regression",
						resumeSessionId: null,
					})
				).result,
			);
			client.send(JSON.stringify({ method: "initialized", params: {} }));
			assert.ok(
				(
					await request("process/start", {
						processId: `tool-${index}`,
						argv: ["/bin/sh", "-c", 'sleep 60 & echo "$$"; wait'],
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
			const output = (
				await request("process/read", {
					processId: `tool-${index}`,
					afterSeq: 0,
					maxBytes: 8192,
					waitMs: 500,
				})
			).result as { chunks: { chunk: string }[] };
			const leader = Number(
				Buffer.from(output.chunks[0]?.chunk ?? "", "base64")
					.toString()
					.trim(),
			);
			assert.ok(leader > 1);
			process.kill(-leader, 0);
			await new Promise((resolve) =>
				setTimeout(resolve, Math.max(1, start.expiresAt - Date.now() + 25)),
			);
			assert.equal(await drain.confirm(execution), false);
			await drain.sealStop(execution, `stop-${index}`, 7, Date.now() + 20000);
			assert.equal(await drain.confirm(execution), true);
			assert.throws(() => process.kill(-leader, 0), { code: "ESRCH" });
			const journal = join(
				directory,
				"executor-drain",
				`${createHash("sha256").update(execution).digest("hex")}.json`,
			);
			const fact = JSON.parse(await readFile(journal, "utf8"));
			assert.equal(fact.scope.startup.startupRef, start.startupRef);
			assert.equal(fact.scope.startup.attemptId, start.instance.attemptId);
			assert.equal(fact.confirmed, true);
			if (index === 1) await assert.rejects(drain.arm("execution-0"));
			for (const [name, bytes] of originals)
				assert.equal(await readFile(join(directory, name), "utf8"), bytes);
			if (index === 0) {
				for (const name of await readdir(directory))
					if (name.startsWith(".executor-instance-"))
						originals.set(name, await readFile(join(directory, name), "utf8"));
				originals.set(
					`executor-drain/${createHash("sha256").update(execution).digest("hex")}.json`,
					await readFile(journal, "utf8"),
				);
			}
			oldHost = hostIdentity;
		} finally {
			socket?.terminate();
			if (host) await host.close();
			else await admission.close();
			await runner.close();
		}
		const deadline = Date.now() + 3000;
		while (
			(await executorChildrenV1(process.pid)).size &&
			Date.now() < deadline
		)
			await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.equal(
		(await readdir(directory)).filter((name) =>
			name.startsWith(".executor-instance-"),
		).length,
		2,
	);
	process.stdout.write(
		"two real fenced executor instances, original expired-bootstrap Stop, replay rejection and immutable prior journals passed\n",
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
