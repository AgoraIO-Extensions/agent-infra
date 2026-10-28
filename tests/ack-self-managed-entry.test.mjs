import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	assertOwnEntryUnchanged,
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
