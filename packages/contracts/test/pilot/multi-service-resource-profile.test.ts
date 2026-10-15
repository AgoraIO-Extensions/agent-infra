import { describe, expect, it } from "vitest";
import {
	calculateMultiServiceResourceCapacityV1,
	defaultMultiServiceResourceCapV1,
	defaultMultiServiceResourceProfileV1,
	type MultiServiceManifestDocumentV1,
	MultiServiceManifestDocumentV1Schema,
	type MultiServiceProfiledWorkloadV1,
	MultiServiceResourceProfileAnnotationV1,
	MultiServiceResourceProfileV1Schema,
	multiServiceServiceProjectionsV1,
	multiServiceWorkloadProfileRefV1,
	parseMultiServiceResourceConfigurationV1,
} from "../../src/pilot/multi-service.js";

const profile = {
	profileId: "small",
	displayName: "Small",
	estimatedResources: {
		cpuMillicores: 100,
		memoryMiB: 128,
		storageGiB: 1,
	},
	resources: {
		requests: { cpu: "100m", memory: "128Mi" },
		limits: { cpu: "500m", memory: "512Mi" },
	},
} as const;

const large = {
	profileId: "large",
	displayName: "Large",
	estimatedResources: { cpuMillicores: 900, memoryMiB: 1_024, storageGiB: 5 },
	resources: {
		requests: { cpu: "500m", memory: "512Mi" },
		limits: { cpu: "900m", memory: "1Gi" },
	},
	storageSize: "5Gi",
} as const;

const image = `sha256:${"a".repeat(64)}`;

function workload(
	kind: "Deployment" | "StatefulSet",
	name: string,
	annotations?: Record<string, string>,
) {
	return {
		apiVersion: "apps/v1",
		kind,
		metadata: { name, ...(annotations ? { annotations } : {}) },
		spec: {
			replicas: 1,
			...(kind === "StatefulSet" ? { serviceName: name } : {}),
			selector: { matchLabels: { app: name } },
			template: {
				metadata: { labels: { app: name } },
				spec: { containers: [{ name, image }] },
			},
		},
	};
}

function service(name: string, annotations: Record<string, string> = {}) {
	return {
		apiVersion: "v1",
		kind: "Service",
		metadata: {
			name,
			annotations: {
				...(name === "web" ? { "agent-infra.agora.io/entry": "true" } : {}),
				...annotations,
			},
		},
		spec: {
			type: "ClusterIP",
			selector: { app: name },
			ports: [{ name: "http", port: 8080, targetPort: 8080 }],
		},
	};
}

function migrationJob(annotations?: Record<string, string>) {
	return {
		apiVersion: "batch/v1",
		kind: "Job",
		metadata: { name: "migrate", ...(annotations ? { annotations } : {}) },
		spec: {
			backoffLimit: 1,
			template: {
				metadata: { labels: { app: "migration" } },
				spec: {
					restartPolicy: "Never",
					containers: [{ name: "migrate", image }],
				},
			},
		},
	};
}

/** 两个服务（web 入口 + worker），可选迁移 Job；annotation 位置由各用例决定。 */
function manifest(
	options: {
		readonly web?: Record<string, string>;
		readonly webService?: Record<string, string>;
		readonly worker?: Record<string, string>;
		readonly workerService?: Record<string, string>;
		readonly job?: Record<string, string> | false;
	} = {},
): MultiServiceManifestDocumentV1 {
	return MultiServiceManifestDocumentV1Schema.parse({
		schemaVersion: 1,
		entryServiceName: "web",
		resources: [
			workload("Deployment", "web", options.web),
			workload("StatefulSet", "worker", options.worker),
			service("web", options.webService),
			service("worker", options.workerService),
			...(options.job === false || options.job === undefined
				? []
				: [migrationJob(options.job)]),
		],
	});
}

function find(
	document: MultiServiceManifestDocumentV1,
	kind: MultiServiceProfiledWorkloadV1["kind"],
): MultiServiceProfiledWorkloadV1 {
	const resource = document.resources.find(
		(candidate): candidate is MultiServiceProfiledWorkloadV1 =>
			candidate.kind === kind,
	);
	if (!resource) throw new Error(`${kind} fixture missing`);
	return resource;
}

const profileAnnotation = (ref: string) => ({
	[MultiServiceResourceProfileAnnotationV1]: ref,
});

describe("multi-service resource profiles", () => {
	it("accepts Kubernetes CPU and memory quantities in their matching fields", () => {
		expect(MultiServiceResourceProfileV1Schema.safeParse(profile).success).toBe(
			true,
		);
	});

	it("rejects CPU and memory quantities with swapped units", () => {
		expect(
			MultiServiceResourceProfileV1Schema.safeParse({
				...profile,
				resources: {
					requests: { cpu: "1Gi", memory: "1m" },
					limits: { cpu: "1Gi", memory: "1m" },
				},
			}).success,
		).toBe(false);
	});

	it("keeps the default profile valid and without a storage tier", () => {
		expect(
			MultiServiceResourceProfileV1Schema.parse(
				defaultMultiServiceResourceProfileV1,
			),
		).toEqual(defaultMultiServiceResourceProfileV1);
		expect(defaultMultiServiceResourceProfileV1).not.toHaveProperty(
			"storageSize",
		);
		expect(defaultMultiServiceResourceCapV1).toEqual({
			cpuMillicores: 2_000,
			memoryMiB: 4_096,
			storageGiB: 20,
		});
	});
});

describe("multi-service resource configuration", () => {
	it("uses the contract defaults when the deployment configures nothing", () => {
		const configuration = parseMultiServiceResourceConfigurationV1({});
		expect(configuration).toEqual({
			profiles: [defaultMultiServiceResourceProfileV1],
			cap: defaultMultiServiceResourceCapV1,
			source: "default",
		});
		// 返回值是副本：调用方修改不会污染共享默认值。
		expect(configuration.profiles[0]).not.toBe(
			defaultMultiServiceResourceProfileV1,
		);
	});

	it("places the default profile first and marks deployment-owned profiles", () => {
		const cap = { cpuMillicores: 500, memoryMiB: 1_024, storageGiB: 2 };
		expect(
			parseMultiServiceResourceConfigurationV1({
				profiles: [profile, large],
				cap,
			}),
		).toEqual({
			profiles: [defaultMultiServiceResourceProfileV1, profile, large],
			cap,
			source: "deployment",
		});
		// 只配置上限时档位仍来自合约默认值。
		expect(parseMultiServiceResourceConfigurationV1({ cap }).source).toBe(
			"default",
		);
	});

	it.each([
		["a duplicate profile ID", { profiles: [profile, profile] }],
		[
			"the reserved default profile ID",
			{ profiles: [{ ...profile, profileId: "default" }] },
		],
		[
			"a schema-invalid profile",
			{ profiles: [{ ...profile, estimatedResources: { cpuMillicores: 0 } }] },
		],
		["an unknown profile field", { profiles: [{ ...profile, replicas: 3 }] }],
		["a non-array profile list", { profiles: { small: profile } }],
		[
			"more than 64 profiles",
			{
				profiles: Array.from({ length: 65 }, (_, index) => ({
					...profile,
					profileId: `profile-${index}`,
				})),
			},
		],
		[
			"a schema-invalid cap",
			{ cap: { cpuMillicores: -1, memoryMiB: 1, storageGiB: 1 } },
		],
		["an incomplete cap", { cap: { cpuMillicores: 1 } }],
	])("rejects %s", (_label, input) => {
		expect(() => parseMultiServiceResourceConfigurationV1(input)).toThrow();
	});
});

describe("multi-service workload profile references", () => {
	it("prefers the workload annotation over its selecting Service", () => {
		const document = manifest({
			web: profileAnnotation("large"),
			webService: profileAnnotation("small"),
		});
		expect(
			multiServiceWorkloadProfileRefV1(document, find(document, "Deployment")),
		).toBe("large");
	});

	it("falls back to the selecting Service annotation, then to default", () => {
		const document = manifest({ workerService: profileAnnotation("small") });
		expect(
			multiServiceWorkloadProfileRefV1(document, find(document, "StatefulSet")),
		).toBe("small");
		expect(
			multiServiceWorkloadProfileRefV1(document, find(document, "Deployment")),
		).toBe(defaultMultiServiceResourceProfileV1.profileId);
	});

	it("reads a migration Job annotation and never inherits from a Service", () => {
		const annotated = manifest({
			webService: profileAnnotation("small"),
			job: profileAnnotation("large"),
		});
		expect(
			multiServiceWorkloadProfileRefV1(annotated, find(annotated, "Job")),
		).toBe("large");
		// Job 的 Pod 标签即使与某个 Service 选择器重合，也不会继承该 Service 的档位。
		const document = MultiServiceManifestDocumentV1Schema.parse({
			...manifest(),
			resources: [
				...manifest({ webService: profileAnnotation("small") }).resources,
				{
					...migrationJob(),
					spec: {
						...migrationJob().spec,
						template: {
							...migrationJob().spec.template,
							metadata: { labels: { app: "web" } },
						},
					},
				},
			],
		});
		expect(
			multiServiceWorkloadProfileRefV1(document, find(document, "Job")),
		).toBe(defaultMultiServiceResourceProfileV1.profileId);
	});

	it("projects each Service with the profile its workload actually uses", () => {
		expect(
			multiServiceServiceProjectionsV1(
				manifest({
					web: profileAnnotation("large"),
					webService: profileAnnotation("small"),
					job: profileAnnotation("large"),
				}),
			),
		).toEqual([
			{ name: "web", resourceProfileRef: "large", entry: true },
			{ name: "worker", resourceProfileRef: "default", entry: false },
		]);
		expect(
			multiServiceServiceProjectionsV1(
				manifest({ workerService: profileAnnotation("small") }),
			),
		).toEqual([
			{ name: "web", resourceProfileRef: "default", entry: true },
			{ name: "worker", resourceProfileRef: "small", entry: false },
		]);
	});

	it("projects a Service that selects no workload from its own annotation", () => {
		const document = MultiServiceManifestDocumentV1Schema.parse({
			schemaVersion: 1,
			entryServiceName: "web",
			resources: [
				workload("Deployment", "web"),
				service("web"),
				{
					...service("orphan", profileAnnotation("small")),
					spec: { ...service("orphan").spec, selector: { app: "none" } },
				},
				service("bare"),
			],
		});
		expect(multiServiceServiceProjectionsV1(document)).toEqual([
			{ name: "web", resourceProfileRef: "default", entry: true },
			{ name: "orphan", resourceProfileRef: "small", entry: false },
			{ name: "bare", resourceProfileRef: "default", entry: false },
		]);
	});
});

describe("multi-service resource capacity", () => {
	it("sums every Deployment, StatefulSet and migration Job once", () => {
		const configuration = parseMultiServiceResourceConfigurationV1({
			profiles: [profile, large],
		});
		expect(
			calculateMultiServiceResourceCapacityV1({
				manifest: manifest({
					webService: profileAnnotation("small"),
					worker: profileAnnotation("large"),
					job: profileAnnotation("small"),
				}),
				configuration,
			}),
		).toEqual({
			ok: true,
			total: { cpuMillicores: 1_100, memoryMiB: 1_280, storageGiB: 7 },
			cap: defaultMultiServiceResourceCapV1,
		});
	});

	it("estimates unannotated workloads with the default profile", () => {
		expect(
			calculateMultiServiceResourceCapacityV1({
				manifest: manifest({ job: {} }),
				configuration: parseMultiServiceResourceConfigurationV1({}),
			}),
		).toMatchObject({
			ok: true,
			total: { cpuMillicores: 300, memoryMiB: 384, storageGiB: 3 },
		});
	});

	it("counts the migration Job toward the cap", () => {
		// 两个服务恰好等于上限；再加迁移 Job 即超限。
		const cap = { cpuMillicores: 200, memoryMiB: 256, storageGiB: 2 };
		const configuration = parseMultiServiceResourceConfigurationV1({ cap });
		expect(
			calculateMultiServiceResourceCapacityV1({
				manifest: manifest(),
				configuration,
			}).ok,
		).toBe(true);
		expect(
			calculateMultiServiceResourceCapacityV1({
				manifest: manifest({ job: {} }),
				configuration,
			}),
		).toEqual({
			ok: false,
			reason: "cap_exceeded",
			total: { cpuMillicores: 300, memoryMiB: 384, storageGiB: 3 },
			cap,
		});
	});

	it.each([
		["CPU", { cpuMillicores: 199, memoryMiB: 4_096, storageGiB: 20 }],
		["memory", { cpuMillicores: 2_000, memoryMiB: 255, storageGiB: 20 }],
		["storage", { cpuMillicores: 2_000, memoryMiB: 4_096, storageGiB: 1 }],
	])("rejects a total that exceeds only the %s cap", (_label, cap) => {
		expect(
			calculateMultiServiceResourceCapacityV1({
				manifest: manifest(),
				configuration: parseMultiServiceResourceConfigurationV1({ cap }),
			}),
		).toMatchObject({ ok: false, reason: "cap_exceeded", cap });
	});

	it("reports an unknown profile reference before summing", () => {
		expect(
			calculateMultiServiceResourceCapacityV1({
				manifest: manifest({ job: profileAnnotation("missing") }),
				// 即使上限极小，未知档位也优先报告，而不是计为超限。
				configuration: parseMultiServiceResourceConfigurationV1({
					cap: { cpuMillicores: 1, memoryMiB: 1, storageGiB: 1 },
				}),
			}),
		).toEqual({ ok: false, reason: "unknown_profile", profileRef: "missing" });
	});
});
