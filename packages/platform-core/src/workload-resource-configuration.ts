import { createHash } from "node:crypto";

export interface CodexSessionExecutorResourcePolicyV1 {
	readonly resources: {
		readonly requests: { readonly cpu: string; readonly memory: string };
		readonly limits: { readonly cpu: string; readonly memory: string };
	};
	readonly tmpSizeLimit?: string;
	readonly placement?: {
		readonly architecture: "amd64" | "arm64";
		readonly runtimeClassName?: string;
	};
}

export interface WorkloadResourceConfigurationV1 {
	readonly resourceProfileRef: string;
	readonly resources: CodexSessionExecutorResourcePolicyV1["resources"];
	readonly codexSessionExecutor?: CodexSessionExecutorResourcePolicyV1;
	readonly workspaceSnapshotEgress?: unknown;
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
	for (const level of ["requests", "limits"] as const) {
		const resources = policy.resources?.[level];
		if (!resources || Object.keys(resources).sort().join(",") !== "cpu,memory")
			throw new TypeError("CODEX_SESSION_EXECUTOR_POLICY_INVALID");
		resourceValue(resources.cpu);
		resourceValue(resources.memory);
	}
	for (const name of ["cpu", "memory"] as const) {
		const request = quantityRatioV1(policy.resources.requests[name]);
		const limit = quantityRatioV1(policy.resources.limits[name]);
		if (!request || !limit || request[0] * limit[1] > limit[0] * request[1])
			throw new TypeError("CODEX_SESSION_EXECUTOR_POLICY_INVALID");
	}
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
	if (policy.codexSessionExecutor !== undefined)
		validateCodexSessionExecutorResourcePolicyV1(policy.codexSessionExecutor);
	return createHash("sha256")
		.update(
			JSON.stringify({
				resourceProfileRef: policy.resourceProfileRef,
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
									},
									limits: {
										cpu: policy.codexSessionExecutor.resources.limits.cpu,
										memory: policy.codexSessionExecutor.resources.limits.memory,
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
