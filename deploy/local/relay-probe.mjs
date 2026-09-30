#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const command = process.argv[2];
if (!["up", "status", "reset", "receipt", "stop"].includes(command)) {
	throw new Error("usage: node deploy/local/relay-probe.mjs {up|status|reset|receipt|stop}");
}

function required(name) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

const kubeconfig = required("PLATFORM_RELAY_PROBE_KUBECONFIG");
const context = required("PLATFORM_RELAY_PROBE_CONTEXT");
const namespace = required("PLATFORM_RELAY_PROBE_NAMESPACE");
const stateDirectory = required("PLATFORM_RELAY_PROBE_STATE_DIRECTORY");
if (!isAbsolute(kubeconfig) || !existsSync(kubeconfig))
	throw new Error("PLATFORM_RELAY_PROBE_KUBECONFIG must be an existing absolute file");
if (!context.startsWith("kind-"))
	throw new Error("PLATFORM_RELAY_PROBE_CONTEXT must name an isolated kind context");
if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(namespace))
	throw new Error("PLATFORM_RELAY_PROBE_NAMESPACE must be a Kubernetes DNS label");
if (!isAbsolute(stateDirectory))
	throw new Error("PLATFORM_RELAY_PROBE_STATE_DIRECTORY must be absolute");

function run(binary, args, input) {
	const result = spawnSync(binary, args, {
		encoding: "utf8",
		input,
		maxBuffer: 4 * 1024 * 1024,
	});
	if (result.error || result.status !== 0)
		throw new Error(`${binary} ${args.find((part) => !part.startsWith("--")) ?? ""} failed (exit ${result.status})`);
	return result.stdout.trim();
}

function kube(...args) {
	return run(
		"kubectl",
		[`--kubeconfig=${kubeconfig}`, `--context=${context}`, `--namespace=${namespace}`, ...args],
	);
}

function target() {
	const config = JSON.parse(kube("config", "view", "--minify", "--raw", "-o=json"));
	const server = config.clusters?.[0]?.cluster?.server;
	if (!/^https:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]+$/.test(server ?? ""))
		throw new Error("kind context API must use a local loopback address");
}

function privateDirectory() {
	if (!existsSync(stateDirectory)) mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
	const stat = lstatSync(stateDirectory);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
		throw new Error("probe state directory must be private (0700) and not a symlink");
}

const stateFile = join(stateDirectory, "state.json");
function readState() {
	privateDirectory();
	if (!existsSync(stateFile)) throw new Error("probe state does not exist; run up first");
	const state = JSON.parse(readFileSync(stateFile, "utf8"));
	if (
		state.kubeconfig !== kubeconfig ||
		state.context !== context ||
		state.namespace !== namespace ||
		!/^relay-probe-[0-9a-f]{8}$/.test(state.name)
	)
		throw new Error("probe state does not match the explicit kind target");
	return state;
}

function metadata(state, name, endpoint) {
	return {
		name,
		namespace,
		labels: {
			"agent-infra.agora.io/probe-id": state.name,
			...(endpoint ? { "agent-infra.agora.io/probe-endpoint": endpoint } : {}),
		},
	};
}

function fqdn(state, endpoint) {
	return `${state.name}-${endpoint}.${namespace}.svc.cluster.local`;
}

function names(state) {
	return [
		["configmap", state.name],
		["secret", `${state.name}-tls`],
		["secret", `${state.name}-ca`],
		["service", `${state.name}-a`],
		["service", `${state.name}-b`],
		["deployment", `${state.name}-a`],
		["deployment", `${state.name}-b`],
	];
}

function exists(kind, name) {
	return kube("get", `${kind}/${name}`, "--ignore-not-found", "-o=name") !== "";
}

function apply(resource) {
	run(
		"kubectl",
		[`--kubeconfig=${kubeconfig}`, `--context=${context}`, `--namespace=${namespace}`, "apply", "-f", "-"],
		JSON.stringify(resource),
	);
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function openssl(...args) {
	run("openssl", args);
}

function makeCertificates(state) {
	const caKey = join(stateDirectory, "ca.key");
	const caCert = join(stateDirectory, "ca.crt");
	const leafKey = join(stateDirectory, "tls.key");
	const leafCsr = join(stateDirectory, "tls.csr");
	const leafCert = join(stateDirectory, "tls.crt");
	const extensions = join(stateDirectory, "tls.ext");
	const serial = join(stateDirectory, "ca.serial");
	openssl("req", "-x509", "-newkey", "ed25519", "-nodes", "-days", "1", "-subj", "/CN=relay-probe-ca", "-keyout", caKey, "-out", caCert);
	openssl("req", "-newkey", "ed25519", "-nodes", "-subj", `/CN=${fqdn(state, "a")}`, "-keyout", leafKey, "-out", leafCsr);
	writeFileSync(
		extensions,
		`subjectAltName=DNS:${fqdn(state, "a")},DNS:${fqdn(state, "b")}\nextendedKeyUsage=serverAuth\n`,
		{ mode: 0o600 },
	);
	openssl("x509", "-req", "-in", leafCsr, "-CA", caCert, "-CAkey", caKey, "-CAserial", serial, "-CAcreateserial", "-days", "1", "-extfile", extensions, "-out", leafCert);
	for (const file of [caKey, leafKey]) chmodSync(file, 0o600);
	return {
		"tls.crt": readFileSync(leafCert).toString("base64"),
		"tls.key": readFileSync(leafKey).toString("base64"),
		"ca.crt": readFileSync(caCert).toString("base64"),
	};
}

function deployment(state, endpoint, image) {
	const name = `${state.name}-${endpoint}`;
	const labels = metadata(state, name, endpoint).labels;
	return {
		apiVersion: "apps/v1",
		kind: "Deployment",
		metadata: metadata(state, name, endpoint),
		spec: {
			replicas: 1,
			selector: { matchLabels: labels },
			template: {
				metadata: { labels },
				spec: {
					automountServiceAccountToken: false,
					securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
					containers: [{
						name: "relay",
						image,
						command: ["node", "/app/server.mjs"],
						env: [
							{ name: "RELAY_PROBE_ENDPOINT", value: endpoint },
							{ name: "RELAY_PROBE_REDIRECT_URL", value: `https://${fqdn(state, "b")}:8443/v1/responses` },
						],
						ports: [{ containerPort: 8443, name: "https" }],
						readinessProbe: { httpGet: { path: "/__probe/health", port: "https", scheme: "HTTPS" } },
						securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
						resources: { requests: { cpu: "25m", memory: "32Mi" }, limits: { cpu: "100m", memory: "128Mi" } },
						volumeMounts: [
							{ name: "source", mountPath: "/app", readOnly: true },
							{ name: "tls", mountPath: "/tls", readOnly: true },
						],
					}],
					volumes: [
						{ name: "source", configMap: { name: state.name } },
						{ name: "tls", secret: { secretName: `${state.name}-tls`, defaultMode: 0o440 } },
					],
				},
			},
		},
	};
}

function service(state, endpoint) {
	const name = `${state.name}-${endpoint}`;
	return {
		apiVersion: "v1",
		kind: "Service",
		metadata: metadata(state, name, endpoint),
		spec: {
			selector: metadata(state, name, endpoint).labels,
			ports: [{ name: "https", port: 8443, targetPort: "https" }],
		},
	};
}

function admin(state, endpoint, path, method = "GET") {
	const code = `const https=require('node:https');const fs=require('node:fs');const request=https.request({host:'127.0.0.1',servername:process.argv[1],port:8443,path:process.argv[2],method:process.argv[3],ca:fs.readFileSync('/tls/ca.crt'),timeout:5000},response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>{if(response.statusCode>=300)process.exitCode=1;else process.stdout.write(body)})});request.on('error',()=>process.exitCode=1);request.end()`;
	return kube("exec", `deployment/${state.name}-${endpoint}`, "--", "node", "-e", code, fqdn(state, endpoint), path, method);
}

target();
if (command === "up") {
	privateDirectory();
	if (readdirSync(stateDirectory).length !== 0)
		throw new Error("probe state directory must be empty; use a fresh directory");
	const image = required("PLATFORM_RELAY_PROBE_IMAGE");
	if (!/^[^\s]+@sha256:[0-9a-f]{64}$/.test(image))
		throw new Error("PLATFORM_RELAY_PROBE_IMAGE must pin an image digest");
	const serverSource = readFileSync(fileURLToPath(new URL("./relay-probe-server.mjs", import.meta.url)), "utf8");
	const syntheticKey = randomBytes(32).toString("base64url");
	const state = { name: `relay-probe-${randomBytes(4).toString("hex")}`, kubeconfig, context, namespace, image, serverSourceSha256: sha256(serverSource), syntheticKeySha256: sha256(syntheticKey) };
	for (const [kind, name] of names(state))
		if (exists(kind, name)) throw new Error(`${kind}/${name} already exists`);
	writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	writeFileSync(join(stateDirectory, "synthetic-key"), syntheticKey, { mode: 0o600, flag: "wx" });
	const tls = makeCertificates(state);
	state.caSha256 = sha256(readFileSync(join(stateDirectory, "ca.crt")));
	writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	apply({ apiVersion: "v1", kind: "ConfigMap", metadata: metadata(state, state.name), data: { "server.mjs": serverSource } });
	apply({ apiVersion: "v1", kind: "Secret", metadata: metadata(state, `${state.name}-tls`), type: "kubernetes.io/tls", data: tls });
	apply({ apiVersion: "v1", kind: "Secret", metadata: metadata(state, `${state.name}-ca`), type: "Opaque", data: { "ca.crt": tls["ca.crt"] } });
	for (const file of ["ca.key", "tls.key", "tls.csr", "tls.ext", "ca.serial"])
		rmSync(join(stateDirectory, file), { force: true });
	for (const endpoint of ["a", "b"]) {
		apply(service(state, endpoint));
		apply(deployment(state, endpoint, image));
		kube("rollout", "status", `deployment/${state.name}-${endpoint}`, "--timeout=180s");
	}
	console.log(JSON.stringify({ name: state.name, context, namespace, approvedA: `https://${fqdn(state, "a")}:8443`, unapprovedB: `https://${fqdn(state, "b")}:8443`, caSecret: `${state.name}-ca`, caFile: join(stateDirectory, "ca.crt"), syntheticKeyFile: join(stateDirectory, "synthetic-key"), serverSourceSha256: state.serverSourceSha256 }, null, 2));
} else {
	const state = readState();
	if (command === "stop") {
		for (const [kind, name] of names(state).reverse()) {
			if (!exists(kind, name)) continue;
			const resource = JSON.parse(kube("get", `${kind}/${name}`, "-o=json"));
			if (resource.metadata?.labels?.["agent-infra.agora.io/probe-id"] !== state.name)
				throw new Error(`${kind}/${name} is not owned by this probe`);
			kube("delete", `${kind}/${name}`, "--wait=true");
		}
		for (const file of ["ca.key", "tls.key", "tls.csr", "tls.ext", "ca.serial", "synthetic-key"])
			rmSync(join(stateDirectory, file), { force: true });
		writeFileSync(join(stateDirectory, "stopped-at.txt"), `${new Date().toISOString()}\n`, { mode: 0o600 });
		console.log("probe resources removed; public CA and receipts retained");
	} else if (command === "status") {
		const deployments = ["a", "b"].map((endpoint) => {
			const resource = JSON.parse(kube("get", `deployment/${state.name}-${endpoint}`, "-o=json"));
			if (resource.metadata?.labels?.["agent-infra.agora.io/probe-id"] !== state.name)
				throw new Error(`deployment/${state.name}-${endpoint} is not owned by this probe`);
			return { endpoint, ready: resource.status?.readyReplicas ?? 0, desired: resource.spec?.replicas ?? 0, image: resource.spec?.template?.spec?.containers?.[0]?.image };
		});
		console.log(JSON.stringify({ name: state.name, context, namespace, deployments }, null, 2));
	} else if (command === "reset") {
		for (const endpoint of ["a", "b"]) admin(state, endpoint, "/__probe/reset", "POST");
		console.log("probe counters reset");
	} else {
		const receipt = {
			capturedAt: new Date().toISOString(),
			name: state.name,
			context,
			namespace,
			image: state.image,
			serverSourceSha256: state.serverSourceSha256,
			caSha256: state.caSha256,
			syntheticKeySha256: state.syntheticKeySha256,
			a: JSON.parse(admin(state, "a", "/__probe/receipt")),
			b: JSON.parse(admin(state, "b", "/__probe/receipt")),
		};
		const file = join(stateDirectory, `receipt-${Date.now()}.json`);
		writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		console.log(file);
	}
}
