import {
	type OperationsConfigurationV2,
	queryOperationsPrometheusV2,
} from "@agent-infra/observability/operations";
import type { OperationsResourceSnapshotV2 } from "@agent-infra/platform-core";

/** Only fixed namespace/stage aggregates leave the metrics backend. Missing counters stay unknown. */
export async function collectOperationsErrorRatesV2(
	configuration: OperationsConfigurationV2,
	signal: AbortSignal,
	query = queryOperationsPrometheusV2,
): Promise<NonNullable<OperationsResourceSnapshotV2["errorRates"]>> {
	const stages = ["http", "model", "runtime", "tool"] as const;
	const rates: NonNullable<OperationsResourceSnapshotV2["errorRates"]> =
		stages.map((stage) => ({
			stage,
			ratio: null,
			observedAt: null,
			windowSeconds: 300,
		}));
	if (!configuration.prometheus) return rates;
	const scope = `namespace=${JSON.stringify(configuration.scope.namespace)},stage=~"http|model|runtime|tool"`;
	const counter = `agent_platform_operations_total{${scope}}`;
	const freshness = Math.max(90, configuration.intervalSeconds * 3);
	const expression = `(sum by (stage) (rate(agent_platform_operations_total{${scope},outcome="failed"}[5m])) / sum by (stage) (rate(${counter}[5m]))) and on(stage) ((time() - min by (stage) (timestamp(${counter}))) <= ${freshness})`;
	try {
		const data = await query(configuration.prometheus, expression, { signal });
		if (
			!data ||
			typeof data !== "object" ||
			!("resultType" in data) ||
			data.resultType !== "vector" ||
			!("result" in data) ||
			!Array.isArray(data.result) ||
			data.result.length > 4
		)
			return rates;
		const seen = new Set<string>();
		for (const value of data.result) {
			if (
				!value ||
				typeof value !== "object" ||
				!value.metric ||
				!Array.isArray(value.value)
			)
				continue;
			const entry = rates.find((entry) => entry.stage === value.metric.stage);
			if (!entry) continue;
			if (seen.has(entry.stage))
				return stages.map((stage) => ({
					stage,
					ratio: null,
					observedAt: null,
					windowSeconds: 300,
				}));
			seen.add(entry.stage);
			const [at, raw] = value.value;
			const ratio =
				typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
			const milliseconds = typeof at === "number" ? at * 1000 : Number.NaN;
			if (
				!Number.isFinite(ratio) ||
				ratio < 0 ||
				ratio > 1 ||
				!Number.isFinite(milliseconds) ||
				milliseconds > Date.now() + 5000 ||
				Date.now() - milliseconds > freshness * 1000
			)
				continue;
			entry.ratio = ratio;
			entry.observedAt = new Date(milliseconds).toISOString();
		}
	} catch {
		/* An error-rate query cannot discard independent Kubernetes observations. */
	}
	return rates;
}
