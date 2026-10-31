import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import {
	bootstrapInputs,
	checkExistingInputs,
	requiredInputs,
} from "../deploy/ack/bootstrap-inputs.ts";

const clusterUid = "11111111-1111-1111-1111-111111111111";
const installationId = "22222222-2222-2222-2222-222222222222";
const ownerLabel = "agent-infra.agora.io/bootstrap-id";
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "ack-bootstrap-"));
	const token = join(directory, "token");
	const moduleFile = join(directory, "source.mjs");
	const tls = join(directory, "tls");
	const registry = join(directory, "registry.json");
	await writeFile(token, "private-token-canary\n", { mode: 0o600 });
	await writeFile(moduleFile, "export const source = 'fixture';\n", {
		mode: 0o600,
	});
	await writeFile(tls, "private-tls-canary", { mode: 0o600 });
	await writeFile(
		registry,
		JSON.stringify({
			auths: { "registry.example": { auth: "private-auth-canary" } },
		}),
		{ mode: 0o600 },
	);
	const config = {
		schemaVersion: 1,
		clusterUid,
		installationId,
		namespace: "rebuild-test",
		objects: [
			{ kind: "Secret", name: "renamed-token", files: { token } },
			{
				kind: "ConfigMap",
				name: "renamed-source",
				files: { "source.mjs": moduleFile },
			},
			{
				kind: "Secret",
				name: "renamed-tls",
				secretType: "kubernetes.io/tls",
				files: { "tls.crt": tls, "tls.key": tls },
			},
			{
				kind: "Secret",
				name: "renamed-pull",
				secretType: "kubernetes.io/dockerconfigjson",
				files: { ".dockerconfigjson": registry },
			},
		],
	};
	const rendered = [
		{
			kind: "Deployment",
			spec: {
				template: {
					spec: {
						imagePullSecrets: [{ name: "renamed-pull" }],
						containers: [
							{
								env: [
									{
										valueFrom: {
											secretKeyRef: { name: "renamed-token", key: "token" },
										},
									},
								],
							},
						],
						volumes: [
							{
								configMap: {
									name: "renamed-source",
									items: [{ key: "source.mjs", path: "source.mjs" }],
								},
							},
						],
					},
				},
			},
		},
		{ kind: "Ingress", spec: { tls: [{ secretName: "renamed-tls" }] } },
	]
		.map((document) => stringify(document))
		.join("---\n");
	const objects = new Map([
		["namespace/kube-system", { metadata: { uid: clusterUid } }],
	]);
	const writes = [];
	const kubectl = (args, input) => {
		const index = args.indexOf("get");
		if (index !== -1) {
			const object = objects.get(`${args[index + 1]}/${args[index + 2]}`);
			if (!object && !args.includes("--ignore-not-found"))
				throw new Error("missing");
			return object ? JSON.stringify(object) : "";
		}
		assert(args.includes("create") && args.includes("-"));
		const object = JSON.parse(input);
		const key = `${object.kind === "Namespace" ? "namespace" : object.kind}/${object.metadata.name}`;
		assert(!objects.has(key));
		object.metadata.uid = `created-${writes.length}`;
		writes.push(key);
		objects.set(key, object);
		return "";
	};
	return { config, rendered, objects, writes, kubectl, token };
}

test("dependency discovery uses rendered Secret/ConfigMap names and required keys", async () => {
	const f = await fixture();
	const dependencies = requiredInputs(f.rendered);
	assert.equal(dependencies.length, 4);
	assert.deepEqual(
		[...dependencies.find((item) => item.name === "renamed-token").keys],
		["token"],
	);
	assert.deepEqual(
		[...dependencies.find((item) => item.name === "renamed-tls").keys],
		["tls.crt", "tls.key"],
	);
});

test("bootstrap plans without mutation, applies missing inputs, reads them back and reruns without overwriting", async () => {
	const f = await fixture();
	const plan = await bootstrapInputs(f.config, f.rendered, f.kubectl);
	assert.equal(plan.createCount, 4);
	assert.equal(f.writes.length, 0);
	const receipt = await bootstrapInputs(f.config, f.rendered, f.kubectl, true);
	assert.equal(f.writes.length, 5);
	assert.equal(receipt.deploymentVerified, false);
	assert.equal(receipt.mode, "applied-and-read-back");
	const replay = await bootstrapInputs(f.config, f.rendered, f.kubectl, true);
	assert.equal(replay.createCount, 0);
	assert.equal(f.writes.length, 5);
	assert.equal(
		checkExistingInputs(f.rendered, f.kubectl, f.config.namespace).objectCount,
		4,
	);
	const privateData = f.objects.get("Secret/renamed-token").data.token;
	assert.equal(
		Buffer.from(privateData, "base64").toString(),
		"private-token-canary\n",
	);
	for (const forbidden of [
		privateData,
		"private-token-canary",
		"private-auth-canary",
		"renamed-token",
		f.config.namespace,
	])
		assert(!JSON.stringify(receipt).includes(forbidden));
});

test("wrong cluster, foreign namespace and missing file keys fail before any write", async () => {
	for (const change of [
		(f) => {
			f.config.clusterUid = "33333333-3333-3333-3333-333333333333";
		},
		(f) => {
			f.objects.set("namespace/rebuild-test", {
				metadata: { uid: "foreign", labels: {} },
			});
		},
		(f) => {
			f.config.objects[0].files = { wrong: f.token };
		},
	]) {
		const f = await fixture();
		change(f);
		await assert.rejects(
			bootstrapInputs(f.config, f.rendered, f.kubectl, true),
		);
		assert.equal(f.writes.length, 0);
	}
});

test("all ownership and byte conflicts are detected before creating earlier missing dependencies", async () => {
	const f = await fixture();
	f.objects.set("namespace/rebuild-test", {
		metadata: { uid: "owned", labels: { [ownerLabel]: installationId } },
	});
	f.objects.set("ConfigMap/renamed-source", {
		kind: "ConfigMap",
		metadata: {
			name: "renamed-source",
			namespace: "rebuild-test",
			labels: { [ownerLabel]: installationId },
		},
		data: { "source.mjs": "foreign bytes" },
	});
	await assert.rejects(bootstrapInputs(f.config, f.rendered, f.kubectl, true));
	assert.equal(f.writes.length, 0);
});

test("bootstrap refuses to recreate a missing Secret referenced by an existing Deployment", async () => {
	const f = await fixture();
	await bootstrapInputs(f.config, f.rendered, f.kubectl, true);
	const live = {
		kind: "Deployment",
		metadata: { name: "current-api" },
		spec: {
			template: {
				spec: {
					containers: [
						{
							name: "api",
							env: [
								{
									name: "TOKEN",
									valueFrom: {
										secretKeyRef: { name: "renamed-token", key: "token" },
									},
								},
							],
						},
					],
				},
			},
		},
	};
	f.objects.set("deployment/current-api", live);
	f.objects.delete("Secret/renamed-token");
	const writesBefore = f.writes.length;
	for (const apply of [false, true])
		await assert.rejects(
			bootstrapInputs(
				f.config,
				`${f.rendered}\n---\n${stringify(live)}`,
				f.kubectl,
				apply,
			),
			/BOOTSTRAP_ACTIVE_SECRET_MISSING/,
		);
	assert.equal(f.writes.length, writesBefore);
	assert.equal(f.objects.has("Secret/renamed-token"), false);
});

test("namespace UID changes invalidate an in-flight apply; private file permission errors reject local input", async () => {
	const f = await fixture();
	f.objects.set("namespace/rebuild-test", {
		metadata: { uid: "initial", labels: { [ownerLabel]: installationId } },
	});
	let reads = 0;
	const run = (args, input) => {
		if (
			args.includes("namespace") &&
			args.includes("rebuild-test") &&
			++reads > 1
		) {
			f.objects.get("namespace/rebuild-test").metadata.uid = "replacement";
		}
		return f.kubectl(args, input);
	};
	await assert.rejects(bootstrapInputs(f.config, f.rendered, run, true));
	assert.equal(f.writes.length, 0);
	await chmod(f.token, 0o644);
	await assert.rejects(bootstrapInputs(f.config, f.rendered, f.kubectl));
});

test("preflight resolves renamed dependencies using the server version and never writes the cluster", async () => {
	const f = await fixture();
	await bootstrapInputs(f.config, f.rendered, f.kubectl, true);
	const bin = await mkdtemp(join(tmpdir(), "ack-preflight-cli-"));
	const calls = join(bin, "calls.jsonl");
	const kubeconfig = join(bin, "kubeconfig");
	const values = join(bin, "values.yaml");
	await writeFile(kubeconfig, "", { mode: 0o600 });
	await writeFile(values, "{}", { mode: 0o600 });
	const snapshots = Object.fromEntries(f.objects);
	await writeFile(
		join(bin, "kubectl"),
		`#!/usr/bin/env node
const fs=require("node:fs"),args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+"\\n");
if(args.includes("version")){process.stdout.write(JSON.stringify({serverVersion:{gitVersion:"v1.36.1"}}));process.exit(0);}
if(args.includes("get")){
 const i=args.indexOf("get");const data=${JSON.stringify(snapshots)}[args[i+1]+"/"+args[i+2]];
 if(data){process.stdout.write(JSON.stringify(data));process.exit(0);}
}
process.stderr.write("private-token-canary");
process.exit(1);
`,
		{ mode: 0o700 },
	);
	await writeFile(
		join(bin, "helm"),
		`#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==="lint")process.exit(0);
if(args[0]==="template" && args[args.indexOf("--kube-version")+1]==="v1.36.1"){
 process.stdout.write(${JSON.stringify(f.rendered)});process.exit(0);
}
process.exit(1);
`,
		{ mode: 0o700 },
	);
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		ACK_KUBECONFIG: kubeconfig,
		ACK_VALUES_FILE: values,
		ACK_NAMESPACE: f.config.namespace,
	};
	const script = join(import.meta.dirname, "../deploy/ack/preflight.sh");
	const result = spawnSync("bash", [script], { encoding: "utf8", env });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).objectCount, 4);
	const absent = spawnSync("bash", [script], {
		encoding: "utf8",
		env: { ...env, ACK_NAMESPACE: "absent-test" },
	});
	assert.notEqual(absent.status, 0);
	assert(!absent.stderr.includes("private-token-canary"));
	for (const args of (await readFile(calls, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))) {
		assert(
			!args.some((word) =>
				["create", "apply", "patch", "delete"].includes(word),
			),
		);
	}
});

test("file and module environment paths require the projected key, including Worker subPath mounts", () => {
	const rendered = stringify({
		kind: "Pod",
		spec: {
			volumes: [
				{ name: "worker", secret: { secretName: "worker-config" } },
				{ name: "runtime", secret: { secretName: "directory-runtime" } },
				{ name: "source", configMap: { name: "directory-source" } },
			],
			containers: [
				{
					volumeMounts: [
						{
							name: "worker",
							mountPath: "/app/configuration.mjs",
							subPath: "configuration.mjs",
						},
						{ name: "runtime", mountPath: "/run/secrets" },
						{ name: "source", mountPath: "/app/source" },
					],
					env: [
						{ name: "TOKEN_FILE", value: "/run/secrets/read-token" },
						{ name: "SOURCE_MODULE", value: "file:///app/source/source.ts" },
					],
				},
			],
		},
	});
	const requirements = requiredInputs(rendered);
	for (const [name, key] of [
		["worker-config", "configuration.mjs"],
		["directory-runtime", "read-token"],
		["directory-source", "source.ts"],
	])
		assert(requirements.find((item) => item.name === name).keys.has(key));
});
