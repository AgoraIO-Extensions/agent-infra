import type {
	OperationsConfigurationV2,
	queryOperationsPrometheusV2,
} from "@agent-infra/observability/operations";
import { emptyOperationsResourcesV2 } from "@agent-infra/platform-core";
import { afterEach, expect, it, vi } from "vitest";
import { createOperationsQueryV2 } from "./operations-query.js";

const configuration: OperationsConfigurationV2 = {
	scope: { clusterId: "cluster", namespace: "ns" },
	readCluster: false,
	cacheOwner: "owner",
	cacheInventoryLimit: 48,
	intervalSeconds: 30,
	alerts: { capacityRatio: 0.9, criticalRatio: 0.95, queueCount: 100 },
	prometheus: {
		endpoint: "https://example.test",
		detailDays: 7,
		aggregateDays: 30,
		aggregateStepSeconds: 300,
	},
};
const now = Date.parse("2026-11-17T00:00:00Z");
const daysAgo = (days: number) =>
	new Date(now - days * 86400_000).toISOString();
afterEach(() => vi.useRealTimers());

it("uses age as well as range length, clips expired intervals and reports outside retention without querying", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
	const queryPrometheus = vi.fn<typeof queryOperationsPrometheusV2>(
		async () => ({ resultType: "matrix", result: [] }),
	);
	const store = {
		read: async () =>
			emptyOperationsResourcesV2(configuration.scope, daysAgo(0)),
		historyIdentities: async () => ({ identities: [], truncated: false }),
	};
	const query = createOperationsQueryV2({
		configuration,
		store,
		queryPrometheus,
	});
	const input = {
		metric: "http-requests" as const,
		statistic: "average" as const,
		start: daysAgo(10),
		end: daysAgo(9.99),
	};
	expect(
		await query.history(input, new AbortController().signal),
	).toMatchObject({
		stepSeconds: 300,
		state: "missing",
		coverage: { state: "within-policy" },
	});
	expect(
		await query.history(
			{ ...input, start: daysAgo(31), end: daysAgo(29) },
			new AbortController().signal,
		),
	).toMatchObject({ coverage: { state: "partial", start: daysAgo(30) } });
	expect(queryPrometheus.mock.calls.at(-1)?.[2]).toMatchObject({
		start: daysAgo(30),
	});
	queryPrometheus.mockClear();
	expect(
		await query.history(
			{ ...input, start: daysAgo(32), end: daysAgo(31) },
			new AbortController().signal,
		),
	).toMatchObject({ state: "outside-retention", series: [] });
	expect(queryPrometheus).not.toHaveBeenCalled();
	expect((await query.read({})).retention).toMatchObject({
		effective: null,
		configured: {
			detailDays: 7,
			aggregateDays: 30,
			logDays: null,
			traceDays: null,
		},
	});
});
