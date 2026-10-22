import { describe, expect, it } from "vitest";
import {
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
