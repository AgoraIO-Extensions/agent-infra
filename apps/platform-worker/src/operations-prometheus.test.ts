import type { OperationsConfigurationV2 } from "@agent-infra/observability/operations";
import {
	emptyOperationsResourcesV2,
	evaluateOperationsAlertsV2,
} from "@agent-infra/platform-core";
import { expect, it } from "vitest";
import { collectOperationsErrorRatesV2 } from "./operations-prometheus.js";

const configuration: OperationsConfigurationV2 = {
	scope: { clusterId: "cluster", namespace: "ns" },
	readCluster: false,
	cacheOwner: "owner",
	cacheInventoryLimit: 48,
	intervalSeconds: 30,
	alerts: {
		capacityRatio: 0.9,
		criticalRatio: 0.95,
		queueCount: 100,
		errorRatio: 0.2,
	},
	prometheus: {
		endpoint: "https://example.test",
		detailDays: 7,
		aggregateDays: 30,
		aggregateStepSeconds: 300,
	},
};
it("fires configurable error alerts, keeps unknown samples unresolved and resolves on a fresh low ratio", async () => {
	const now = Date.now();
	const snapshot = emptyOperationsResourcesV2(
		configuration.scope,
		new Date(now).toISOString(),
	);
	const signal = new AbortController().signal;
	snapshot.errorRates = await collectOperationsErrorRatesV2(
		configuration,
		signal,
		async (_config, expression) => {
			expect(expression).toContain('namespace="ns"');
			return {
				resultType: "vector",
				result: [
					{ metric: { stage: "http" }, value: [now / 1000, "0.3"] },
					{ metric: { stage: "model" }, value: [now / 1000, "NaN"] },
				],
			};
		},
	);
	const firing = evaluateOperationsAlertsV2(snapshot, [], configuration.alerts);
	expect(firing).toMatchObject([
		{ code: "ERROR_RATE", objectName: "http", threshold: 0.2, state: "firing" },
	]);
	expect(
		snapshot.errorRates.find((entry) => entry.stage === "model")?.ratio,
	).toBeNull();
	snapshot.errorRates = await collectOperationsErrorRatesV2(
		configuration,
		signal,
		async () => {
			throw new Error("private backend error");
		},
	);
	expect(
		evaluateOperationsAlertsV2(snapshot, firing, configuration.alerts),
	).toMatchObject([{ state: "firing" }]);
	snapshot.errorRates = await collectOperationsErrorRatesV2(
		configuration,
		signal,
		async () => ({
			resultType: "vector",
			result: [{ metric: { stage: "http" }, value: [now / 1000, "0"] }],
		}),
	);
	expect(
		evaluateOperationsAlertsV2(snapshot, firing, configuration.alerts),
	).toMatchObject([{ state: "resolved" }]);
});
it("ignores stale, duplicated and unrecognized stage samples", async () => {
	const now = Date.now() / 1000;
	const rates = await collectOperationsErrorRatesV2(
		configuration,
		new AbortController().signal,
		async () => ({
			resultType: "vector",
			result: [
				{ metric: { stage: "http" }, value: [now - 1000, "0.9"] },
				{ metric: { stage: "private-stage" }, value: [now, "1"] },
			],
		}),
	);
	expect(rates.every((entry) => entry.ratio === null)).toBe(true);
	const duplicated = await collectOperationsErrorRatesV2(
		configuration,
		new AbortController().signal,
		async () => ({
			resultType: "vector",
			result: [0.2, 0.3].map((ratio) => ({
				metric: { stage: "http" },
				value: [now, String(ratio)],
			})),
		}),
	);
	expect(duplicated.every((entry) => entry.ratio === null)).toBe(true);
});
