import { KubeConfig, KubernetesObjectApi } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import {
	createWorkerKubernetesClientV1,
	WorkloadKubernetesError,
	workloadKubernetesFailureV1,
} from "./kubernetes-client.js";

describe("Kubernetes failure details (#2532)", () => {
	it.each([
		[403, "unavailable"],
		[401, "unavailable"],
		[404, "unavailable"],
		[409, "conflict"],
		[500, "unavailable"],
	] as const)(
		"keeps the HTTP status %s, resource kind and verb without the response body",
		(status, code) => {
			// 与 @kubernetes/client-node 的 ApiException 一样：code 是状态码，body 里有资源名和用户名。
			const apiException = Object.assign(new Error(`HTTP-Code: ${status}`), {
				code: status,
				body: 'jobs.batch "agent-secret-name" is forbidden: User "system:serviceaccount:ns:worker"',
			});
			const failure = workloadKubernetesFailureV1(apiException, {
				kind: "Job",
				verb: "get",
			});
			expect(failure).toBeInstanceOf(WorkloadKubernetesError);
			expect(failure.code).toBe(code);
			expect(failure.details).toEqual({ status, kind: "Job", verb: "get" });
			expect(failure.message).toBe("Kubernetes Workload operation failed");
			expect(JSON.stringify(failure.details)).not.toContain(
				"agent-secret-name",
			);
		},
	);

	it("records no status when the call never got an HTTP response", () => {
		const failure = workloadKubernetesFailureV1(
			Object.assign(new Error("connect ECONNREFUSED"), {
				code: "ECONNREFUSED",
			}),
			{ kind: "Deployment", verb: "create" },
		);
		expect(failure.code).toBe("unavailable");
		expect(failure.details).toEqual({ kind: "Deployment", verb: "create" });
	});

	it("classifies a ResourceQuota admission rejection without retaining its body", () => {
		const failure = workloadKubernetesFailureV1(
			Object.assign(new Error("forbidden"), {
				code: 403,
				body: 'persistentvolumeclaims "sandbox" exceeded quota: requested: requests.storage=20Gi, used: 400Gi, limited: 400Gi',
			}),
			{ kind: "PersistentVolumeClaim", verb: "create" },
		);
		expect(failure.details).toEqual({
			status: 403,
			quota: true,
			kind: "PersistentVolumeClaim",
			verb: "create",
		});
		expect(JSON.stringify(failure.details)).not.toContain("400Gi");
	});

	it("passes through an error that is already bounded", () => {
		const policy = new WorkloadKubernetesError("policy");
		expect(
			workloadKubernetesFailureV1(policy, { kind: "Pod", verb: "update" }),
		).toBe(policy);
		expect(policy.details).toEqual({});
	});
});

it("reads ReplicaSet ownership in its namespace and rejects every mutation before the API call", async () => {
	const config = new KubeConfig();
	config.loadFromOptions({
		clusters: [{ name: "test", server: "https://127.0.0.1:6443" }],
		users: [{ name: "test" }],
		contexts: [{ name: "test", cluster: "test", user: "test" }],
		currentContext: "test",
	});
	const replicaSet = {
		apiVersion: "apps/v1",
		kind: "ReplicaSet",
		metadata: {
			namespace: "test",
			name: "member-abc",
			uid: "uid",
			resourceVersion: "1",
		},
	};
	const read = vi
		.spyOn(KubernetesObjectApi.prototype, "read")
		.mockResolvedValue(replicaSet);
	try {
		const client = createWorkerKubernetesClientV1("test", config);
		expect(await client.read("ReplicaSet", "member-abc")).toEqual(replicaSet);
		expect(read).toHaveBeenCalledWith({
			apiVersion: "apps/v1",
			kind: "ReplicaSet",
			metadata: { namespace: "test", name: "member-abc" },
		});
		await expect(client.create(replicaSet)).rejects.toMatchObject({
			code: "policy",
		});
		await expect(client.replace(replicaSet)).rejects.toMatchObject({
			code: "policy",
		});
		await expect(client.delete(replicaSet)).rejects.toMatchObject({
			code: "policy",
		});
	} finally {
		read.mockRestore();
	}
});

it("permits Certificate reads and creation but never updates or deletes it", async () => {
	const config = new KubeConfig();
	config.loadFromOptions({
		clusters: [{ name: "test", server: "https://127.0.0.1:6443" }],
		users: [{ name: "test" }],
		contexts: [{ name: "test", cluster: "test", user: "test" }],
		currentContext: "test",
	});
	const certificate = {
		apiVersion: "cert-manager.io/v1",
		kind: "Certificate",
		metadata: {
			namespace: "test",
			name: "agent-certificate",
			uid: "certificate-uid",
			resourceVersion: "1",
		},
	};
	const read = vi
		.spyOn(KubernetesObjectApi.prototype, "read")
		.mockResolvedValue(certificate);
	const create = vi
		.spyOn(KubernetesObjectApi.prototype, "create")
		.mockResolvedValue(certificate);
	const replace = vi
		.spyOn(KubernetesObjectApi.prototype, "replace")
		.mockResolvedValue(certificate);
	const remove = vi
		.spyOn(KubernetesObjectApi.prototype, "delete")
		.mockResolvedValue({});
	try {
		const client = createWorkerKubernetesClientV1("test", config);
		expect(await client.read("Certificate", "agent-certificate")).toEqual(
			certificate,
		);
		expect(await client.create(certificate)).toEqual(certificate);
		await expect(client.replace(certificate)).rejects.toMatchObject({
			code: "policy",
		});
		await expect(client.delete(certificate)).rejects.toMatchObject({
			code: "policy",
		});
		await expect(client.deleteResult?.(certificate)).rejects.toMatchObject({
			code: "policy",
		});
		expect(create).toHaveBeenCalledOnce();
		expect(replace).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
	} finally {
		read.mockRestore();
		create.mockRestore();
		replace.mockRestore();
		remove.mockRestore();
	}
});

it("fetches Secret metadata with strict content negotiation and no full-object fallback", async () => {
	const { createServer } = await import("node:https");
	const { runtimeTlsFixture } = await import(
		"../../../tests/runtime-tls-fixture.js"
	);
	const tls = await runtimeTlsFixture();
	const requests: Array<{ url: string; accept?: string }> = [];
	let returnFullSecret = false;
	let returnReserveFacts = false;
	const server = createServer(
		{ key: tls.key, cert: tls.cert },
		(request, response) => {
			requests.push({ url: request.url ?? "", accept: request.headers.accept });
			response.setHeader("Content-Type", "application/json");
			response.setHeader("Connection", "close");
			if (request.url === "/api/v1") {
				response.end(
					JSON.stringify({
						apiVersion: "v1",
						kind: "APIResourceList",
						groupVersion: "v1",
						resources: [
							{
								name: "secrets",
								singularName: "secret",
								namespaced: true,
								kind: "Secret",
								verbs: ["get"],
							},
						],
					}),
				);
			} else if (request.url === "/api/v1/namespaces/test/secrets/agent-tls") {
				response.end(
					JSON.stringify({
						apiVersion: returnFullSecret ? "v1" : "meta.k8s.io/v1",
						kind: returnFullSecret ? "Secret" : "PartialObjectMetadata",
						metadata: {
							name: "agent-tls",
							namespace: "test",
							uid: "secret-uid",
							resourceVersion: "7",
							...(returnReserveFacts
								? {
										labels: {
											"agent-infra.agora.io/sandbox-id": "reserve-sandbox",
											"unrelated-label": "not-returned",
										},
									}
								: {}),
							annotations: {
								...(returnReserveFacts
									? {
											"agent-infra.agora.io/agent-id": "reserve-agent",
											"agent-infra.agora.io/executor-host-key-id":
												"public-key-id",
											"agent-infra.agora.io/executor-instance-digest":
												"d".repeat(64),
										}
									: {}),
								"kubectl.kubernetes.io/last-applied-configuration":
									"not-returned",
							},
						},
						...(returnFullSecret
							? { data: { value: "synthetic-not-returned" } }
							: {}),
					}),
				);
			} else {
				response.statusCode = 404;
				response.end(
					JSON.stringify({ kind: "Status", apiVersion: "v1", code: 404 }),
				);
			}
		},
	);
	await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Expected local fixture address");
		const config = new KubeConfig();
		config.loadFromOptions({
			clusters: [
				{
					name: "test",
					server: `https://localhost:${address.port}`,
					caData: Buffer.from(tls.ca).toString("base64"),
				},
			],
			users: [{ name: "test" }],
			contexts: [{ name: "test", cluster: "test", user: "test" }],
			currentContext: "test",
		});
		const client = createWorkerKubernetesClientV1("test", config);
		expect(client.readMetadata).toBeTypeOf("function");
		const metadata = await client.readMetadata?.("Secret", "agent-tls");
		expect(metadata).toMatchObject({
			metadata: {
				name: "agent-tls",
				namespace: "test",
				uid: "secret-uid",
				resourceVersion: "7",
			},
		});
		expect(metadata).not.toHaveProperty("data");
		expect(metadata?.metadata).not.toHaveProperty("annotations");
		returnReserveFacts = true;
		const reserve = await client.readMetadata?.("Secret", "agent-tls");
		expect(reserve?.metadata).toMatchObject({
			labels: { "agent-infra.agora.io/sandbox-id": "reserve-sandbox" },
			annotations: {
				"agent-infra.agora.io/agent-id": "reserve-agent",
				"agent-infra.agora.io/executor-host-key-id": "public-key-id",
				"agent-infra.agora.io/executor-instance-digest": "d".repeat(64),
			},
		});
		expect(reserve?.metadata?.labels).not.toHaveProperty("unrelated-label");
		expect(reserve?.metadata?.annotations).not.toHaveProperty(
			"kubectl.kubernetes.io/last-applied-configuration",
		);
		returnReserveFacts = false;
		expect(
			requests.find((request) => request.url.includes("/secrets/"))?.accept,
		).toBe("application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1");
		expect(
			requests.every(
				(request) =>
					request.url === "/api/v1/namespaces/test/secrets/agent-tls",
			),
		).toBe(true);
		returnFullSecret = true;
		await expect(
			client.readMetadata?.("Secret", "agent-tls"),
		).rejects.toMatchObject({ code: "policy" });
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		await tls.cleanup();
	}
});
