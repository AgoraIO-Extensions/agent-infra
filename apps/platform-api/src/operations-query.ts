import {
	type OperationsHistoryQueryV2,
	type OperationsHistoryV2,
	OperationsHistoryV2Schema,
	type OperationsResourceQueryV2,
} from "@agent-infra/contracts/pilot";
import {
	type OperationsConfigurationV2,
	queryOperationsPrometheusV2,
} from "@agent-infra/observability/operations";
import type { PostgresOperationsResourceStoreV2 } from "@agent-infra/platform-store";
import { operationsResourceHistoryPromqlV2 } from "./operations-history-promql.js";

const quote = (value: string) => JSON.stringify(value);

export function createOperationsQueryV2(options: {
	store: Pick<PostgresOperationsResourceStoreV2, "read" | "historyIdentities">;
	configuration: OperationsConfigurationV2;
	queryPrometheus?: typeof queryOperationsPrometheusV2;
}) {
	const { store, configuration } = options;
	return {
		async read(input: OperationsResourceQueryV2, signal?: AbortSignal) {
			const result = await store.read(input, signal);
			result.refreshSeconds = configuration.intervalSeconds;
			result.retention.configured = {
				detailDays: configuration.prometheus?.detailDays ?? null,
				aggregateDays: configuration.prometheus?.aggregateDays ?? null,
				aggregateStepSeconds:
					configuration.prometheus?.aggregateStepSeconds ?? null,
				logDays: configuration.logs?.retentionDays ?? null,
				traceDays: configuration.traces?.retentionDays ?? null,
			};
			const configuredSources = new Set([
				"platform",
				"kubernetes",
				"pod-metrics",
				...(configuration.readCluster ? ["node-metrics", "image-cache"] : []),
				...(configuration.prometheus ? ["prometheus"] : []),
				...(configuration.logs ? ["logs"] : []),
				...(configuration.traces ? ["traces"] : []),
			]);
			result.sources = result.sources.map((source) => {
				if (!configuredSources.has(source.kind))
					return {
						kind: source.kind,
						state: "not-configured",
						reason: "NOT_CONFIGURED",
						observedAt: null,
						windowSeconds: null,
					};
				return source.state === "not-configured"
					? { ...source, state: "missing", reason: "NO_SAMPLES" }
					: source;
			});
			result.alerts = result.alerts.filter(
				(alert) =>
					alert.code !== "SOURCE_UNAVAILABLE" ||
					configuredSources.has(alert.objectName),
			);
			result.links = (["logs", "traces"] as const).flatMap((kind) => {
				const target = configuration[kind];
				if (!target) return [];
				const url = new URL(target.url);
				url.searchParams.set("namespace", configuration.scope.namespace);
				if (input.agentId) url.searchParams.set("agentId", input.agentId);
				if (input.sessionId) url.searchParams.set("sessionId", input.sessionId);
				return [{ kind, url: url.href }];
			});
			if (configuration.dashboardUrl)
				result.links.unshift({
					kind: "metrics",
					url: configuration.dashboardUrl,
				});
			return result;
		},
		async history(
			input: OperationsHistoryQueryV2,
			signal: AbortSignal,
		): Promise<OperationsHistoryV2> {
			const span = Date.parse(input.end) - Date.parse(input.start);
			const stepSeconds =
				span > 86400_000 ||
				Date.parse(input.start) <
					Date.now() - (configuration.prometheus?.detailDays ?? 7) * 86400_000
					? (configuration.prometheus?.aggregateStepSeconds ?? 300)
					: 30;
			const result: OperationsHistoryV2 = {
				schemaVersion: 2,
				scope: configuration.scope,
				metric: input.metric,
				state: "not-configured",
				start: input.start,
				end: input.end,
				stepSeconds,
				statistic: input.statistic,
				series: [],
				truncated: false,
			};
			if (!configuration.prometheus) return result;
			const earliest =
				Date.now() - configuration.prometheus.aggregateDays * 86400_000;
			const queryStartMilliseconds = Math.max(
				Date.parse(input.start),
				earliest,
			);
			const queryStart = new Date(queryStartMilliseconds).toISOString();
			result.coverage = {
				start: queryStart,
				state:
					Date.parse(input.end) <= earliest
						? "outside-policy"
						: Date.parse(input.start) < earliest
							? "partial"
							: "within-policy",
			};
			if (result.coverage.state === "outside-policy")
				return { ...result, state: "outside-retention" };
			const filtered = Boolean(
				input.agentId || input.sessionId || input.resourceUid,
			);
			if (filtered && !["cpu", "memory", "storage"].includes(input.metric))
				return { ...result, state: "not-supported" };
			try {
				const resourceMetric = ["cpu", "memory", "storage"].includes(
					input.metric,
				);
				const references = resourceMetric
					? await store.historyIdentities(input)
					: { identities: [], truncated: false };
				if (resourceMetric && references.identities.length === 0)
					return { ...result, state: "missing" };
				const namespace = `namespace=${quote(configuration.scope.namespace)}`;
				let expression: string;
				if (resourceMetric) {
					const eligible = references.identities.filter((identity) =>
						input.metric === "storage"
							? identity.kind === "PersistentVolumeClaim"
							: ["Pod", "Node"].includes(identity.kind),
					);
					if (!eligible.length) return { ...result, state: "not-supported" };
					let scoped = "";
					for (let count = 1; count <= eligible.length; count++) {
						const candidate = operationsResourceHistoryPromqlV2({
							metric: input.metric as "cpu" | "memory" | "storage",
							namespace: configuration.scope.namespace,
							identities: eligible.slice(0, count),
							stepSeconds,
							statistic: input.statistic,
						});
						if (!candidate || candidate.length > 16000) {
							references.truncated = true;
							break;
						}
						scoped = candidate;
					}
					if (!scoped)
						return { ...result, state: "unavailable", truncated: true };
					expression = scoped;
				} else {
					if (
						input.metric === "sse-connections" ||
						input.metric === "sse-pending"
					) {
						expression = `sum(agent_platform_resource_count{${namespace},kind=${quote(input.metric === "sse-connections" ? "sse_connections" : "sse_pending_events")}})`;
					} else if (
						["model-errors", "tool-errors", "runtime-errors"].includes(
							input.metric,
						)
					) {
						expression = `sum(rate(agent_platform_operations_total{${namespace},stage=${quote(input.metric.split("-")[0] ?? "runtime")},outcome="failed"}[5m]))`;
					} else if (input.metric === "waiting" || input.metric === "outbox") {
						expression = `max(agent_platform_resource_count{${namespace},kind=${quote(input.metric === "waiting" ? "task_waiting" : "outbox_pending")}})`;
					} else if (
						input.metric === "http-requests" ||
						input.metric === "http-errors"
					) {
						expression = `sum(rate(agent_platform_operations_total{${namespace},stage="http"${input.metric === "http-errors" ? ',outcome="failed"' : ""}}[5m]))`;
					} else {
						const stage =
							input.metric === "dependency-latency"
								? "dependency"
								: (input.metric.split("-")[0] ?? "http");
						expression = `sum(rate(agent_platform_operation_duration_milliseconds_sum{${namespace},stage=${quote(stage)}}[5m])) / sum(rate(agent_platform_operation_duration_milliseconds_count{${namespace},stage=${quote(stage)}}[5m]))`;
					}
					expression = `${input.statistic === "maximum" ? "max_over_time" : "avg_over_time"}((${expression})[${stepSeconds}s:30s])`;
				}
				if (expression.length > 16000)
					return { ...result, state: "unavailable", truncated: true };
				const data = await (
					options.queryPrometheus ?? queryOperationsPrometheusV2
				)(configuration.prometheus, expression, {
					start: queryStart,
					end: input.end,
					stepSeconds,
					signal,
				});
				if (
					!data ||
					typeof data !== "object" ||
					!("resultType" in data) ||
					data.resultType !== "matrix" ||
					!("result" in data) ||
					!Array.isArray(data.result)
				)
					throw new Error();
				result.truncated = references.truncated || data.result.length > 128;
				for (const entry of data.result.slice(0, 128)) {
					if (
						!entry ||
						typeof entry !== "object" ||
						!Array.isArray(entry.values) ||
						entry.values.length > 10000
					)
						throw new Error();
					const metric =
						entry.metric && typeof entry.metric === "object"
							? (entry.metric as Record<string, unknown>)
							: {};
					const uid = typeof metric.uid === "string" ? metric.uid : null;
					const candidates = resourceMetric
						? references.identities.filter((identity) => identity.uid === uid)
						: [undefined];
					for (const reference of candidates) {
						const name =
							reference?.name ??
							metric.pod ??
							metric.persistentvolumeclaim ??
							metric.node ??
							input.metric;
						if (typeof name !== "string" || name.length > 256)
							throw new Error();
						const points: OperationsHistoryV2["series"][number]["points"] = [];
						for (const pair of entry.values) {
							if (
								!Array.isArray(pair) ||
								pair.length !== 2 ||
								typeof pair[0] !== "number" ||
								typeof pair[1] !== "string"
							)
								throw new Error();
							const time = pair[0] * 1000;
							if (
								!Number.isFinite(time) ||
								time < Date.parse(input.start) ||
								time > Date.parse(input.end)
							)
								throw new Error();
							if (time < queryStartMilliseconds) continue;
							if (
								reference &&
								(time < Date.parse(reference.firstSeen) ||
									time > Date.parse(reference.lastSeen))
							)
								continue;

							const value = Number(pair[1]);
							points.push({
								at: new Date(time).toISOString(),
								value: Number.isFinite(value) ? value : null,
							});
						}
						if (points.length)
							result.series.push({
								name,
								resourceUid: reference?.uid ?? null,
								points,
							});
					}
				}
				result.state = result.series.length ? "available" : "missing";
				return OperationsHistoryV2Schema.parse(result);
			} catch {
				return { ...result, state: "unavailable", series: [] };
			}
		},
	};
}
