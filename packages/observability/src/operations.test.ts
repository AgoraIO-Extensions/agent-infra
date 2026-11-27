import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runtimeTlsFixture } from "../../../tests/runtime-tls-fixture.js";
import {
	queryOperationsPrometheusV2,
	readOperationsConfigurationV2,
} from "./operations.js";

const directories: string[] = [];
it("queries a private Prometheus with a verified server and a dedicated client certificate", async () => {
	const serverTLS = await runtimeTlsFixture();
	directories.push(serverTLS.directory);
	const clientTLS = await runtimeTlsFixture({
		issuerDirectory: serverTLS.directory,
		extendedKeyUsage: "clientAuth",
	});
	directories.push(clientTLS.directory);
	const server = createServer(
		{ ...serverTLS, requestCert: true, rejectUnauthorized: true },
		(req, res) => {
			expect(new URL(req.url ?? "", "https://localhost").pathname).toBe(
				"/api/v1/query_range",
			);
			res.end(JSON.stringify({ status: "success", data: { result: [] } }));
		},
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const endpoint = `https://localhost:${(server.address() as AddressInfo).port}`;
		const config = await readOperationsConfigurationV2(
			await configuration({
				...configured,
				prometheus: { endpoint, clientTLSDirectory: clientTLS.directory },
			}),
		);
		if (!config?.prometheus) throw new Error("Missing metrics configuration");
		const range = {
			start: "2026-11-27T04:00:00Z",
			end: "2026-11-27T04:10:00Z",
			signal: AbortSignal.timeout(6000),
		};
		await expect(
			queryOperationsPrometheusV2(config.prometheus, "up", range),
		).resolves.toEqual({ result: [] });
		await expect(
			queryOperationsPrometheusV2(
				{
					...config.prometheus,
					endpoint: endpoint.replace("localhost", "127.0.0.1"),
				},
				"up",
				range,
			),
		).rejects.toThrow("OPERATIONS_HISTORY_UNAVAILABLE");
		await expect(
			queryOperationsPrometheusV2(
				{ ...config.prometheus, clientTLSDirectory: serverTLS.directory },
				"up",
				range,
			),
		).rejects.toThrow("OPERATIONS_HISTORY_UNAVAILABLE");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
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

it("accepts an HTTPS dashboard link and rejects embedded credentials", async () => {
	const dashboardUrl = "https://grafana.example.test/d/impact";
	expect(
		(
			await readOperationsConfigurationV2(
				await configuration({ ...configured, dashboardUrl }),
			)
		)?.dashboardUrl,
	).toBe(dashboardUrl);
	await expect(
		readOperationsConfigurationV2(
			await configuration({
				...configured,
				dashboardUrl: dashboardUrl + "?token=example",
			}),
		),
	).rejects.toThrow("OPERATIONS_CONFIGURATION_UNAVAILABLE");
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

it("loads an absolute Basic auth file without returning its credentials", async () => {
	const basicAuthFile = await configuration({
		username: "synthetic-reader",
		password: "synthetic-secret",
	});
	const result = await readOperationsConfigurationV2(
		await configuration({
			...configured,
			prometheus: {
				endpoint: "https://prometheus.example.test",
				basicAuthFile,
			},
		}),
	);
	expect(result?.prometheus).toMatchObject({ basicAuthFile });
	expect(JSON.stringify(result)).not.toContain("synthetic-secret");
});

it.each([
	{ basicAuthFile: "relative-credentials.json" },
	{ basicAuthFile: "/credentials.json", tokenFile: "/token" },
	{ basicAuthFile: { username: "synthetic", password: "synthetic" } },
	{ username: "synthetic", password: "synthetic" },
])(
	"rejects ambiguous, relative or inline Basic auth configuration %j",
	async (auth) => {
		await expect(
			readOperationsConfigurationV2(
				await configuration({
					...configured,
					prometheus: { endpoint: "https://prometheus.example.test", ...auth },
				}),
			),
		).rejects.toThrow("OPERATIONS_CONFIGURATION_UNAVAILABLE");
	},
);

it.each([false, true])(
	"uses Basic auth for range query=%s without exposing credentials in the URL",
	async (range) => {
		const basicAuthFile = await configuration({
			username: "synthetic-reader",
			password: "synthetic-secret$sts-token:part",
		});
		let observed:
			| { url: string; authorization: string | undefined; redirect: unknown }
			| undefined;
		vi.stubGlobal("fetch", async (url: URL, options: RequestInit) => {
			observed = {
				url: url.href,
				authorization: (options.headers as Record<string, string>)
					.Authorization,
				redirect: options.redirect,
			};
			return Response.json({ status: "success", data: { result: [] } });
		});
		await queryOperationsPrometheusV2(
			{
				endpoint: "https://prometheus.example.test/instance",
				basicAuthFile,
				detailDays: 7,
				aggregateDays: 30,
				aggregateStepSeconds: 300,
			},
			'up{namespace="platform-test"}',
			{
				signal: AbortSignal.timeout(1000),
				...(range
					? { start: "2026-11-17T00:00:00Z", end: "2026-11-17T01:00:00Z" }
					: {}),
			},
		);
		expect(observed?.authorization).toBe(
			`Basic ${Buffer.from("synthetic-reader:synthetic-secret$sts-token:part").toString("base64")}`,
		);
		expect(observed?.redirect).toBe("error");
		expect(new URL(observed?.url ?? "").pathname).toBe(
			`/instance/api/v1/${range ? "query_range" : "query"}`,
		);
		expect(observed?.url).not.toContain("synthetic");
	},
);

it.each([
	"{",
	"null",
	JSON.stringify({ username: "synthetic-reader" }),
	JSON.stringify({
		username: "synthetic:reader",
		password: "synthetic-secret",
	}),
	JSON.stringify({
		username: "synthetic-reader",
		password: "synthetic-secret\n",
	}),
	JSON.stringify({
		username: "synthetic-reader",
		password: "synthetic-secret",
		extra: "not-allowed",
	}),
	JSON.stringify({ username: "synthetic-reader", password: "x".repeat(8192) }),
])(
	"rejects malformed Basic auth before sending a request (case %#)",
	async (contents) => {
		const basicAuthFile = await configuration(null);
		await writeFile(basicAuthFile, contents);
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await expect(
			queryOperationsPrometheusV2(
				{
					endpoint: "https://prometheus.example.test",
					basicAuthFile,
					detailDays: 7,
					aggregateDays: 30,
					aggregateStepSeconds: 300,
				},
				"up",
				{ signal: AbortSignal.timeout(1000) },
			),
		).rejects.toThrow(/^OPERATIONS_HISTORY_UNAVAILABLE$/);
		expect(fetch).not.toHaveBeenCalled();
	},
);

it("keeps Bearer file authentication and rejects conflicting direct query credentials", async () => {
	const tokenFile = await configuration(null);
	await writeFile(tokenFile, "synthetic-token\n");
	const fetch = vi.fn(async (_url: URL, options: RequestInit) => {
		expect((options.headers as Record<string, string>).Authorization).toBe(
			"Bearer synthetic-token",
		);
		return Response.json({ status: "success", data: { result: [] } });
	});
	vi.stubGlobal("fetch", fetch);
	const backend = {
		endpoint: "https://prometheus.example.test",
		tokenFile,
		detailDays: 7,
		aggregateDays: 30,
		aggregateStepSeconds: 300,
	};
	await queryOperationsPrometheusV2(backend, "up", {
		signal: AbortSignal.timeout(1000),
	});
	fetch.mockClear();
	await expect(
		queryOperationsPrometheusV2(
			{ ...backend, endpoint: "http://prometheus.example.test" },
			"up",
			{ signal: AbortSignal.timeout(1000) },
		),
	).rejects.toThrow(/^OPERATIONS_HISTORY_UNAVAILABLE$/);
	await expect(
		queryOperationsPrometheusV2(
			{ ...backend, basicAuthFile: tokenFile },
			"up",
			{ signal: AbortSignal.timeout(1000) },
		),
	).rejects.toThrow(/^OPERATIONS_HISTORY_UNAVAILABLE$/);
	expect(fetch).not.toHaveBeenCalled();
});

it.each([16 * 1024, 16 * 1024 + 1])(
	"bounds the Basic auth file before parsing (%i bytes)",
	async (size) => {
		const basicAuthFile = await configuration(null);
		const contents = JSON.stringify({
			username: "synthetic-reader",
			password: "synthetic-secret",
		});
		await writeFile(basicAuthFile, contents.padEnd(size, " "));
		const fetch = vi.fn(async () =>
			Response.json({ status: "success", data: { result: [] } }),
		);
		vi.stubGlobal("fetch", fetch);
		const query = queryOperationsPrometheusV2(
			{
				endpoint: "https://prometheus.example.test",
				basicAuthFile,
				detailDays: 7,
				aggregateDays: 30,
				aggregateStepSeconds: 300,
			},
			"up",
			{ signal: AbortSignal.timeout(1000) },
		);
		if (size <= 16 * 1024) {
			await expect(query).resolves.toEqual({ result: [] });
			expect(fetch).toHaveBeenCalledOnce();
		} else {
			await expect(query).rejects.toThrow(/^OPERATIONS_HISTORY_UNAVAILABLE$/);
			expect(fetch).not.toHaveBeenCalled();
		}
	},
);

it("rejects credentials in diagnostic links while retaining object query filters", async () => {
	for (const kind of ["logs", "traces"] as const) {
		for (const parameter of [
			"password",
			"credential",
			"cookie",
			"session",
			"jwt",
			"access_token",
			"apiKey",
		]) {
			await expect(
				readOperationsConfigurationV2(
					await configuration({
						...configured,
						[kind]: {
							url: `https://diagnostics.example.test/?${parameter}=synthetic`,
						},
					}),
				),
			).rejects.toThrow("OPERATIONS_CONFIGURATION_UNAVAILABLE");
		}
		const url =
			"https://diagnostics.example.test/?namespace=platform-test&agentId=agent-1&sessionId=session-1";
		expect(
			(
				await readOperationsConfigurationV2(
					await configuration({
						...configured,
						[kind]: { url },
					}),
				)
			)?.[kind]?.url,
		).toBe(url);
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
