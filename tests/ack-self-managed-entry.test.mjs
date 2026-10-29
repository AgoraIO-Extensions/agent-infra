import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	privateJson,
	provisionWithBindings,
} from "../deploy/ack/agent-bindings.ts";
import {
	assertOwnEntryUnchanged,
	validateOwnEntry,
	verifyOwnEntryWorkloads,
} from "../deploy/ack/self-managed-entry.ts";

function fixture() {
	const agentId = "current-private-agent";
	const prefix = `agent-${createHash("sha256").update(agentId).digest("hex").slice(0, 32)}`;
	const image = `sha256:${"a".repeat(64)}`;
	const origin = `https://${prefix}.apps.example.test`;
	const inventory = {
		Deployment: [],
		StatefulSet: [],
		ReplicaSet: [],
		Service: [],
		Pod: [],
		EndpointSlice: [],
		Ingress: [],
	};
	const resources = [];
	const metadata = (name, kind) => ({
		name,
		uid: `${kind}-${name}`,
		resourceVersion: "1",
		generation: 1,
		labels: {
			"agent-infra.agora.io/agent": prefix,
			"agent-infra.agora.io/revision": "1",
		},
		annotations: { "agent-infra.agora.io/agent-id": agentId },
	});
	for (const name of ["web", "api"]) {
		resources.push({
			kind: "Deployment",
			metadata: { name },
			spec: {
				template: {
					metadata: { labels: { app: name } },
					spec: { containers: [{ image }] },
				},
			},
		});
		resources.push({
			kind: "Service",
			metadata: {
				name,
				annotations:
					name === "web" ? { "agent-infra.agora.io/entry": "true" } : {},
			},
			spec: {
				selector: { app: name },
				ports: [{ port: 3003, targetPort: 3003 }],
			},
		});
		const fullname = `${prefix}-${name}`;
		const labels = { app: name, "agent-infra.agora.io/agent": prefix };
		inventory.Deployment.push({
			kind: "Deployment",
			metadata: metadata(fullname, "deployment"),
			spec: {
				replicas: 1,
				template: {
					spec: {
						containers: [{ image: `registry.example.test/app@${image}` }],
					},
				},
			},
			status: { observedGeneration: 1, readyReplicas: 1 },
		});
		const service = {
			kind: "Service",
			metadata: metadata(fullname, "service"),
			spec: {
				type: "ClusterIP",
				selector: labels,
				ports: [{ port: 3003, targetPort: 3003 }],
			},
		};
		inventory.Service.push(service);
		const pod = {
			kind: "Pod",
			metadata: {
				...metadata(`${fullname}-pod`, "pod"),
				labels,
				ownerReferences: [
					{
						kind: "ReplicaSet",
						controller: true,
						uid: `replicaset-${fullname}`,
					},
				],
			},
			spec: { containers: [{ image: `registry.example.test/app@${image}` }] },
			status: {
				phase: "Running",
				podIP: name === "web" ? "10.0.0.1" : "10.0.0.2",
				containerStatuses: [
					{ ready: true, imageID: `registry.example.test/app@${image}` },
				],
			},
		};
		inventory.Pod.push(pod);
		inventory.ReplicaSet.push({
			kind: "ReplicaSet",
			metadata: {
				...metadata(fullname, "replicaset"),
				ownerReferences: [
					{
						kind: "Deployment",
						controller: true,
						uid: `deployment-${fullname}`,
					},
				],
			},
		});
		inventory.EndpointSlice.push({
			kind: "EndpointSlice",
			metadata: {
				...metadata(fullname, "endpoint"),
				labels: { "kubernetes.io/service-name": fullname },
				ownerReferences: [{ uid: service.metadata.uid }],
			},
			ports: [{ port: 3003 }],
			endpoints: [
				{
					conditions: { ready: true },
					targetRef: { uid: pod.metadata.uid },
					addresses: [pod.status.podIP],
				},
			],
		});
	}
	inventory.Ingress.push({
		kind: "Ingress",
		metadata: metadata(prefix, "ingress"),
		spec: {
			tls: [{ hosts: [new URL(origin).hostname] }],
			rules: [
				{
					host: new URL(origin).hostname,
					http: {
						paths: [
							{ path: "/", backend: { service: { name: `${prefix}-web` } } },
						],
					},
				},
			],
		},
	});
	const source = {
		kind: "custom",
		interactionMode: "self-managed",
		identityResponsibility: "self-managed",
		manifest: JSON.stringify({ resources }),
	};
	return {
		inventory,
		agentId,
		source,
		origin,
		run: () =>
			verifyOwnEntryWorkloads(
				agentId,
				source,
				origin,
				(kind) => inventory[kind],
			),
	};
}

test("own-entry evidence binds all services, endpoint Pod identities and exact imageIDs", () => {
	const f = fixture();
	const result = f.run();
	assert.equal(result.serviceCount, 2);
	assert.equal(result.resources.length, 11);
	assert.equal(JSON.stringify(result).includes(f.agentId), false);
	assert.equal(result.configurationRevision, "workload-1");
});

for (const scenario of [
	"missing-service",
	"unrelated-agent",
	"wrong-image",
	"not-ready",
	"wrong-endpoint",
	"additional-ready-endpoint",
	"wrong-ingress",
	"revision-drift",
]) {
	test(`own-entry evidence rejects ${scenario} even when another workload uses the expected digest`, () => {
		const f = fixture();
		if (scenario === "missing-service") f.inventory.Service.pop();
		if (scenario === "unrelated-agent")
			f.inventory.Deployment[0].metadata.annotations[
				"agent-infra.agora.io/agent-id"
			] = "other-agent";
		if (scenario === "wrong-image")
			f.inventory.Pod[0].status.containerStatuses[0].imageID = `registry.example.test/app@sha256:${"b".repeat(64)}`;
		if (scenario === "not-ready")
			f.inventory.Deployment[1].status.readyReplicas = 0;
		if (scenario === "wrong-endpoint")
			f.inventory.EndpointSlice[0].endpoints[0].targetRef.uid = "unrelated-pod";
		if (scenario === "additional-ready-endpoint")
			f.inventory.EndpointSlice[0].endpoints.push({
				conditions: { ready: true },
				targetRef: { uid: "unrelated-pod" },
				addresses: ["10.1.1.99"],
			});
		if (scenario === "wrong-ingress")
			f.inventory.Ingress[0].spec.rules[0].http.paths[0].backend.service.name =
				"unrelated-service";
		if (scenario === "revision-drift")
			f.inventory.Service[0].metadata.labels["agent-infra.agora.io/revision"] =
				"2";
		assert.throws(f.run);
	});
}

test("an in-place configuration revision change invalidates the completed browser journey", () => {
	const f = fixture();
	const before = f.run();
	for (const kind of ["Deployment", "Service", "Ingress"])
		for (const resource of f.inventory[kind])
			resource.metadata.labels["agent-infra.agora.io/revision"] = "2";
	const after = f.run();
	assert.equal(after.resourceIdentityHash, before.resourceIdentityHash);
	assert.throws(
		() => assertOwnEntryUnchanged(before, after),
		/OWN_ENTRY_CONFIGURATION_REVISION_CHANGED/u,
	);
});

async function entryFixture(t) {
	const f = fixture();
	const sourceSha = "c".repeat(40);
	const directory = await mkdtemp(join(tmpdir(), "entry-boundary-receipt-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const state = join(directory, "state");
	const evidence = join(directory, "evidence");
	await mkdir(state, { mode: 0o700 });
	await mkdir(evidence);
	const write = async (name, value) => {
		const file = join(directory, name);
		await writeFile(
			file,
			typeof value === "string" ? value : JSON.stringify(value),
			{ mode: 0o600 },
		);
		return file;
	};
	const credential = "SYNTHETIC_API_SECRET";
	const body = { source: f.source };
	const request = {
		name: "own-multi",
		bodyFile: await write("body.json", body),
		credentialFile: await write("credential", credential),
		idempotencyKey: "synthetic-idempotency",
	};
	const requests = {
		schemaVersion: 1,
		waitSeconds: 0,
		origin: "https://platform.example.test",
		requests: [request],
	};
	const requestsFile = await write("requests.json", requests);
	t.mock.method(globalThis, "fetch", async (_url, init) =>
		Response.json(
			{
				schemaVersion: 1,
				agentId: f.agentId,
				status: "available",
				serviceAvailability: "ready",
			},
			{ status: init.method === "POST" ? 201 : 200 },
		),
	);
	assert.equal(
		(await provisionWithBindings(requestsFile, state, directory, sourceSha))
			.pass,
		true,
	);
	t.mock.restoreAll();
	const { privateKey } = generateKeyPairSync("ed25519");
	const config = {
		schemaVersion: 1,
		sourceSha,
		imageSourceSha: sourceSha,
		contentSha256: "d".repeat(64),
		requestName: "own-multi",
		routeHostSuffix: "apps.example.test",
		issuer: "fixture",
		audience: "fixture",
		expectedReply: "fixture",
		signingKeyFile: await write(
			"key",
			privateKey.export({ type: "pkcs8", format: "pem" }),
		),
		browserCertificateFile: join(directory, "unused-cert"),
	};
	const configFile = await write("config.json", config);
	return {
		...f,
		sourceSha,
		state,
		evidence,
		write,
		credential,
		requests,
		run: () =>
			validateOwnEntry(
				configFile,
				requestsFile,
				state,
				evidence,
				sourceSha,
				(kind) => f.inventory[kind],
			),
	};
}

for (const drift of [
	"schema-missing",
	"schema-unknown",
	"source",
	"origin",
	"body",
	"name",
	"idempotency",
	"missing-entry",
	"not-ready",
]) {
	test(`writer binding rejects ${drift} before own-entry networking`, async (t) => {
		const f = await entryFixture(t);
		const binding = await privateJson(join(f.state, "agent-bindings.json"));
		if (drift === "schema-missing") delete binding.schemaVersion;
		if (drift === "schema-unknown") binding.schemaVersion = 2;
		if (drift === "source") binding.sourceSha = "f".repeat(40);
		if (drift === "origin") binding.origin = "https://other.example.test";
		if (drift === "body")
			await f.write("body.json", { source: f.source, name: "changed" });
		if (drift === "name") f.requests.requests[0].name = "changed";
		if (drift === "idempotency")
			f.requests.requests[0].idempotencyKey = "changed-key";
		if (drift === "missing-entry") delete binding.agents["own-multi"];
		if (drift === "not-ready") binding.agents["own-multi"].ready = false;
		await f.write("requests.json", f.requests);
		await f.write("state/agent-bindings.json", binding);
		let calls = 0;
		t.mock.method(globalThis, "fetch", async () => {
			calls++;
			throw new Error("network must not run");
		});
		await assert.rejects(f.run());
		assert.equal(calls, 0);
	});
}

test("a failed own-entry HTTP boundary is retained privately before rejecting the browser journey", async (t) => {
	const f = await entryFixture(t);
	const { sourceSha, evidence, credential } = f;
	let requestsObserved = 0;
	t.mock.method(globalThis, "fetch", async (url) => {
		requestsObserved++;
		return String(url).includes("/api/v2/agents/")
			? Response.json({
					agentId: f.agentId,
					managementStatus: "available",
					serviceAvailability: "ready",
					source: f.source,
					interactionUrl: f.origin,
				})
			: new Response("", { status: 503 });
	});
	await assert.rejects(f.run(), /OWN_ENTRY_BOUNDARY_FAILED/u);
	assert.equal(requestsObserved, 6);
	const [entry] = await readdir(evidence);
	const file = join(evidence, entry, "boundary.json");
	const receipt = JSON.parse(await readFile(file, "utf8"));
	assert.equal(receipt.sourceSha, sourceSha);
	assert.equal(
		receipt.agentHash,
		createHash("sha256").update(f.agentId).digest("hex"),
	);
	assert.equal(receipt.boundary.pass, false);
	assert.equal(receipt.boundary.results.length, 5);
	assert(
		receipt.boundary.results.every(
			(result) =>
				result.error === "HTTP_STATUS_UNEXPECTED" && result.attempts === 1,
		),
	);
	assert.equal((await stat(file)).mode & 0o077, 0);
	for (const secret of [credential, f.agentId, f.origin, "PRIVATE KEY"])
		assert.equal(JSON.stringify(receipt).includes(secret), false);
});
