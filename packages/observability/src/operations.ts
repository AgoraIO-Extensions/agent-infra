import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
	defaultOperationsAlertThresholdsV2,
	type OperationsAlertThresholdsV2,
} from "@agent-infra/platform-core";

export interface OperationsConfigurationV2 {
	readonly scope: { clusterId: string; namespace: string };
	readonly readCluster: boolean;
	readonly cacheOwner: string;
	readonly cacheInventoryLimit: number;
	readonly intervalSeconds: number;
	readonly workloadNamespaceRef?: string;
	readonly alerts: OperationsAlertThresholdsV2;
	readonly prometheus?: {
		endpoint: string;
		tokenFile?: string;
		detailDays: number;
		aggregateDays: number;
		aggregateStepSeconds: number;
	};
	readonly logs?: { url: string; retentionDays: number };
	readonly traces?: { url: string; retentionDays: number };
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid operations configuration");
	return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
	if (Object.keys(value).some((key) => !allowed.includes(key)))
		throw new Error("Invalid operations configuration");
}
function number(value: unknown, fallback: number, min: number, max: number) {
	const result = value === undefined ? fallback : value;
	if (
		typeof result !== "number" ||
		!Number.isFinite(result) ||
		result < min ||
		result > max
	)
		throw new Error("Invalid operations configuration");
	return result;
}
function integer(value: unknown, fallback: number, min: number, max: number) {
	const result = number(value, fallback, min, max);
	if (!Number.isSafeInteger(result))
		throw new Error("Invalid operations configuration");
	return result;
}
function text(value: unknown, max = 256): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max)
		throw new Error("Invalid operations configuration");
	return value;
}
function url(value: unknown): string {
	const result = new URL(text(value, 2048));
	if (
		result.protocol !== "https:" ||
		result.username ||
		result.password ||
		result.hash ||
		[...result.searchParams.keys()].some((key) =>
			/token|key|secret|authorization|password|credential|cookie|^session$|jwt/i.test(
				key,
			),
		)
	)
		throw new Error("Invalid operations configuration");
	return result.href;
}

/** Deployment-owned JSON only; no cloud credential is accepted inline or exposed in errors. */
export async function readOperationsConfigurationV2(
	path = process.env.AGENT_INFRA_OPERATIONS_CONFIG_FILE,
): Promise<OperationsConfigurationV2 | undefined> {
	if (!path) return undefined;
	try {
		if (!isAbsolute(path)) throw new Error();
		const bytes = await readFile(path);
		if (bytes.length > 65536) throw new Error();
		const value = record(JSON.parse(bytes.toString("utf8")));
		keys(value, [
			"schemaVersion",
			"enabled",
			"scope",
			"readCluster",
			"cacheOwner",
			"cacheInventoryLimit",
			"intervalSeconds",
			"workloadNamespaceRef",
			"alerts",
			"prometheus",
			"logs",
			"traces",
		]);
		if (value.schemaVersion !== 2 || typeof value.enabled !== "boolean")
			throw new Error();
		if (!value.enabled) return undefined;
		const scope = record(value.scope);
		keys(scope, ["clusterId", "namespace"]);
		const namespace = text(scope.namespace, 63);
		const expectedNamespace =
			process.env.AGENT_INFRA_OPERATIONS_NAMESPACE ??
			process.env.PLATFORM_WORKER_NAMESPACE;
		if (expectedNamespace && namespace !== expectedNamespace) throw new Error();
		const cacheOwner =
			value.cacheOwner === undefined
				? "agent-infra-release-cache-v1"
				: text(value.cacheOwner, 63);
		if (
			!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace) ||
			!/^[a-zA-Z0-9]([-a-zA-Z0-9_.]*[a-zA-Z0-9])?$/.test(cacheOwner) ||
			(value.readCluster !== undefined &&
				typeof value.readCluster !== "boolean")
		)
			throw new Error();
		const thresholds = value.alerts === undefined ? {} : record(value.alerts);
		keys(thresholds, [
			"capacityRatio",
			"criticalRatio",
			"queueCount",
			"errorRatio",
		]);
		const alerts = {
			errorRatio: number(thresholds.errorRatio, 0.1, 0.001, 1),
			capacityRatio: number(
				thresholds.capacityRatio,
				defaultOperationsAlertThresholdsV2.capacityRatio,
				0.1,
				1,
			),
			criticalRatio: number(
				thresholds.criticalRatio,
				defaultOperationsAlertThresholdsV2.criticalRatio,
				0.1,
				1,
			),
			queueCount: number(
				thresholds.queueCount,
				defaultOperationsAlertThresholdsV2.queueCount,
				1,
				1000000,
			),
		};
		if (
			alerts.criticalRatio < alerts.capacityRatio ||
			!Number.isSafeInteger(alerts.queueCount)
		)
			throw new Error();
		const prometheus =
			value.prometheus === undefined ? undefined : record(value.prometheus);
		if (prometheus)
			keys(prometheus, [
				"endpoint",
				"tokenFile",
				"detailDays",
				"aggregateDays",
				"aggregateStepSeconds",
			]);
		if (
			prometheus &&
			integer(prometheus.aggregateDays, 30, 0, 365) <
				integer(prometheus.detailDays, 7, 0, 365)
		)
			throw new Error();
		const endpoint = prometheus ? url(prometheus.endpoint) : undefined;
		if (endpoint && new URL(endpoint).search) throw new Error();
		const tokenFile =
			prometheus?.tokenFile === undefined
				? undefined
				: text(prometheus.tokenFile, 1024);
		if (tokenFile && !isAbsolute(tokenFile)) throw new Error();
		const link = (entry: unknown) => {
			const source = record(entry);
			keys(source, ["url", "retentionDays"]);
			return {
				url: url(source.url),
				retentionDays: integer(source.retentionDays, 7, 0, 365),
			};
		};
		return {
			scope: { clusterId: text(scope.clusterId), namespace },
			readCluster: value.readCluster === true,
			cacheOwner,
			cacheInventoryLimit: integer(value.cacheInventoryLimit, 48, 1, 128),
			intervalSeconds: integer(value.intervalSeconds, 30, 15, 300),
			alerts,
			...(value.workloadNamespaceRef === undefined
				? {}
				: { workloadNamespaceRef: text(value.workloadNamespaceRef) }),
			...(prometheus && endpoint
				? {
						prometheus: {
							endpoint,
							...(tokenFile ? { tokenFile } : {}),
							detailDays: integer(prometheus.detailDays, 7, 0, 365),
							aggregateDays: integer(prometheus.aggregateDays, 30, 0, 365),
							aggregateStepSeconds: integer(
								prometheus.aggregateStepSeconds,
								300,
								30,
								3600,
							),
						},
					}
				: {}),
			...(value.logs === undefined ? {} : { logs: link(value.logs) }),
			...(value.traces === undefined ? {} : { traces: link(value.traces) }),
		};
	} catch {
		throw new Error("OPERATIONS_CONFIGURATION_UNAVAILABLE");
	}
}

export async function queryOperationsPrometheusV2(
	configuration: NonNullable<OperationsConfigurationV2["prometheus"]>,
	query: string,
	input: {
		start?: string;
		end?: string;
		stepSeconds?: number;
		signal: AbortSignal;
	},
): Promise<unknown> {
	const endpoint = new URL(configuration.endpoint);
	endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/api/v1/${input.start ? "query_range" : "query"}`;
	endpoint.searchParams.set("query", query);
	endpoint.searchParams.set("timeout", "5s");
	if (input.start && input.end) {
		endpoint.searchParams.set("start", input.start);
		endpoint.searchParams.set("end", input.end);
		endpoint.searchParams.set("step", String(input.stepSeconds ?? 30));
	}
	try {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (configuration.tokenFile) {
			const token = (await readFile(configuration.tokenFile, "utf8")).trim();
			if (!token || token.length > 8192 || /\s/.test(token)) throw new Error();
			headers.Authorization = `Bearer ${token}`;
		}
		const response = await fetch(endpoint, {
			headers,
			redirect: "error",
			signal: AbortSignal.any([input.signal, AbortSignal.timeout(8000)]),
		});
		if (!response.ok || !response.body) throw new Error();
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				length += chunk.value.byteLength;
				if (length > 8 * 1024 * 1024) throw new Error();
				chunks.push(chunk.value);
			}
		} finally {
			await reader.cancel().catch(() => undefined);
		}
		const result = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
		if (result.status !== "success") throw new Error();
		return result.data;
	} catch {
		throw new Error("OPERATIONS_HISTORY_UNAVAILABLE");
	}
}
