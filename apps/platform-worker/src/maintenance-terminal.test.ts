import { describe, expect, it } from "vitest";
import { maintenanceWorkload } from "./maintenance-terminal-workload.js";

describe("creator maintenance without a Conversation", () => {
	it("mounts only the Agent directory and temporary storage in a credential-free Pod", () => {
		const workload = maintenanceWorkload({
			directoryId: "ccff9c1e-b70e-4a8d-8d3b-99cfd28a7422",
			namespace: "agents",
			image: `registry.example.test/maintenance@sha256:${"a".repeat(64)}`,
			storageClass: "agent-nas",
		});
		expect(workload.pod.spec?.automountServiceAccountToken).toBe(false);
		expect(workload.pod.spec?.containers).toHaveLength(1);
		expect(workload.pod.spec?.containers[0]?.workingDir).toBe("/deployment");
		expect(workload.pod.spec?.volumes).toEqual([
			{
				name: "deployment",
				persistentVolumeClaim: { claimName: workload.claim.metadata?.name },
			},
			{ name: "tmp", emptyDir: {} },
		]);
		expect(workload.claim.spec?.accessModes).toEqual(["ReadWriteMany"]);
		expect(workload.policy.spec?.egress).toEqual([]);
		expect(workload.policy.spec?.ingress).toEqual([]);
	});
});
