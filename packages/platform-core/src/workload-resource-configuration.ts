import { createHash } from "node:crypto";

export interface CodexSessionExecutorResourcePolicyV1 {
	readonly resources: WorkloadControlResourcesV1;
	readonly tmpSizeLimit?: string;
	readonly placement?: {
		readonly architecture: "amd64" | "arm64";
		readonly runtimeClassName?: string;
	};
}

/** Deployment-owned load evidence, private to reconciliation and Dispatch. */
export interface WorkloadExecutionCapacityV1 {
	readonly schemaVersion: 1;
	readonly imageDigest: string;
	readonly resourceProfileRef: string;
	readonly resourceConfigurationHash: string;
	readonly maximumConcurrentExecutions: number;
	readonly conformanceEvidenceHash: string;
}

export function parseWorkloadExecutionCapacityV1(
	input: unknown,
): WorkloadExecutionCapacityV1 {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new TypeError("Workload execution capacity is invalid");
	const value = input as Record<string, unknown>;
	const keys = [
		"schemaVersion",
		"imageDigest",
		"resourceProfileRef",
		"resourceConfigurationHash",
		"maximumConcurrentExecutions",
		"conformanceEvidenceHash",
	];
	if (
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key)) ||
		value.schemaVersion !== 1 ||
		typeof value.imageDigest !== "string" ||
		!/^sha256:[a-f0-9]{64}$/.test(value.imageDigest) ||
		typeof value.resourceProfileRef !== "string" ||
		!/^[\x21-\x7e]{1,256}$/.test(value.resourceProfileRef) ||
		typeof value.resourceConfigurationHash !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.resourceConfigurationHash) ||
		typeof value.conformanceEvidenceHash !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.conformanceEvidenceHash) ||
		typeof value.maximumConcurrentExecutions !== "number" ||
		!Number.isSafeInteger(value.maximumConcurrentExecutions) ||
		value.maximumConcurrentExecutions < 1
	)
		throw new TypeError("Workload execution capacity is invalid");
	return {
		schemaVersion: 1,
		imageDigest: value.imageDigest,
		resourceProfileRef: value.resourceProfileRef,
		resourceConfigurationHash: value.resourceConfigurationHash,
		maximumConcurrentExecutions: value.maximumConcurrentExecutions,
		conformanceEvidenceHash: value.conformanceEvidenceHash,
	};
}

export interface WorkloadResourceConfigurationV1 {
	readonly resourceProfileRef: string;
	readonly sessionRuntimePlacement?: {
		readonly architecture: "amd64";
		readonly compute: "acs";
	};
	readonly resources: CodexSessionExecutorResourcePolicyV1["resources"];
	readonly codexSessionExecutor?: CodexSessionExecutorResourcePolicyV1;
	readonly workspaceSnapshotEgress?: unknown;
}

/** Provider annotations must identify one instance of the requested compute type. */
export function observedComputeInstanceIdV1(
	compute: "eci" | "acs",
	annotations: Readonly<Record<string, string>> | undefined,
): string | undefined {
	const instance = annotations?.["alibabacloud.com/instance-id"];
	const eci = annotations?.["k8s.aliyun.com/eci-instance-id"];
	if (compute === "acs")
		return instance &&
			/^acs-[a-z0-9]{1,64}$/.test(instance) &&
			eci === undefined
			? instance
			: undefined;
	return eci &&
		/^eci-[a-z0-9]{1,64}$/.test(eci) &&
		(instance === undefined || instance === eci)
		? eci
		: undefined;
}

/** Only the deployment supplies ACS compute and NetworkPolicy activation fields. */
export function acsPodMetadataV1(compute: "eci" | "acs" | undefined): {
	labels: Record<string, string>;
	annotations: Record<string, string>;
} {
	return compute === "acs"
		? {
				labels: {
					"alibabacloud.com/acs": "true",
					"alibabacloud.com/compute-class": "general-purpose",
					"alibabacloud.com/compute-qos": "default",
				},
				annotations: {
					"network.alibabacloud.com/enable-network-policy-agent": "true",
				},
			}
		: { labels: {}, annotations: {} };
}

export function validateSessionRuntimePlacementV1(
	value: unknown,
): asserts value is WorkloadResourceConfigurationV1["sessionRuntimePlacement"] {
	if (value === undefined) return;
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join(",") !== "architecture,compute" ||
		(value as Record<string, unknown>).architecture !== "amd64" ||
		(value as Record<string, unknown>).compute !== "acs"
	)
		throw new TypeError("SESSION_RUNTIME_PLACEMENT_INVALID");
}

/** ACS defaults an omitted ephemeral-storage request to 30Gi; other additions remain drift. */
export function withoutAcsStorageDefaultV1<
	T extends { requests?: Record<string, string> },
>(resources: T | undefined, expected?: T): T | undefined {
	if (
		expected?.requests?.["ephemeral-storage"] !== undefined ||
		resources?.requests?.["ephemeral-storage"] !== "30Gi"
	)
		return resources;
	const requests = { ...resources.requests };
	delete requests["ephemeral-storage"];
	return { ...resources, requests };
}

export interface WorkloadControlResourcesV1 {
	readonly requests: {
		readonly cpu: string;
		readonly memory: string;
		readonly "ephemeral-storage"?: string;
	};
	readonly limits: WorkloadControlResourcesV1["requests"];
}

/** Compare Kubernetes quantities without floating point rounding. */
export function quantityRatioV1(
	value: string,
): readonly [bigint, bigint] | undefined {
	if (typeof value !== "string" || value.length > 128) return undefined;
	const match =
		/^([+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))(n|u|m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei|[eE][+-]?[0-9]+)?$/.exec(
			value,
		);
	if (!match?.[1]) return undefined;
	const [integer, fraction = ""] = match[1].replace(/^\+/, "").split(".");
	let numerator = BigInt(`${integer || "0"}${fraction}`);
	let denominator = 10n ** BigInt(fraction.length);
	const suffix = match[2] ?? "";
	if (suffix.endsWith("i")) {
		numerator *=
			1024n ** BigInt(["Ki", "Mi", "Gi", "Ti", "Pi", "Ei"].indexOf(suffix) + 1);
	} else {
		const powers: Readonly<Record<string, number>> = {
			"": 0,
			n: -9,
			u: -6,
			m: -3,
			k: 3,
			M: 6,
			G: 9,
			T: 12,
			P: 15,
			E: 18,
		};
		const exponent = powers[suffix] ?? Number(suffix.slice(1));
		if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 30)
			return undefined;
		if (exponent < 0) denominator *= 10n ** BigInt(-exponent);
		else numerator *= 10n ** BigInt(exponent);
	}
	return [numerator, denominator];
}

export function resourceQuantityEqualsV1(
	actual: unknown,
	expected: unknown,
): boolean {
	if (typeof actual !== "string" || typeof expected !== "string") return false;
	const a = quantityRatioV1(actual);
	const b = quantityRatioV1(expected);
	return !!a && !!b && a[0] > 0n && b[0] > 0n && a[0] * b[1] === b[0] * a[1];
}

/** API canonicalization may change quantity spelling, never the approved resource keys. */
export function workloadResourcesEqualV1(
	actual: unknown,
	expected: unknown,
): boolean {
	const a = actual as
		| CodexSessionExecutorResourcePolicyV1["resources"]
		| undefined;
	const b = expected as
		| CodexSessionExecutorResourcePolicyV1["resources"]
		| undefined;
	if (
		!a ||
		!b ||
		Object.keys(a).sort().join(",") !== "limits,requests" ||
		Object.keys(b).sort().join(",") !== "limits,requests"
	)
		return false;
	return (["requests", "limits"] as const).every((level) => {
		const left = a[level];
		const right = b[level];
		return (
			!!left &&
			!!right &&
			Object.keys(left).sort().join(",") === "cpu,memory" &&
			Object.keys(right).sort().join(",") === "cpu,memory" &&
			resourceQuantityEqualsV1(left.cpu, right.cpu) &&
			resourceQuantityEqualsV1(left.memory, right.memory)
		);
	});
}

function resourceValue(value: unknown): string {
	if (typeof value !== "string" || !value)
		throw new TypeError("WORKLOAD_RESOURCE_INVALID");
	const ratio = quantityRatioV1(value);
	if (!ratio || ratio[0] <= 0n)
		throw new TypeError("WORKLOAD_RESOURCE_INVALID");
	return value;
}

/** Full control envelope; the portable CPU/memory hash remains unchanged. */
export function validateWorkloadControlResourcesV1(
	value: unknown,
): asserts value is WorkloadControlResourcesV1 {
	const resources = value as WorkloadControlResourcesV1 | undefined;
	if (
		!resources ||
		Object.keys(resources).sort().join(",") !== "limits,requests"
	)
		throw new TypeError("WORKLOAD_RESOURCE_INVALID");
	for (const level of ["requests", "limits"] as const) {
		const values = resources[level];
		if (
			!values ||
			!["cpu,memory", "cpu,ephemeral-storage,memory"].includes(
				Object.keys(values).sort().join(","),
			)
		)
			throw new TypeError("WORKLOAD_RESOURCE_INVALID");
		for (const value of Object.values(values)) resourceValue(value);
	}
	for (const key of ["cpu", "memory", "ephemeral-storage"] as const) {
		const request = resources.requests[key];
		const limit = resources.limits[key];
		if (request === undefined || limit === undefined) continue;
		const a = quantityRatioV1(request);
		const b = quantityRatioV1(limit);
		if (!a || !b || a[0] * b[1] > b[0] * a[1])
			throw new TypeError("WORKLOAD_RESOURCE_INVALID");
	}
}

export function workloadControlResourcesEqualV1(
	actual: unknown,
	expected: unknown,
): boolean {
	try {
		validateWorkloadControlResourcesV1(actual);
		validateWorkloadControlResourcesV1(expected);
	} catch {
		return false;
	}
	return (["requests", "limits"] as const).every(
		(level) =>
			Object.keys(actual[level]).sort().join(",") ===
				Object.keys(expected[level]).sort().join(",") &&
			(
				Object.keys(
					expected[level],
				) as (keyof WorkloadControlResourcesV1["requests"])[]
			).every((key) =>
				resourceQuantityEqualsV1(actual[level][key], expected[level][key]),
			),
	);
}

export function validateCodexSessionExecutorResourcePolicyV1(
	policy: CodexSessionExecutorResourcePolicyV1,
): void {
	if (
		!policy ||
		Object.keys(policy).some(
			(key) => !["resources", "tmpSizeLimit", "placement"].includes(key),
		) ||
		!policy.resources ||
		Object.keys(policy.resources).sort().join(",") !== "limits,requests"
	)
		throw new TypeError("CODEX_SESSION_EXECUTOR_POLICY_INVALID");
	validateWorkloadControlResourcesV1(policy.resources);
	if (policy.tmpSizeLimit !== undefined) resourceValue(policy.tmpSizeLimit);
	if (policy.placement !== undefined) {
		const placement = policy.placement;
		if (
			!placement ||
			typeof placement !== "object" ||
			Array.isArray(placement) ||
			!Object.hasOwn(placement, "architecture") ||
			Object.keys(placement).some(
				(key) => !["architecture", "runtimeClassName"].includes(key),
			) ||
			!["amd64", "arm64"].includes(placement.architecture) ||
			(placement.runtimeClassName !== undefined &&
				(typeof placement.runtimeClassName !== "string" ||
					placement.runtimeClassName.length > 253 ||
					(placement.runtimeClassName !== "" &&
						!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(
							placement.runtimeClassName,
						))))
		)
			throw new TypeError("CODEX_SESSION_EXECUTOR_POLICY_INVALID");
	}
}

export function workloadResourceConfigurationHashV1(
	policy: WorkloadResourceConfigurationV1,
): string {
	validateSessionRuntimePlacementV1(policy.sessionRuntimePlacement);
	if (policy.codexSessionExecutor !== undefined)
		validateCodexSessionExecutorResourcePolicyV1(policy.codexSessionExecutor);
	return createHash("sha256")
		.update(
			JSON.stringify({
				resourceProfileRef: policy.resourceProfileRef,
				...(policy.sessionRuntimePlacement === undefined
					? {}
					: {
							sessionRuntimePlacement: {
								architecture: policy.sessionRuntimePlacement.architecture,
								compute: policy.sessionRuntimePlacement.compute,
							},
						}),
				requests: {
					cpu: policy.resources.requests.cpu,
					memory: policy.resources.requests.memory,
				},
				limits: {
					cpu: policy.resources.limits.cpu,
					memory: policy.resources.limits.memory,
				},
				...(policy.codexSessionExecutor === undefined
					? {}
					: {
							codexSessionExecutor: {
								resources: {
									requests: {
										cpu: policy.codexSessionExecutor.resources.requests.cpu,
										memory:
											policy.codexSessionExecutor.resources.requests.memory,
										"ephemeral-storage":
											policy.codexSessionExecutor.resources.requests[
												"ephemeral-storage"
											],
									},
									limits: {
										cpu: policy.codexSessionExecutor.resources.limits.cpu,
										memory: policy.codexSessionExecutor.resources.limits.memory,
										"ephemeral-storage":
											policy.codexSessionExecutor.resources.limits[
												"ephemeral-storage"
											],
									},
								},
								tmpSizeLimit:
									policy.codexSessionExecutor.tmpSizeLimit ?? "128Mi",
								...(policy.codexSessionExecutor.placement === undefined
									? {}
									: {
											placement: {
												architecture:
													policy.codexSessionExecutor.placement.architecture,
												runtimeClassName:
													policy.codexSessionExecutor.placement
														.runtimeClassName ?? "",
											},
										}),
							},
						}),
				...(policy.workspaceSnapshotEgress === undefined
					? {}
					: { workspaceSnapshotEgress: policy.workspaceSnapshotEgress }),
			}),
		)
		.digest("hex");
}

function quantityTotal(values: readonly string[], scale: bigint): number {
	let numerator = 0n;
	let denominator = 1n;
	for (const value of values) {
		const ratio = quantityRatioV1(value);
		if (!ratio || ratio[0] <= 0n)
			throw new TypeError("WORKLOAD_RESOURCE_INVALID");
		numerator = numerator * ratio[1] + ratio[0] * denominator;
		denominator *= ratio[1];
	}
	const count = (numerator * scale + denominator - 1n) / denominator;
	if (count > BigInt(Number.MAX_SAFE_INTEGER))
		throw new TypeError("WORKLOAD_RESOURCE_INVALID");
	return Number(count);
}

export function sessionSandboxResourceCostsV1(policy: {
	readonly resources: CodexSessionExecutorResourcePolicyV1["resources"];
	readonly storageSize: string;
	readonly codexSessionExecutor?: CodexSessionExecutorResourcePolicyV1;
}) {
	if (policy.codexSessionExecutor !== undefined)
		validateCodexSessionExecutorResourcePolicyV1(policy.codexSessionExecutor);
	const executor = policy.codexSessionExecutor?.resources.limits;
	return {
		cpuMillis: quantityTotal(
			[policy.resources.limits.cpu, ...(executor ? [executor.cpu] : [])],
			1000n,
		),
		memoryBytes: quantityTotal(
			[policy.resources.limits.memory, ...(executor ? [executor.memory] : [])],
			1n,
		),
		storageBytes: quantityTotal([policy.storageSize], 1n),
	};
}

/** Separate approval for an OpenCode companion using 80% of the Pod CPU limit.
 * The deployment-wide resource hash still describes the aggregate reservation. */
export function openCodeCompanionResourceProfileRefV1(baseRef: string): string {
	const suffix = "/opencode-80";
	if (baseRef.length + suffix.length <= 256) return baseRef + suffix;
	return createHash("sha256").update(baseRef).digest("hex") + suffix;
}

// Kubernetes accounts both containers towards the existing Session allocation.
export function piContainerResources(
	total: WorkloadControlResourcesV1,
	role: "host" | "pi",
	companionCpuLimitPercent?: 80,
) {
	const result = {
		requests: { ...total.requests },
		limits: { ...total.limits },
	};
	let hostCpuLimit = 0n;
	for (const level of ["limits", "requests"] as const) {
		for (const key of ["cpu", "memory", "ephemeral-storage"] as const) {
			const value = total[level][key];
			if (value === undefined) continue;
			const ratio = quantityRatioV1(value);
			const scale = key === "cpu" ? 1000n : 1n;
			if (!ratio || (ratio[0] * scale) % ratio[1] !== 0n)
				throw new Error("PI_POD_RESOURCES_INVALID");
			const units = (ratio[0] * scale) / ratio[1];
			if (units < 2n) throw new Error("PI_POD_RESOURCES_INVALID");
			let host = units / 2n;
			if (key === "cpu" && companionCpuLimitPercent === 80) {
				// Keep scheduling requests at their existing split unless the smaller Host limit caps them.
				if (level === "limits") {
					hostCpuLimit = units < 5n ? 1n : units / 5n;
					host = hostCpuLimit;
				} else if (host > hostCpuLimit) host = hostCpuLimit;
			}
			result[level][key] =
				String(role === "host" ? host : units - host) +
				(key === "cpu" ? "m" : "");
		}
	}
	return result;
}
