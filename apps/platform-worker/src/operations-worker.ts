import {
	type OperationsConfigurationV2,
	queryOperationsPrometheusV2,
	readOperationsConfigurationV2,
} from "@agent-infra/observability/operations";
import type { OperationsInventoryV2 } from "@agent-infra/platform-core";
import { PostgresOperationsResourceStoreV2 } from "@agent-infra/platform-store";
import { collectOperationsSnapshotV2 } from "./operations-collector.js";
import { createOperationsKubernetesReaderV2 } from "./operations-kubernetes.js";
import { collectOperationsErrorRatesV2 } from "./operations-prometheus.js";

export function createOperationsWorkerV2(input: {
	configuration: OperationsConfigurationV2;
	store: PostgresOperationsResourceStoreV2;
	read: ReturnType<typeof createOperationsKubernetesReaderV2>;
	signal?: AbortSignal;
}) {
	const controller = new AbortController();
	const signal = AbortSignal.any([
		input.signal ?? new AbortController().signal,
		controller.signal,
	]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending: Promise<void> | undefined;
	const collect = async () => {
		const configuration = input.configuration;
		const bindings = await input.store.readBindings().catch(() => []);
		let requestInventory: OperationsInventoryV2 | undefined;
		const snapshot = await collectOperationsSnapshotV2({
			...configuration,
			bindings,
			read: input.read,
			signal,
			onRequestInventory: (value) => {
				requestInventory = value;
			},
		});
		try {
			const platform = await input.store.read({}, signal);
			snapshot.budget = platform.budget;
			snapshot.queue = platform.queue;
			snapshot.database = platform.database;
			const source = platform.sources.find(
				(entry) => entry.kind === "platform",
			);
			if (source) snapshot.sources[0] = source;
		} catch {
			snapshot.sources[0] = {
				kind: "platform",
				state: "unavailable",
				observedAt: null,
				windowSeconds: null,
				reason: "QUERY_FAILED",
			};
		}
		if (configuration.prometheus) {
			try {
				const data = await queryOperationsPrometheusV2(
					configuration.prometheus,
					`max(timestamp(kube_pod_info{namespace=${JSON.stringify(configuration.scope.namespace)}}))`,
					{ signal },
				);
				const result =
					typeof data === "object" && data !== null && "result" in data
						? data.result
						: undefined;
				const entry =
					Array.isArray(result) && result[0] && typeof result[0] === "object"
						? (result[0] as { value?: unknown })
						: undefined;
				const pair = Array.isArray(entry?.value) ? entry.value : undefined;
				const milliseconds =
					pair && typeof pair[1] === "string"
						? Number(pair[1]) * 1000
						: Number.NaN;
				const available =
					Number.isFinite(milliseconds) &&
					milliseconds >= 0 &&
					milliseconds <= Date.now() + 5000;
				const stale =
					available &&
					Date.now() - milliseconds >
						Math.max(90_000, configuration.intervalSeconds * 3000);
				snapshot.sources[5] = {
					kind: "prometheus",
					state: available ? (stale ? "stale" : "available") : "missing",
					observedAt: available ? new Date(milliseconds).toISOString() : null,
					windowSeconds: null,
					reason: available ? (stale ? "STALE" : null) : "NO_SAMPLES",
				};
			} catch {
				snapshot.sources[5] = {
					kind: "prometheus",
					state: "unavailable",
					observedAt: null,
					windowSeconds: null,
					reason: "QUERY_FAILED",
				};
			}
		}
		snapshot.errorRates = await collectOperationsErrorRatesV2(
			configuration,
			signal,
		);
		for (const kind of ["logs", "traces"] as const) {
			const configured = configuration[kind];
			if (!configured) continue;
			const url = new URL(configured.url);
			url.searchParams.set("namespace", configuration.scope.namespace);
			snapshot.links.push({ kind, url: url.href });
			// A configured link alone cannot attest backend ingestion or query availability.
			const index = snapshot.sources.findIndex(
				(source) => source.kind === kind,
			);
			snapshot.sources[index] = {
				kind,
				state: "missing",
				observedAt: null,
				windowSeconds: null,
				reason: "NO_SAMPLES",
			};
		}
		snapshot.refreshSeconds = configuration.intervalSeconds;
		snapshot.generatedAt = new Date().toISOString();
		if (!signal.aborted) await input.store.write(snapshot, requestInventory);
	};
	const tick = () => {
		if (signal.aborted || pending) return;
		const cycleStarted = performance.now();
		pending = collect()
			.catch(() => {
				if (!signal.aborted)
					process.stderr.write(
						`${JSON.stringify({ service: "platform-worker", code: "OPERATIONS_COLLECTION_UNAVAILABLE" })}\n`,
					);
			})
			.finally(() => {
				pending = undefined;
				if (!signal.aborted) {
					const period = input.configuration.intervalSeconds * 1000;
					timer = setTimeout(
						tick,
						period - ((performance.now() - cycleStarted) % period),
					);
					timer.unref();
				}
			});
	};
	return {
		start: tick,
		async stop() {
			controller.abort();
			if (timer) clearTimeout(timer);
			await pending;
			await input.store.close();
		},
	};
}

/** Optional observational loop; missing/broken monitoring configuration never changes business startup. */
export async function startOperationsWorkerFromDeploymentV2(
	signal?: AbortSignal,
) {
	let store: PostgresOperationsResourceStoreV2 | undefined;
	try {
		const configuration = await readOperationsConfigurationV2();
		if (!configuration) return undefined;
		const databaseUrl = process.env.PLATFORM_DATABASE_URL;
		if (!databaseUrl) throw new Error();
		store = new PostgresOperationsResourceStoreV2({
			databaseUrl,
			scope: configuration.scope,
			workloadNamespaceRef: configuration.workloadNamespaceRef,
			alertThresholds: configuration.alerts,
		});
		const worker = createOperationsWorkerV2({
			configuration,
			store,
			signal,
			read: createOperationsKubernetesReaderV2({
				namespace: configuration.scope.namespace,
				readCluster: configuration.readCluster,
				cacheOwner: configuration.cacheOwner,
			}),
		});
		worker.start();
		return worker;
	} catch {
		await store?.close().catch(() => undefined);
		process.stderr.write(
			`${JSON.stringify({ service: "platform-worker", code: "OPERATIONS_CONFIGURATION_UNAVAILABLE" })}\n`,
		);
		return undefined;
	}
}
