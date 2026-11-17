import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	queryOperationsPrometheusV2,
	readOperationsConfigurationV2,
} from "./operations.js";

const directories: string[] = [];
afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
async function configuration(value: unknown) {
	const directory = await mkdtemp(join(tmpdir(), "ops-config-test-"));
	directories.push(directory);
	const path = join(directory, "configuration.json");
	await writeFile(path, JSON.stringify(value));
	return path;
}
const configured = {
	schemaVersion: 2,
	enabled: true,
	scope: { clusterId: "cluster-test", namespace: "platform-test" },
};

it("loads an enabled deployment with cluster reads disabled by default", async () => {
	const result = await readOperationsConfigurationV2(
		await configuration(configured),
	);
	expect(result).toMatchObject({
		scope: configured.scope,
		readCluster: false,
		intervalSeconds: 30,
		cacheInventoryLimit: 48,
	});
});

it("rejects inline cloud credentials instead of silently ignoring them", async () => {
	const path = await configuration({
		...configured,
		prometheus: {
			endpoint: "https://prometheus.example.test",
			token: "synthetic-inline-credential",
		},
	});
	await expect(readOperationsConfigurationV2(path)).rejects.toThrow(
		"OPERATIONS_CONFIGURATION_UNAVAILABLE",
	);
});

it("rejects credential-bearing and non-HTTPS query endpoints", async () => {
	for (const endpoint of [
		"http://prometheus.example.test",
		"https://user:synthetic@prometheus.example.test",
		"https://prometheus.example.test/?token=synthetic",
	]) {
		await expect(
			readOperationsConfigurationV2(
				await configuration({ ...configured, prometheus: { endpoint } }),
			),
		).rejects.toThrow("OPERATIONS_CONFIGURATION_UNAVAILABLE");
	}
});

it("bounds the Prometheus response and redacts transport failures", async () => {
	const config = {
		endpoint: "https://prometheus.example.test/instance",
		detailDays: 7,
		aggregateDays: 30,
		aggregateStepSeconds: 300,
	};
	vi.stubGlobal("fetch", async () => {
		throw new Error("synthetic-private-remote-value");
	});
	await expect(
		queryOperationsPrometheusV2(config, 'up{namespace="platform-test"}', {
			signal: AbortSignal.timeout(1000),
		}),
	).rejects.toThrow("OPERATIONS_HISTORY_UNAVAILABLE");
	vi.stubGlobal(
		"fetch",
		async () => new Response("x".repeat(8 * 1024 * 1024 + 1)),
	);
	await expect(
		queryOperationsPrometheusV2(config, 'up{namespace="platform-test"}', {
			signal: AbortSignal.timeout(1000),
		}),
	).rejects.toThrow("OPERATIONS_HISTORY_UNAVAILABLE");
});

it("sends only the bounded query to the configured backend with redirects disabled", async () => {
	let observed: { url: string; redirect: unknown } | undefined;
	vi.stubGlobal("fetch", async (url: URL, options: RequestInit) => {
		observed = { url: url.href, redirect: options.redirect };
		return Response.json({
			status: "success",
			data: { resultType: "vector", result: [] },
		});
	});
	const result = await queryOperationsPrometheusV2(
		{
			endpoint: "https://prometheus.example.test/instance",
			detailDays: 7,
			aggregateDays: 30,
			aggregateStepSeconds: 300,
		},
		'up{namespace="platform-test"}',
		{ signal: AbortSignal.timeout(1000) },
	);
	expect(result).toEqual({ resultType: "vector", result: [] });
	expect(observed?.redirect).toBe("error");
	expect(new URL(observed?.url ?? "").pathname).toBe("/instance/api/v1/query");
});
