import { describe, expect, it } from "vitest";
import {
	MultiServiceEntryAnnotationV1,
	MultiServiceManifestDocumentV1Schema,
	MultiServiceMaxWorkloadsV1,
	MultiServiceTopologyIssueCodesV1,
	type MultiServiceTopologyIssueCodeV1,
	multiServiceTopologyIssuesV1,
} from "./index.ts";

const digest = `sha256:${"a".repeat(64)}`;
const ports = [{ name: "http", port: 8080, targetPort: 8080 }];

type Raw = Record<string, unknown>;

function workload(
	name: string,
	options: {
		readonly kind?: "Deployment" | "StatefulSet";
		readonly labels?: Record<string, string>;
		readonly containerPorts?: typeof ports;
		readonly serviceName?: string;
		readonly restartPolicy?: "Always" | "Never";
	} = {},
): Raw {
	const labels = options.labels ?? { app: name };
	const kind = options.kind ?? "Deployment";
	return {
		apiVersion: "apps/v1",
		kind,
		metadata: { name },
		spec: {
			replicas: 1,
			selector: { matchLabels: labels },
			...(kind === "StatefulSet"
				? { serviceName: options.serviceName ?? name }
				: {}),
			template: {
				metadata: { labels },
				spec: {
					containers: [
						{ name, image: digest, ports: options.containerPorts ?? ports },
					],
					...(options.restartPolicy
						? { restartPolicy: options.restartPolicy }
						: {}),
				},
			},
		},
	};
}

function service(
	name: string,
	options: {
		readonly entry?: boolean;
		readonly selector?: Record<string, string>;
		readonly ports?: typeof ports;
	} = {},
): Raw {
	return {
		apiVersion: "v1",
		kind: "Service",
		metadata: {
			name,
			...(options.entry
				? { annotations: { [MultiServiceEntryAnnotationV1]: "true" } }
				: {}),
		},
		spec: {
			type: "ClusterIP",
			selector: options.selector ?? { app: name },
			ports: options.ports ?? ports,
		},
	};
}

function storage(name: string): Raw {
	return {
		apiVersion: "v1",
		kind: "PersistentVolumeClaim",
		metadata: { name },
		spec: {
			accessModes: ["ReadWriteOnce"],
			resources: { requests: { storage: "1Gi" } },
		},
	};
}

function job(name: string): Raw {
	return {
		apiVersion: "batch/v1",
		kind: "Job",
		metadata: { name },
		spec: {
			backoffLimit: 1,
			template: {
				metadata: { labels: { app: name } },
				spec: {
					restartPolicy: "Never",
					containers: [{ name, image: digest }],
				},
			},
		},
	};
}

/** The shared seam receives documents the manifest schema already accepted. */
function issues(resources: readonly Raw[]) {
	return multiServiceTopologyIssuesV1(
		MultiServiceManifestDocumentV1Schema.parse({
			schemaVersion: 1,
			entryServiceName: "web",
			resources,
		}),
	);
}

const web = () => [workload("web"), service("web", { entry: true })];
const api = () => [workload("api"), service("api")];

/** One document per rule: the code it must report and nothing else. */
const violations: readonly {
	readonly name: string;
	readonly resources: readonly Raw[];
	readonly expected: readonly MultiServiceTopologyIssueCodeV1[];
}[] = [
	{
		name: "a single workload",
		resources: web(),
		expected: ["workload_count"],
	},
	{
		name: "more workloads than the admission bound",
		resources: [
			...web(),
			...Array.from({ length: MultiServiceMaxWorkloadsV1 }, (_, index) => [
				workload(`extra-${index}`),
				service(`extra-${index}`),
			]).flat(),
		],
		expected: ["workload_count"],
	},
	{
		name: "a workload without its Service",
		resources: [...web(), workload("api")],
		expected: ["service_count"],
	},
	{
		name: "a Service without a workload",
		resources: [...web(), ...api(), service("extra")],
		expected: ["service_count"],
	},
	{
		name: "two Jobs",
		resources: [...web(), ...api(), job("migrate-a"), job("migrate-b")],
		expected: ["job_count"],
	},
	{
		name: "a StatefulSet whose serviceName names another Service",
		resources: [
			...web(),
			workload("db", { kind: "StatefulSet", serviceName: "web" }),
			service("db"),
			storage("db-data"),
		],
		expected: ["stateful_service"],
	},
	{
		name: "a StatefulSet that never restarts",
		resources: [
			...web(),
			workload("db", { kind: "StatefulSet", restartPolicy: "Never" }),
			service("db"),
			storage("db-data"),
		],
		expected: ["stateful_restart_policy"],
	},
	{
		name: "a StatefulSet without its <name>-data PVC",
		resources: [
			...web(),
			workload("db", { kind: "StatefulSet" }),
			service("db"),
		],
		expected: ["stateful_storage"],
	},
	{
		name: "a PVC that no StatefulSet owns",
		resources: [...web(), ...api(), storage("scratch-data")],
		expected: ["stateful_storage"],
	},
	{
		name: "a Service whose selector matches no workload",
		resources: [
			...web(),
			workload("api"),
			service("api", { selector: { app: "missing" } }),
		],
		expected: ["service_selector"],
	},
	{
		name: "a Service whose selector matches two workloads",
		resources: [
			workload("web", { labels: { tier: "app" } }),
			workload("api", { labels: { tier: "app" } }),
			service("web", { entry: true, selector: { tier: "app" } }),
			service("api", { selector: { tier: "app" } }),
		],
		expected: ["service_selector"],
	},
	{
		name: "a Service port that the workload does not expose",
		resources: [
			...web(),
			workload("api"),
			service("api", {
				ports: [{ name: "http", port: 80, targetPort: 9090 }],
			}),
		],
		expected: ["service_port"],
	},
	{
		name: "two Services that target the same workload",
		resources: [
			workload("web"),
			workload("api"),
			service("web", { entry: true }),
			service("api", { selector: { app: "web" } }),
		],
		expected: ["service_target_shared"],
	},
	{
		name: "several rules at once, in the stable code order",
		resources: [...web(), job("migrate-a"), job("migrate-b")],
		expected: ["workload_count", "job_count"],
	},
	{
		name: "a count mismatch, which hides the follow-up selector findings",
		resources: [
			...web(),
			workload("api"),
			service("lonely", { selector: { app: "missing" } }),
			service("extra", { selector: { app: "missing" } }),
		],
		expected: ["service_count"],
	},
];

describe("multi-service topology rules (#2531)", () => {
	it("accepts the supported shapes", () => {
		expect(issues([...web(), ...api()])).toEqual([]);
		expect(
			issues([
				...web(),
				workload("db", { kind: "StatefulSet", restartPolicy: "Always" }),
				service("db"),
				storage("db-data"),
				job("migrate"),
			]),
		).toEqual([]);
		expect(
			issues(
				Array.from({ length: MultiServiceMaxWorkloadsV1 }, (_, index) => [
					workload(index === 0 ? "web" : `svc-${index}`),
					service(index === 0 ? "web" : `svc-${index}`, {
						entry: index === 0,
					}),
				]).flat(),
			),
		).toEqual([]);
	});

	it.each(violations)(
		"reports $expected for $name",
		({ resources, expected }) => {
			expect(issues(resources)).toEqual(expected);
		},
	);

	it("gives every published code at least one violating document", () => {
		const seen = new Set(violations.flatMap(({ expected }) => expected));
		expect([...seen].sort()).toEqual(
			[...MultiServiceTopologyIssueCodesV1].sort(),
		);
	});

	it("keeps the published code list stable", () => {
		expect(MultiServiceTopologyIssueCodesV1).toEqual([
			"workload_count",
			"service_count",
			"job_count",
			"stateful_service",
			"stateful_restart_policy",
			"stateful_storage",
			"service_selector",
			"service_port",
			"service_target_shared",
		]);
	});

	it("never puts manifest content into the findings", () => {
		for (const { resources } of violations)
			expect(JSON.stringify(issues(resources))).not.toMatch(
				/sha256|app|8080|migrate|scratch/,
			);
	});
});
