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
