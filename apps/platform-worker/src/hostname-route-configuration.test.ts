import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	bindHostnameRouteConfigurationV1,
	hostnameRouteConfigurationPlanV1,
	parseHostnameRouteConfigurationV1,
	readHostnameRouteConfigurationV1,
	serializeHostnameRouteConfigurationV1,
} from "./hostname-route-configuration.js";

const declaration = {
	schemaVersion: 1,
	enabled: true,
	namespace: "workload-test",
	hostnameRoutes: {
		hostSuffix: "apps.example.test",
		platformOrigin: "https://platform.example.test",
		clusterIssuerName: "letsencrypt-http01-staging",
		agentIds: ["agent-a"],
	},
};

describe("trusted hostname configuration projection", () => {
	it("publishes one exact per-Agent plan without claiming field acceptance", () => {
		const plan = hostnameRouteConfigurationPlanV1(declaration);
		expect(plan).toMatchObject({
			status: "planned",
			fieldMutated: false,
			certificateIssued: false,
			businessVerified: false,
			bindings: [
				{
					agentId: "agent-a",
					namespace: "workload-test",
					origin:
						"https://agent-a51d7389ba2cb760d233154216317fce.apps.example.test",
					path: "/",
					certificateName: "agent-a51d7389ba2cb760d233154216317fce-tls",
					tlsSecretName: "agent-a51d7389ba2cb760d233154216317fce-tls",
					issuerRef: {
						kind: "ClusterIssuer",
						name: "letsencrypt-http01-staging",
					},
				},
			],
		});
		expect(plan.bindings).toHaveLength(1);
	});
	it("keeps disabled or absent inputs off and rejects an explicitly missing input", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hostname-configuration-"));
		try {
			const file = join(directory, "missing.json");
			expect(
				readHostnameRouteConfigurationV1({ file, required: false }),
			).toBeUndefined();
			expect(() =>
				readHostnameRouteConfigurationV1({ file, required: true }),
			).toThrow("HOSTNAME_ROUTE_CONFIGURATION_MISSING");
			const policy = {
				namespace: "workload-test",
				routeHostSuffix: "legacy.example.test",
				tlsSecretName: "legacy-tls",
			};
			expect(bindHostnameRouteConfigurationV1(policy, undefined)).toBe(policy);
			expect(
				bindHostnameRouteConfigurationV1(policy, {
					schemaVersion: 1,
					enabled: false,
				}),
			).toBe(policy);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("records the original file bytes separately from canonical serialization", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hostname-bytes-"));
		try {
			const file = join(directory, "hostname-routes.json");
			await writeFile(file, ' { "enabled":false, "schemaVersion":1 }\n');
			const source = readHostnameRouteConfigurationV1({ file, required: true });
			expect(source).toEqual({
				configuration: { schemaVersion: 1, enabled: false },
				sha256:
					"0ce63e3d7b7f88c53d4d43de8769ee576df59a794da0f9cbfbae2f5eb696776e",
			});
			expect(serializeHostnameRouteConfigurationV1(source?.configuration)).toBe(
				'{\n  "schemaVersion": 1,\n  "enabled": false\n}\n',
			);
			await writeFile(
				file,
				'{"schemaVersion":1,"enabled":true,"token":"forbidden"}',
			);
			expect(() =>
				readHostnameRouteConfigurationV1({ file, required: true }),
			).toThrow("HOSTNAME_ROUTE_CONFIGURATION_INVALID");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it.each([
		{ ...declaration, schemaVersion: 2 },
		{ ...declaration, enabled: false },
		{ ...declaration, routeHostSuffix: "overwrite.example.test" },
		{
			...declaration,
			hostnameRoutes: {
				...declaration.hostnameRoutes,
				tlsSecretName: "shared",
			},
		},
		{
			...declaration,
			hostnameRoutes: {
				...declaration.hostnameRoutes,
				agentIds: ["agent-a", "agent-a"],
			},
		},
	])("rejects a noncanonical deployment declaration: %o", (value) => {
		expect(() => parseHostnameRouteConfigurationV1(value)).toThrow();
	});
	it("rejects a DNS-looking suffix that cannot form a canonical HTTPS host", () => {
		expect(() =>
			parseHostnameRouteConfigurationV1({
				...declaration,
				hostnameRoutes: {
					...declaration.hostnameRoutes,
					hostSuffix: "example.123",
				},
			}),
		).toThrow("HOSTNAME_ROUTE_CONFIGURATION_INVALID");
	});
	it("rejects wrong namespace, inline conflicts and shared-path overlap", () => {
		const current = {
			namespace: "workload-test",
			routeHostSuffix: "legacy.example.test",
			tlsSecretName: "legacy-tls",
		};
		const configuration = parseHostnameRouteConfigurationV1(declaration);
		expect(() =>
			bindHostnameRouteConfigurationV1(
				{ ...current, namespace: "foreign" },
				configuration,
			),
		).toThrow();
		expect(() =>
			bindHostnameRouteConfigurationV1(
				{
					...current,
					hostnameRoutes: {
						...declaration.hostnameRoutes,
						hostSuffix: "foreign.example.test",
					},
				},
				configuration,
			),
		).toThrow();
		expect(() =>
			bindHostnameRouteConfigurationV1(
				{
					...current,
					pathRoutes: {
						origin: "https://shared.example.test",
						platformOrigin: "https://platform.example.test",
						tlsSecretName: "shared",
						agentIds: ["agent-a"],
					},
				},
				configuration,
			),
		).toThrow();
		expect(() =>
			bindHostnameRouteConfigurationV1(
				{ ...current, hostnameRoutes: declaration.hostnameRoutes },
				{ schemaVersion: 1, enabled: false },
			),
		).toThrow();
	});
	it("adds only the scoped policy and preserves every legacy setting", () => {
		const legacy = {
			namespace: "workload-test",
			routeHostSuffix: "legacy.example.test",
			tlsSecretName: "legacy-tls",
			untouched: { value: true },
		};
		const result = bindHostnameRouteConfigurationV1(
			legacy,
			parseHostnameRouteConfigurationV1(declaration),
		);
		expect(result).toMatchObject({
			routeHostSuffix: "legacy.example.test",
			tlsSecretName: "legacy-tls",
			hostnameRoutes: declaration.hostnameRoutes,
		});
		expect(result.untouched).toBe(legacy.untouched);
		expect(legacy).not.toHaveProperty("hostnameRoutes");
	});
});

it("producer CLI writes canonical local artifacts and refuses to overwrite a prior plan", async () => {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const { readFile } = await import("node:fs/promises");
	const run = promisify(execFile);
	const directory = await mkdtemp(join(tmpdir(), "hostname-producer-"));
	try {
		const input = join(directory, "input.json");
		const output = join(directory, "generated");
		await writeFile(input, JSON.stringify(declaration));
		const entry = new URL(
			"../dist/hostnameRouteConfiguration.mjs",
			import.meta.url,
		).pathname;
		const result = await run(process.execPath, [entry, input, output], {
			env: { ...process.env, KUBECONFIG: join(directory, "must-not-load") },
		});
		expect(JSON.parse(result.stdout)).toMatchObject({
			status: "planned",
			fieldMutated: false,
		});
		expect(await readFile(join(output, "hostname-routes.json"), "utf8")).toBe(
			serializeHostnameRouteConfigurationV1(declaration),
		);
		expect(
			JSON.parse(
				await readFile(join(output, "hostname-routes-plan.json"), "utf8"),
			),
		).toMatchObject({ certificateIssued: false, businessVerified: false });
		await expect(
			run(process.execPath, [entry, input, output]),
		).rejects.toThrow();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("published schema and runtime agree on strict declaration shapes", () => {
	const require = createRequire(
		new URL("../../../packages/contracts/package.json", import.meta.url),
	);
	const Ajv = require("ajv");
	const schema = JSON.parse(
		readFileSync(
			new URL(
				"../../../deploy/ack/hostname-route-configuration.schema.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const validate = new Ajv({ strict: true }).compile(schema);
	const fixtures: [unknown, boolean][] = [
		[declaration, true],
		[{ schemaVersion: 1, enabled: false }, true],
		[{ ...declaration, enabled: false }, false],
		[{ ...declaration, namespace: "foreign/name" }, false],
		[{ ...declaration, unknown: "value" }, false],
		[
			{
				...declaration,
				hostnameRoutes: {
					...declaration.hostnameRoutes,
					tlsSecretName: "shared",
				},
			},
			false,
		],
		...[
			"*.example.test",
			"example.123",
			"127.0.0.1",
			"https://example.test",
			"UPPER.example.test",
		].map(
			(hostSuffix) =>
				[
					{
						...declaration,
						hostnameRoutes: { ...declaration.hostnameRoutes, hostSuffix },
					},
					false,
				] as [unknown, boolean],
		),
		...[
			"http://platform.example.test",
			"https://platform.example.test/",
			"https://platform.example.test:443",
			"https://platform.123",
		].map(
			(platformOrigin) =>
				[
					{
						...declaration,
						hostnameRoutes: { ...declaration.hostnameRoutes, platformOrigin },
					},
					false,
				] as [unknown, boolean],
		),
	];
	for (const [value, expected] of fixtures) {
		expect(validate(value), JSON.stringify(validate.errors)).toBe(expected);
		if (expected)
			expect(() => parseHostnameRouteConfigurationV1(value)).not.toThrow();
		else expect(() => parseHostnameRouteConfigurationV1(value)).toThrow();
	}
});
