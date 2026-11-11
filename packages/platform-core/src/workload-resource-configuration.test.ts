import { describe, expect, it } from "vitest";
import {
	type CodexSessionExecutorResourcePolicyV1,
	resourceQuantityEqualsV1,
	sessionSandboxResourceCostsV1,
	validateCodexSessionExecutorResourcePolicyV1,
	validateWorkloadControlResourcesV1,
	workloadControlResourcesEqualV1,
	workloadResourceConfigurationHashV1,
	workloadResourcesEqualV1,
} from "./workload-resource-configuration.js";

const legacy = {
	resourceProfileRef: "ack-small",
	resources: {
		requests: { cpu: "100m", memory: "128Mi" },
		limits: { cpu: "1", memory: "2Gi" },
	},
};
const executor: CodexSessionExecutorResourcePolicyV1 = {
	resources: {
		requests: { cpu: "250m", memory: "256Mi" },
		limits: { cpu: "1", memory: "512Mi" },
	},
	placement: { architecture: "amd64" },
};

describe("shared workload resource contract", () => {
	it("compares the full control envelope without changing portable hashes or executor resources", () => {
		const declared = {
			requests: { ...legacy.resources.requests, "ephemeral-storage": "256Mi" },
			limits: { ...legacy.resources.limits, "ephemeral-storage": "1Gi" },
		};
		const actual = {
			requests: {
				cpu: "0.1",
				memory: "0.125Gi",
				"ephemeral-storage": "0.25Gi",
			},
			limits: { cpu: "1000m", memory: "2048Mi", "ephemeral-storage": "1024Mi" },
		};
		expect(() => validateWorkloadControlResourcesV1(declared)).not.toThrow();
		expect(workloadControlResourcesEqualV1(actual, declared)).toBe(true);
		expect(workloadResourcesEqualV1(actual, declared)).toBe(false);
		expect(() =>
			validateCodexSessionExecutorResourcePolicyV1({ resources: declared }),
		).toThrow();
		expect(
			workloadResourceConfigurationHashV1({ ...legacy, resources: declared }),
		).toBe(workloadResourceConfigurationHashV1(legacy));
		for (const limits of [
			legacy.resources.limits,
			{ ...declared.limits, "ephemeral-storage": "1025Mi" },
			{ ...declared.limits, gpu: "1" },
			{ ...declared.limits, "ephemeral-storage": "invalid" },
			{ ...declared.limits, "ephemeral-storage": "0" },
			{ ...declared.limits, "ephemeral-storage": "128Mi" },
		])
			expect(
				workloadControlResourcesEqualV1({ ...actual, limits }, declared),
			).toBe(false);
		expect(workloadControlResourcesEqualV1(undefined, declared)).toBe(false);
		expect(
			workloadControlResourcesEqualV1({ ...actual, extra: {} }, declared),
		).toBe(false);
	});

	it("accepts Kubernetes quantity canonicalization while retaining exact resource keys", () => {
		const declared = {
			requests: { cpu: "0.25", memory: "0.25Gi" },
			limits: { cpu: "1000m", memory: "0.5Gi" },
		};
		const actual = {
			requests: { cpu: "250m", memory: "256Mi" },
			limits: { cpu: "1", memory: "512Mi" },
		};
		expect(workloadResourcesEqualV1(actual, declared)).toBe(true);
		expect(
			workloadResourcesEqualV1(
				{ ...actual, limits: { ...actual.limits, memory: "513Mi" } },
				declared,
			),
		).toBe(false);
		expect(
			workloadResourcesEqualV1(
				{ ...actual, limits: { ...actual.limits, "ephemeral-storage": "1Gi" } },
				declared,
			),
		).toBe(false);
		expect(workloadResourcesEqualV1({ ...actual, extra: true }, declared)).toBe(
			false,
		);
		expect(resourceQuantityEqualsV1("128Mi", "0.125Gi")).toBe(true);
		expect(resourceQuantityEqualsV1("0", "0")).toBe(false);
		expect(resourceQuantityEqualsV1(undefined, undefined)).toBe(false);
	});

	it("retains the persisted legacy and executor Worker resource hashes", () => {
		expect(workloadResourceConfigurationHashV1(legacy)).toBe(
			"3b87ccddc22230b5a9a245e1a6f205e9683e34f78c9abce3229597289fb70723",
		);
		expect(
			workloadResourceConfigurationHashV1({
				...legacy,
				codexSessionExecutor: executor,
			}),
		).toBe("c8af8c238bfc24e2223cd75df67f6d4ed361910f92d3d40060c9fbb1b9c97742");
	});

	it("normalizes optional defaults without invalidating an approved tuple", () => {
		expect(
			workloadResourceConfigurationHashV1({
				...legacy,
				codexSessionExecutor: executor,
			}),
		).toBe(
			workloadResourceConfigurationHashV1({
				...legacy,
				codexSessionExecutor: {
					...executor,
					tmpSizeLimit: "128Mi",
					placement: { architecture: "amd64", runtimeClassName: "" },
				},
			}),
		);
	});

	it.each([
		{ ...executor, tmpSizeLimit: "64Mi" },
		{ ...executor, placement: { architecture: "arm64" as const } },
		{
			...executor,
			placement: { architecture: "amd64" as const, runtimeClassName: "runv" },
		},
		{
			...executor,
			resources: {
				...executor.resources,
				limits: { cpu: "2", memory: "512Mi" },
			},
		},
	])(
		"changes approval identity when executor resources or placement change",
		(changed) => {
			expect(
				workloadResourceConfigurationHashV1({
					...legacy,
					codexSessionExecutor: changed,
				}),
			).not.toBe(
				workloadResourceConfigurationHashV1({
					...legacy,
					codexSessionExecutor: executor,
				}),
			);
		},
	);

	it("retains snapshot egress as a separate resource approval dimension", () => {
		expect(
			workloadResourceConfigurationHashV1({
				...legacy,
				workspaceSnapshotEgress: [],
			}),
		).not.toBe(workloadResourceConfigurationHashV1(legacy));
	});

	it("charges concurrent containers once and preserves single-container accounting", () => {
		expect(
			sessionSandboxResourceCostsV1({ ...legacy, storageSize: "20Gi" }),
		).toEqual({
			cpuMillis: 1000,
			memoryBytes: 2147483648,
			storageBytes: 21474836480,
		});
		expect(
			sessionSandboxResourceCostsV1({
				...legacy,
				storageSize: "20Gi",
				codexSessionExecutor: executor,
			}),
		).toEqual({
			cpuMillis: 2000,
			memoryBytes: 2684354560,
			storageBytes: 21474836480,
		});
	});

	it("rounds combined fractional quantities upward without floating point loss", () => {
		expect(
			sessionSandboxResourceCostsV1({
				resources: {
					requests: { cpu: "1n", memory: "1" },
					limits: { cpu: "0.000000001", memory: "1" },
				},
				storageSize: "1",
			}).cpuMillis,
		).toBe(1);
	});

	it.each([
		{ ...executor, resources: { ...executor.resources, extra: {} } },
		{
			...executor,
			resources: {
				...executor.resources,
				requests: { cpu: "2", memory: "256Mi" },
			},
		},
		{ ...executor, tmpSizeLimit: "0" },
		{ ...executor, placement: { architecture: "amd64", extra: true } },
		{ ...executor, placement: Object.create({ architecture: "amd64" }) },
	])(
		"rejects malformed or unapproved executor policy before hashing",
		(policy) => {
			expect(() =>
				validateCodexSessionExecutorResourcePolicyV1(
					policy as CodexSessionExecutorResourcePolicyV1,
				),
			).toThrow();
		},
	);

	it("rejects resource accounting overflow", () => {
		expect(() =>
			sessionSandboxResourceCostsV1({ ...legacy, storageSize: "100Ei" }),
		).toThrow();
	});
});
