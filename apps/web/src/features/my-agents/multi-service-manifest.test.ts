import { describe, expect, it } from "vitest";
import {
	formatMultiServiceManifestSummary,
	MULTI_SERVICE_MANIFEST_MAX_BYTES,
	parseMultiServiceManifest,
} from "./multi-service-manifest.js";

const digest = `sha256:${"a".repeat(64)}`;
function deployment(name: string, labels: Record<string, string>) {
	return {
		apiVersion: "apps/v1",
		kind: "Deployment",
		metadata: { name, labels },
		spec: {
			replicas: 1,
			selector: { matchLabels: labels },
			template: {
				metadata: { labels },
				spec: {
					containers: [
						{
							name,
							image: digest,
							ports: [{ name: "http", port: 8080, targetPort: 8080 }],
						},
					],
				},
			},
		},
	};
}

function service(
	name: string,
	selector: Record<string, string>,
	annotations: Record<string, string> = {},
) {
	return {
		apiVersion: "v1",
		kind: "Service",
		metadata: { name, labels: selector, annotations },
		spec: {
			type: "ClusterIP",
			selector,
			ports: [{ name: "http", port: 8080, targetPort: 8080 }],
		},
	};
}

/** JSON is valid YAML, which keeps these fixtures structural instead of indentation-sensitive. */
function document(resources: readonly unknown[], entryServiceName = "api") {
	return JSON.stringify({ schemaVersion: 1, entryServiceName, resources });
}

const valid = [
	deployment("api", { app: "api" }),
	service(
		"api",
		{ app: "api" },
		{
			"agent-infra.agora.io/entry": "true",
			"agent-infra.agora.io/resource-profile": "small",
		},
	),
	deployment("worker", { app: "worker" }),
	service("worker", { app: "worker" }),
];
const manifest = document(valid);

describe("multi-service manifest parsing", () => {
	it("validates YAML and returns a service and entry summary", () => {
		const result = parseMultiServiceManifest(manifest);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.summary).toEqual({
			entryServiceName: "api",
			resourceCount: 4,
			serviceNames: ["api", "worker"],
			resourceProfileRefs: ["small"],
		});
		expect(formatMultiServiceManifestSummary(result.summary)).toContain(
			"规格引用：small",
		);
	});

	it("rejects malformed and semantically invalid YAML", () => {
		expect(parseMultiServiceManifest("resources: [")).toEqual({
			ok: false,
			message: "多服务 YAML 语法不正确，请检查缩进和字段。",
		});
		const invalid = manifest.replace(
			'"entryServiceName":"api"',
			'"entryServiceName":"worker"',
		);
		const result = parseMultiServiceManifest(invalid);
		expect(result.ok).toBe(false);
		expect(result).toEqual({
			ok: false,
			message:
				"多服务 YAML 不符合受限资源清单格式，请检查资源、入口服务和镜像 Digest。",
		});
	});

	it("rejects a manifest over the contract byte limit before parsing", () => {
		const oversized = `${manifest}\n#${"x".repeat(MULTI_SERVICE_MANIFEST_MAX_BYTES)}`;
		expect(parseMultiServiceManifest(oversized)).toEqual({
			ok: false,
			message: `多服务 YAML 不能超过 ${MULTI_SERVICE_MANIFEST_MAX_BYTES} bytes。`,
		});
	});
	it("tells the applicant which topology rule a schema-valid manifest breaks (#2531)", () => {
		const [api, apiService, worker, workerService] = valid;
		const cases: readonly [string, readonly unknown[], string][] = [
			["a single workload", [api, apiService], "需要 2 到 16 个"],
			[
				"a workload without its Service",
				[api, apiService, worker],
				"Service 的数量必须与工作负载的数量相同",
			],
			[
				"two Jobs",
				[
					...valid,
					{
						apiVersion: "batch/v1",
						kind: "Job",
						metadata: { name: "migrate-a" },
						spec: {
							backoffLimit: 1,
							template: {
								metadata: { labels: { app: "migrate-a" } },
								spec: {
									restartPolicy: "Never",
									containers: [{ name: "migrate", image: digest }],
								},
							},
						},
					},
					{
						apiVersion: "batch/v1",
						kind: "Job",
						metadata: { name: "migrate-b" },
						spec: {
							backoffLimit: 1,
							template: {
								metadata: { labels: { app: "migrate-b" } },
								spec: {
									restartPolicy: "Never",
									containers: [{ name: "migrate", image: digest }],
								},
							},
						},
					},
				],
				"最多只能有 1 个 Job",
			],
			[
				"a Service that selects nothing",
				[api, apiService, worker, service("worker", { app: "missing" })],
				"selector 必须恰好匹配一个工作负载",
			],
			[
				"a Service port the workload does not expose",
				[
					api,
					apiService,
					worker,
					{
						...(workerService as object),
						spec: {
							type: "ClusterIP",
							selector: { app: "worker" },
							ports: [{ name: "http", port: 80, targetPort: 9090 }],
						},
					},
				],
				"targetPort 必须出现在其目标工作负载的容器端口里",
			],
			[
				"two Services for one workload",
				[api, apiService, worker, service("worker", { app: "api" })],
				"每个工作负载只能对应一个 Service",
			],
		];
		for (const [name, resources, expected] of cases) {
			const result = parseMultiServiceManifest(document(resources));
			expect(result.ok, name).toBe(false);
			if (result.ok) continue;
			expect(result.message, name).toContain("服务拓扑不符合要求");
			expect(result.message, name).toContain(expected);
		}
	});

	it("covers every StatefulSet storage and service rule with its own hint", () => {
		const stateful = (
			serviceName: string,
			restartPolicy?: "Always" | "Never",
		) => ({
			...deployment("db", { app: "db" }),
			kind: "StatefulSet",
			spec: {
				...deployment("db", { app: "db" }).spec,
				serviceName,
				template: {
					...deployment("db", { app: "db" }).spec.template,
					spec: {
						...deployment("db", { app: "db" }).spec.template.spec,
						...(restartPolicy ? { restartPolicy } : {}),
					},
				},
			},
		});
		const volume = {
			apiVersion: "v1",
			kind: "PersistentVolumeClaim",
			metadata: { name: "db-data" },
			spec: {
				accessModes: ["ReadWriteOnce"],
				resources: { requests: { storage: "1Gi" } },
			},
		};
		const [api, apiService] = valid;
		const base = [api, apiService, service("db", { app: "db" })];
		expect(
			parseMultiServiceManifest(
				document([...base, stateful("db", "Always"), volume]),
			).ok,
		).toBe(true);
		const messageFor = (resources: readonly unknown[]) => {
			const result = parseMultiServiceManifest(document(resources));
			return result.ok ? "" : result.message;
		};
		expect(messageFor([...base, stateful("db")])).toContain("<名称>-data");
		expect(messageFor([...base, stateful("db", "Never"), volume])).toContain(
			"restartPolicy 只能省略或设为 Always",
		);
		expect(messageFor([...base, stateful("other"), volume])).toContain(
			"与其 serviceName 同名",
		);
	});

	it("accepts a valid manifest without any hint and never mentions image admission", () => {
		const result = parseMultiServiceManifest(manifest);
		expect(result.ok).toBe(true);
		const [api, apiService] = valid;
		const rejected = parseMultiServiceManifest(document([api, apiService]));
		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.message).not.toMatch(/准入|策略|Registry|Digest|镜像/);
	});
});
