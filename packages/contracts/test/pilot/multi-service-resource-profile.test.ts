import { describe, expect, it } from "vitest";
import { MultiServiceResourceProfileV1Schema } from "../../src/pilot/multi-service.js";

const profile = {
	profileId: "small",
	displayName: "Small",
	estimatedResources: {
		cpuMillicores: 100,
		memoryMiB: 128,
		storageGiB: 1,
	},
	resources: {
		requests: { cpu: "100m", memory: "128Mi" },
		limits: { cpu: "500m", memory: "512Mi" },
	},
} as const;

describe("multi-service resource profiles", () => {
	it("accepts Kubernetes CPU and memory quantities in their matching fields", () => {
		expect(MultiServiceResourceProfileV1Schema.safeParse(profile).success).toBe(
			true,
		);
	});

	it("rejects CPU and memory quantities with swapped units", () => {
		expect(
			MultiServiceResourceProfileV1Schema.safeParse({
				...profile,
				resources: {
					requests: { cpu: "1Gi", memory: "1m" },
					limits: { cpu: "1Gi", memory: "1m" },
				},
			}).success,
		).toBe(false);
	});
});
