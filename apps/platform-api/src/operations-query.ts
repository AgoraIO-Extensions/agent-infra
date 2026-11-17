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

const quote = (value: string) => JSON.stringify(value);
const regex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
			const configuredSources = new Set([
				"kubernetes",
				"pod-metrics",
				...(configuration.readCluster ? ["node-metrics", "image-cache"] : []),
				...(configuration.prometheus ? ["prometheus"] : []),
				...(configuration.logs ? ["logs"] : []),
				...(configuration.traces ? ["traces"] : []),
			]);
			result.sources = result.sources.map((source) =>
				source.state === "not-configured" && configuredSources.has(source.kind)
					? { ...source, state: "missing", reason: "NO_SAMPLES" }
					: source,
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
			return result;
		},
		async history(
			input: OperationsHistoryQueryV2,
			signal: AbortSignal,
		): Promise<OperationsHistoryV2> {
			const span = Date.parse(input.end) - Date.parse(input.start);
			const stepSeconds =
				span > 86400_000
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
			const filtered = Boolean(
				input.agentId || input.sessionId || input.resourceUid,
			);
			if (filtered && !["cpu", "memory", "storage"].includes(input.metric))
				return { ...result, state: "not-supported" };
			try {
				const references = filtered
					? await store.historyIdentities(input)
					: { identities: [], truncated: false };
				if (filtered && references.identities.length === 0)
					return { ...result, state: "missing" };
				const namespace = `namespace=${quote(configuration.scope.namespace)}`;
				let expression: string;
				if (
					filtered &&
					references.identities.every((entry) => entry.kind === "Node") &&
					["cpu", "memory"].includes(input.metric)
				) {
					const nodes = `node=~${quote(references.identities.map((entry) => regex(entry.name)).join("|"))}`;
					expression =
						input.metric === "cpu"
							? `sum by (node) (rate(node_cpu_seconds_total{${nodes},mode!="idle"}[2m]))`
							: `sum by (node) (node_memory_MemTotal_bytes{${nodes}} - node_memory_MemAvailable_bytes{${nodes}})`;
				} else if (input.metric === "cpu" || input.metric === "memory") {
					const base =
						input.metric === "cpu"
							? `rate(container_cpu_usage_seconds_total{${namespace},container!="",container!="POD"}[2m])`
							: `container_memory_working_set_bytes{${namespace},container!="",container!="POD"}`;
					if (filtered) {
						const pods = references.identities.filter(
							(entry) => entry.kind === "Pod",
						);
						if (!pods.length) return { ...result, state: "not-supported" };
						expression = `sum by (pod,uid) ((${base}) * on(namespace,pod) group_left(uid) kube_pod_info{${namespace},uid=~${quote(pods.map((entry) => regex(entry.uid)).join("|"))}})`;
					} else expression = `sum by (pod) (${base})`;
				} else if (input.metric === "storage") {
					const volumes = references.identities.filter(
						(entry) => entry.kind === "PersistentVolumeClaim",
					);
					if (filtered && !volumes.length)
						return { ...result, state: "not-supported" };
					const selector = filtered
						? `,persistentvolumeclaim=~${quote(volumes.map((entry) => regex(entry.name)).join("|"))}`
						: "";
					expression = `sum by (persistentvolumeclaim) (kubelet_volume_stats_used_bytes{${namespace}${selector}})`;
				} else if (
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
				if (expression.length > 16000)
					return { ...result, state: "unavailable", truncated: true };
				const data = await (
					options.queryPrometheus ?? queryOperationsPrometheusV2
				)(configuration.prometheus, expression, {
					start: input.start,
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
					const candidates = filtered
						? references.identities.filter((identity) =>
								uid
									? identity.uid === uid
									: identity.kind === "PersistentVolumeClaim"
										? identity.name === metric.persistentvolumeclaim
										: identity.kind === "Node" && identity.name === metric.node,
							)
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
							if (
								reference &&
								(time < Date.parse(reference.firstSeen) ||
									time > Date.parse(reference.lastSeen))
							)
								continue;
							if (
								reference &&
								!uid &&
								references.identities.filter(
									(other) =>
										other.kind === reference.kind &&
										other.name === reference.name &&
										time >= Date.parse(other.firstSeen) &&
										time <= Date.parse(other.lastSeen),
								).length !== 1
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
