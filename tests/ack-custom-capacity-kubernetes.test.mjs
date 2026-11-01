import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createCustomCapacityKubernetes } from "../deploy/ack/custom-capacity-kubernetes.mts";

const sourceCommit = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const owner = "10000000-0000-4000-8000-000000000001";
const resources = {
	requests: { cpu: "100m", memory: "128Mi" },
	limits: { cpu: "1", memory: "2Gi" },
};
const labels = {
	"agent-infra.validation-owner": owner,
	"agent-infra.validation-source": sourceCommit,
	"agent-infra.validation-scope": "isolated-custom-runtime-capacity",
};
const imageReference = `registry.example/runtime@${imageDigest}`;
const manifest = (kind) => ({
	apiVersion: "v1",
	kind,
	metadata: {
		name: kind === "Pod" ? "capacity-pod" : "capacity-auth",
		namespace: "capacity",
		labels: { ...labels },
	},
	...(kind === "Pod"
		? {
				spec: {
					containers: [
						{
							name: "runtime",
							image: imageReference,
							resources: structuredClone(resources),
						},
					],
				},
			}
		: { stringData: { token: "never-log-this-secret" } }),
});

function childProcess(handler, options = {}) {
	const child = new EventEmitter();
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.exitCode = null;
	child.signalCode = null;
	child.signals = [];
	child.end = (code = 0) => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		child.exitCode = code;
		child.emit("close", code);
	};
	child.kill = (signal) => {
		child.signals.push(signal);
		if (options.ignoreTerm && signal === "SIGTERM") return true;
		if (child.exitCode === null && child.signalCode === null) {
			child.signalCode = signal;
			child.emit("close", null);
		}
		return true;
	};
	let input = "";
	child.stdin.on("data", (chunk) => {
		input += chunk.toString();
	});
	child.stdin.on("finish", () => setImmediate(() => handler(child, input)));
	return child;
}

async function fixture(t, config = {}) {
	const objects = new Map();
	const commands = [];
	const deletes = [];
	const children = [];
	const controller = new AbortController();
	let serial = 0;
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += chunk.toString();
		const body = JSON.parse(raw);
		const parts = request.url.split("/");
		const kind = parts.at(-2) === "pods" ? "Pod" : "Secret";
		const name = parts.at(-1);
		const key = `${kind}/${name}`;
		deletes.push({ method: request.method, url: request.url, body });
		await config.beforeDelete?.({ objects, key, body });
		const current = objects.get(key);
		if (!current) response.writeHead(404);
		else if (
			body.preconditions.uid !== current.metadata.uid ||
			body.preconditions.resourceVersion !== current.metadata.resourceVersion
		)
			response.writeHead(409);
		else {
			response.writeHead(200);
			if (!config.keepDeleted) objects.delete(key);
			config.afterDelete?.({ objects, key, body, current });
		}
		response.end("{}");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
		for (const child of children) child.kill("SIGKILL");
	});
	const execute = (args) => {
		commands.push(args);
		const verb = args[5];
		const child = childProcess(
			async (process, input) => {
				const output = (value) => {
					process.stdout.write(
						typeof value === "string" ? value : JSON.stringify(value),
					);
					process.end();
				};
				if (verb === "get") {
					const kind = { pod: "Pod", secret: "Secret", node: "Node" }[args[6]];
					const name = args[7];
					if (await config.onGet?.({ kind, name, process, objects, output }))
						return;
					if (kind === "Node")
						return output(
							config.node ?? {
								kind: "Node",
								metadata: {
									name: "node-1",
									labels: { "kubernetes.io/arch": "amd64" },
								},
								status: {
									nodeInfo: { architecture: "amd64", operatingSystem: "linux" },
								},
							},
						);
					return output(objects.get(`${kind}/${name}`) ?? "");
				}
				if (verb === "create") {
					assert.deepEqual(args.slice(6), ["-f", "-", "-o", "json"]);
					const value = JSON.parse(input);
					value.metadata.uid = `uid-${++serial}`;
					value.metadata.resourceVersion = `${serial}`;
					if (value.kind === "Pod") {
						value.spec.nodeName = "node-1";
						value.status = {
							phase: "Running",
							conditions: [{ type: "Ready", status: "True" }],
							containerStatuses: [
								{
									name: "runtime",
									imageID: `docker-pullable://${imageReference}`,
									ready: true,
									restartCount: 0,
									state: { running: { startedAt: new Date().toISOString() } },
								},
							],
						};
					}
					if (await config.onCreate?.({ value, objects, process, output }))
						return;
					objects.set(`${value.kind}/${value.metadata.name}`, value);
					return output(value);
				}
				if (verb === "proxy") {
					assert.ok(args.includes("--address=127.0.0.1"));
					assert.ok(args.includes("--port=0"));
					process.stdout.write(
						`Starting to serve on 127.0.0.1:${server.address().port}\n`,
					);
					return;
				}
				if (verb === "port-forward") {
					assert.deepEqual(args.slice(6), [
						"--address",
						"127.0.0.1",
						"pod/capacity-pod",
						":3003",
					]);
					if (config.forwardExit) {
						process.stderr.write("private-diagnostics");
						process.end(1);
						return;
					}
					process.stdout.write("Forwarding from 127.0.0.1:41733 -> 3003\n");
					return;
				}
				if (verb === "exec") {
					if (config.execOutput) return output(config.execOutput);
					return output('{"sourceCommit":"observed"}');
				}
				throw new Error(`Unexpected command: ${verb}`);
			},
			{ ignoreTerm: config.ignoreTerm },
		);
		children.push(child);
		return child;
	};
	const kube = createCustomCapacityKubernetes({
		kubeconfig: "/private/kubeconfig",
		namespace: "capacity",
		owner,
		sourceCommit,
		imageReference,
		imageDigest,
		platform: "linux/amd64",
		resources,
		signal: controller.signal,
		cleanupTimeoutMs: config.cleanupTimeoutMs ?? 1000,
		execute,
	});
	return { kube, objects, commands, deletes, children, controller };
}

test("real DELETE wire includes current UID and resourceVersion; actual Pod fields are observed", async (t) => {
	const f = await fixture(t);
	const secret = await f.kube.createSecret(manifest("Secret"));
	const pod = await f.kube.createPod(manifest("Pod"));
	assert.equal(pod.uid, "uid-2");
	const observed = await f.kube.waitReady(pod);
	assert.equal(observed.imageDigest, imageDigest);
	assert.equal(observed.sourceCommit, sourceCommit);
	assert.equal(observed.nodeName, "node-1");
	assert.deepEqual(observed.resources, resources);
	f.objects.get("Pod/capacity-pod").metadata.resourceVersion =
		"updated-after-ready";
	const cleanup = await f.kube.cleanup([secret, pod]);
	assert.equal(cleanup.status, "cleaned");
	assert.deepEqual(
		cleanup.resources.map((item) => item.kind),
		["Pod", "Secret"],
	);
	assert.equal(f.deletes[0].method, "DELETE");
	assert.equal(
		f.deletes[0].url,
		"/api/v1/namespaces/capacity/pods/capacity-pod",
	);
	assert.deepEqual(f.deletes[0].body.preconditions, {
		uid: pod.uid,
		resourceVersion: "updated-after-ready",
	});
	assert.equal(f.objects.size, 0);
	assert.ok(
		f.commands.every(
			(args) => !args.includes("apply") && !args.includes("delete"),
		),
	);
});

for (const [description, mutate] of [
	[
		"imageID digest",
		(pod) => {
			pod.status.containerStatuses[0].imageID = `containerd://sha256:${"c".repeat(64)}`;
		},
	],
	[
		"spec image",
		(pod) => {
			pod.spec.containers[0].image = "other:image";
		},
	],
	[
		"resource requests",
		(pod) => {
			pod.spec.containers[0].resources.requests.cpu = "200m";
		},
	],
	[
		"resource limits",
		(pod) => {
			delete pod.spec.containers[0].resources.limits.memory;
		},
	],
	[
		"UID",
		(pod) => {
			pod.metadata.uid = "replacement";
		},
	],
	[
		"owner",
		(pod) => {
			pod.metadata.labels["agent-infra.validation-owner"] = "other";
		},
	],
	[
		"source",
		(pod) => {
			pod.metadata.labels["agent-infra.validation-source"] = "c".repeat(40);
		},
	],
	[
		"restarted runtime",
		(pod) => {
			pod.status.containerStatuses[0].restartCount = 1;
		},
	],
])
	test(`readback rejects changed ${description}`, async (t) => {
		const f = await fixture(t);
		const ref = await f.kube.createPod(manifest("Pod"));
		mutate(f.objects.get("Pod/capacity-pod"));
		await assert.rejects(f.kube.observe(ref), /CUSTOM_CAPACITY_/u);
	});

test("node architecture is read from the scheduled node", async (t) => {
	const f = await fixture(t, {
		node: {
			metadata: { name: "node-1" },
			status: { nodeInfo: { architecture: "arm64", operatingSystem: "linux" } },
		},
	});
	const ref = await f.kube.createPod(manifest("Pod"));
	await assert.rejects(f.kube.observe(ref), /NODE_PLATFORM_MISMATCH/u);
});

for (const drift of ["uid", "owner"])
	test(`cleanup preserves resource after ${drift} drift`, async (t) => {
		const f = await fixture(t);
		const ref = await f.kube.createPod(manifest("Pod"));
		const pod = f.objects.get("Pod/capacity-pod");
		if (drift === "uid") pod.metadata.uid = "replacement";
		else pod.metadata.labels["agent-infra.validation-owner"] = "other";
		const result = await f.kube.cleanup([ref]);
		assert.equal(result.status, "failed");
		assert.equal(result.resources[0].status, "preserved");
		assert.equal(f.deletes.length, 0);
		assert.ok(f.objects.has("Pod/capacity-pod"));
	});

test("owner change between read and DELETE is rejected atomically by resourceVersion precondition", async (t) => {
	const f = await fixture(t, {
		beforeDelete: ({ objects, key }) => {
			objects.get(key).metadata.labels["agent-infra.validation-owner"] =
				"other";
			objects.get(key).metadata.resourceVersion = "new-owner-version";
		},
	});
	const ref = await f.kube.createPod(manifest("Pod"));
	assert.equal((await f.kube.cleanup([ref])).status, "failed");
	assert.ok(f.objects.has("Pod/capacity-pod"));
});

test("DELETE acknowledgement is insufficient while original UID remains", async (t) => {
	const f = await fixture(t, { keepDeleted: true, cleanupTimeoutMs: 180 });
	const ref = await f.kube.createPod(manifest("Pod"));
	const result = await f.kube.cleanup([ref]);
	assert.equal(result.status, "failed");
	assert.equal(result.resources[0].code, "CUSTOM_CAPACITY_CLEANUP_TIMEOUT");
});

test("replacement appearing after DELETE is preserved while original UID absence is confirmed", async (t) => {
	const f = await fixture(t, {
		afterDelete: ({ objects, key, current }) => {
			current.metadata.uid = "new-uid";
			objects.set(key, current);
		},
	});
	const ref = await f.kube.createPod(manifest("Pod"));
	assert.equal((await f.kube.cleanup([ref])).status, "cleaned");
	assert.equal(f.objects.get("Pod/capacity-pod").metadata.uid, "new-uid");
	assert.equal(f.deletes.length, 1);
});

test("lost create response reconciles a late persisted Secret before cleanup", async (t) => {
	const f = await fixture(t, {
		onCreate: ({ value, objects, process }) => {
			setTimeout(
				() => objects.set(`${value.kind}/${value.metadata.name}`, value),
				70,
			);
			process.stderr.write("never-log-this-secret");
			process.end(1);
			return true;
		},
	});
	await assert.rejects(
		f.kube.createSecret(manifest("Secret")),
		(error) => error.message === "CUSTOM_CAPACITY_COMMAND_FAILED",
	);
	const result = await f.kube.cleanup();
	assert.equal(result.status, "cleaned");
	assert.equal(result.resources[0].uid, "uid-1");
	assert.equal(f.objects.size, 0);
});

test("unacknowledged create with no confirmed outcome cannot claim clean absence", async (t) => {
	const f = await fixture(t, {
		cleanupTimeoutMs: 160,
		onCreate: ({ process }) => {
			process.end(1);
			return true;
		},
	});
	await assert.rejects(f.kube.createPod(manifest("Pod")));
	assert.equal((await f.kube.cleanup()).status, "failed");
});

test("existing same-name objects are never created over or deleted", async (t) => {
	const f = await fixture(t);
	f.objects.set("Secret/capacity-auth", {
		...manifest("Secret"),
		metadata: {
			...manifest("Secret").metadata,
			uid: "foreign",
			resourceVersion: "1",
		},
	});
	await assert.rejects(
		f.kube.createSecret(manifest("Secret")),
		/RESOURCE_ALREADY_EXISTS/u,
	);
	assert.equal((await f.kube.cleanup()).status, "cleaned");
	assert.equal(f.deletes.length, 0);
	assert.equal(f.commands.filter((args) => args[5] === "create").length, 0);
});

test("Ready wait aborts; cleanup has an independent working signal", async (t) => {
	const f = await fixture(t);
	const ref = await f.kube.createPod(manifest("Pod"));
	f.objects.get("Pod/capacity-pod").status.conditions = [];
	const waiting = f.kube.waitReady(ref);
	setTimeout(() => f.controller.abort(), 20);
	await assert.rejects(waiting);
	assert.equal((await f.kube.cleanup([ref])).status, "cleaned");
});

test("port-forward gets an OS-selected localhost port and close waits for forced child exit", async (t) => {
	const f = await fixture(t, { ignoreTerm: true });
	const ref = await f.kube.createPod(manifest("Pod"));
	const forward = await f.kube.forward(ref);
	assert.equal(forward.baseUrl, "http://127.0.0.1:41733");
	const child =
		f.children[f.commands.findIndex((args) => args[5] === "port-forward")];
	await forward.close();
	assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
	assert.equal(child.signalCode, "SIGKILL");
});

test("failed port-forward child fails startup without exposing process diagnostics", async (t) => {
	const f = await fixture(t, { forwardExit: true });
	const ref = await f.kube.createPod(manifest("Pod"));
	await assert.rejects(
		f.kube.forward(ref),
		(error) => error.message === "CUSTOM_CAPACITY_SERVER_EXITED",
	);
});

test("port-forward exit after startup prevents successful close", async (t) => {
	const f = await fixture(t);
	const ref = await f.kube.createPod(manifest("Pod"));
	const forward = await f.kube.forward(ref);
	f.children[f.commands.findIndex((args) => args[5] === "port-forward")].end(1);
	await assert.rejects(forward.close(), /SERVER_EXITED/u);
	assert.equal((await f.kube.cleanup([ref])).status, "failed");
});

test("exec output is bounded and discarded on overflow", async (t) => {
	const f = await fixture(t, { execOutput: "secret".repeat(200_000) });
	const ref = await f.kube.createPod(manifest("Pod"));
	await assert.rejects(
		f.kube.execInPod(ref, ["node", "-e", "void 0"]),
		(error) => error.message === "CUSTOM_CAPACITY_COMMAND_OUTPUT_LIMIT",
	);
});

test("aborted command cannot accept a late successful result", async (t) => {
	let block = false;
	const f = await fixture(t, {
		onGet: ({ output, objects }) => {
			if (!block) return false;
			block = false;
			const late = structuredClone(objects.get("Pod/capacity-pod"));
			setTimeout(() => output(late), 40);
			setTimeout(() => f.controller.abort(), 10);
			return true;
		},
	});
	const ref = await f.kube.createPod(manifest("Pod"));
	block = true;
	await assert.rejects(f.kube.observe(ref), /COMMAND_ABORTED/u);
	assert.equal((await f.kube.cleanup([ref])).status, "cleaned");
});

test("real subprocess overflow is private and the child has exited before rejection", async () => {
	let child;
	const kube = createCustomCapacityKubernetes({
		kubeconfig: "/unused/private-config",
		namespace: "capacity",
		owner,
		sourceCommit,
		imageReference,
		imageDigest,
		platform: "linux/amd64",
		resources,
		signal: new AbortController().signal,
		execute: () => {
			child = spawn(
				process.execPath,
				[
					"-e",
					'process.stderr.write("private-secret".repeat(100000)); setInterval(() => {}, 1000)',
				],
				{ stdio: ["pipe", "pipe", "pipe"] },
			);
			return child;
		},
	});
	await assert.rejects(
		kube.createSecret(manifest("Secret")),
		(error) => error.message === "CUSTOM_CAPACITY_COMMAND_OUTPUT_LIMIT",
	);
	assert.ok(child.exitCode !== null || child.signalCode !== null);
	assert.equal((await kube.cleanup()).status, "cleaned");
});

test("real subprocess is stopped on abort before a late response can be accepted", async () => {
	const controller = new AbortController();
	let child;
	const kube = createCustomCapacityKubernetes({
		kubeconfig: "/unused/private-config",
		namespace: "capacity",
		owner,
		sourceCommit,
		imageReference,
		imageDigest,
		platform: "linux/amd64",
		resources,
		signal: controller.signal,
		execute: () => {
			child = spawn(
				process.execPath,
				[
					"-e",
					'setTimeout(() => { process.stdout.write("{}"); process.exit(0); }, 500)',
				],
				{ stdio: ["pipe", "pipe", "pipe"] },
			);
			setTimeout(() => controller.abort(), 30);
			return child;
		},
	});
	await assert.rejects(kube.createPod(manifest("Pod")), /COMMAND_ABORTED/u);
	assert.ok(child.exitCode !== null || child.signalCode !== null);
});
