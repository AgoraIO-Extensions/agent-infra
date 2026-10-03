import { describe, expect, it } from "vitest";
import { z } from "zod";

import { kubernetesWorkloadSchemasV1 } from "../../src/workload/index.ts";

describe("Kubernetes Workload V1 JSON Schema family", () => {
	it("keeps every boundary message representable as JSON Schema 2020-12", () => {
		const definitions = Object.fromEntries(
			Object.entries(kubernetesWorkloadSchemasV1).map(([name, schema]) => [
				name,
				z.toJSONSchema(schema, {
					io: "input",
					target: "draft-2020-12",
					unrepresentable: "throw",
				}),
			]),
		);

		expect(Object.keys(definitions)).toEqual(
			Object.keys(definitions).toSorted(),
		);
		expect(definitions).toHaveProperty("AgentWorkloadDesiredV1");
		expect(definitions).toHaveProperty("KubernetesReconcileResultV1");
		expect(definitions).toHaveProperty("WorkloadRouteSwitchResultV1");
		expect(definitions).toHaveProperty("WorkloadCleanupResultV1");
		expect(JSON.stringify(definitions)).not.toMatch(
			/v1beta1|cloudProvider|providerOperation|credential|privateKey|plaintext/,
		);
	});
});
