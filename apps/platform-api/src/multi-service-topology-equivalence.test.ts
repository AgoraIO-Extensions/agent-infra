import {
	MultiServiceEntryAnnotationV1,
	MultiServiceManifestDocumentV1Schema,
	MultiServiceMaxWorkloadsV1,
	MultiServiceTopologyIssueCodesV1,
	multiServiceTopologyIssuesV1,
} from "@agent-infra/contracts/pilot";
import { describe, expect, it } from "vitest";

type Manifest = ReturnType<typeof MultiServiceManifestDocumentV1Schema.parse>;

/**
 * 迁移到共享函数之前 `deployment-admissions.ts` 里的判定，原样保留作为对照基准（#2531）。
 * 共享函数必须与它接受/拒绝同一批清单。
 */
function legacyValidMultiServiceTopology(manifest: Manifest): boolean {
	const deployments = manifest.resources.filter(
		(resource) => resource.kind === "Deployment",
	);
	const statefulSets = manifest.resources.filter(
		(resource) => resource.kind === "StatefulSet",
	);
	const services = manifest.resources.filter(
		(resource) => resource.kind === "Service",
	);
	const jobs = manifest.resources.filter((resource) => resource.kind === "Job");
	const pvcs = manifest.resources.filter(
		(resource) => resource.kind === "PersistentVolumeClaim",
	);
	const workloads = [...deployments, ...statefulSets];
	const pvcNames = new Set(pvcs.map((resource) => resource.metadata.name));
	const statefulTopologyValid = statefulSets.every(
		(resource) =>
			(resource.spec.template.spec.restartPolicy === undefined ||
				resource.spec.template.spec.restartPolicy === "Always") &&
			services.some(
				(service) =>
					service.metadata.name === resource.spec.serviceName &&
					Object.entries(service.spec.selector).every(
						([key, expected]) =>
							resource.spec.template.metadata.labels[key] === expected,
					),
			) &&
			pvcNames.has(`${resource.metadata.name}-data`),
	);
	const expectedPvcNames = new Set(
		statefulSets.map((resource) => `${resource.metadata.name}-data`),
	);
	if (
		workloads.length < 2 ||
		workloads.length > MultiServiceMaxWorkloadsV1 ||
		services.length !== workloads.length ||
		new Set(services.map((service) => service.metadata.name)).size !==
			services.length ||
		statefulSets.length !== pvcs.length ||
		!statefulTopologyValid ||
		pvcs.some((pvc) => !expectedPvcNames.has(pvc.metadata.name)) ||
		jobs.length > 1 ||
		manifest.resources.some(
			(resource) =>
				resource.kind !== "Deployment" &&
				resource.kind !== "StatefulSet" &&
				resource.kind !== "Service" &&
				resource.kind !== "PersistentVolumeClaim" &&
				resource.kind !== "Job" &&
				resource.kind !== "ConfigMap",
		)
	)
		return false;
	const targets = services.map((service) => {
		const matches = workloads.filter((workload) =>
			Object.entries(service.spec.selector).every(
				([key, expected]) =>
					workload.spec.template.metadata.labels[key] === expected,
			),
		);
		if (matches.length !== 1) return null;
		const target = matches[0];
		if (!target) return null;
		return service.spec.ports.every((servicePort) =>
			target.spec.template.spec.containers.some((container) =>
				container.ports?.some(
					(containerPort) =>
						containerPort.targetPort === servicePort.targetPort,
				),
			),
		)
			? target.metadata.name
			: null;
	});
	return (
		targets.every((target): target is string => target !== null) &&
		new Set(targets).size === workloads.length &&
		statefulSets.every((statefulSet) =>
			targets.includes(statefulSet.metadata.name),
		)
	);
}

/** 固定种子的伪随机数，保证每次生成同一批清单。 */
function random(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const digest = `sha256:${"a".repeat(64)}`;
const portsOf = (target: number) => [
	{ name: "http", port: 8080, targetPort: target },
];

function generated(next: () => number) {
	const pick = <T>(values: readonly T[]) =>
		values[Math.floor(next() * values.length)] as T;
	// 噪声档位：0 生成合法清单，较小的噪声生成「只差一处」的清单，较大的噪声生成乱序组合。
	const noise = pick([0, 0, 0, 0.04, 0.04, 0.04, 0.2]);
	const chance = (probability: number) => next() < probability;
	const good = (probability: number) => !chance(noise * (1 - probability) * 4);
	const workloadCount = chance(0.08) ? 1 : 2 + Math.floor(next() * 4);
	const sharedLabels = chance(noise);
	const workloads = Array.from({ length: workloadCount }, (_, index) => {
		const stateful = chance(0.4);
		// 偶尔让 Deployment 与 StatefulSet 同名：资源 identity 不同，schema 允许。
		const name = stateful && index > 0 && chance(noise) ? "w0" : `w${index}`;
		return {
			name,
			stateful,
			labels: sharedLabels ? { tier: "x" } : { app: name },
		};
	});
	const resources: Record<string, unknown>[] = [];
	for (const workload of workloads) {
		resources.push({
			apiVersion: "apps/v1",
			kind: workload.stateful ? "StatefulSet" : "Deployment",
			metadata: { name: workload.name },
			spec: {
				replicas: 1,
				selector: { matchLabels: workload.labels },
				...(workload.stateful
					? {
							serviceName: good(0.5) ? workload.name : pick(workloads).name,
						}
					: {}),
				template: {
					metadata: { labels: workload.labels },
					spec: {
						containers: [
							{
								name: "main",
								image: digest,
								ports: portsOf(good(0.5) ? 8080 : 9090),
							},
						],
						...(workload.stateful
							? {
									restartPolicy: good(0.5)
										? pick([undefined, "Always"])
										: "Never",
								}
							: {}),
					},
				},
			},
		});
		if (workload.stateful && good(0.5))
			resources.push({
				apiVersion: "v1",
				kind: "PersistentVolumeClaim",
				metadata: { name: `${workload.name}-data` },
				spec: {
					accessModes: ["ReadWriteOnce"],
					resources: { requests: { storage: "1Gi" } },
				},
			});
	}
	if (chance(noise))
		resources.push({
			apiVersion: "v1",
			kind: "PersistentVolumeClaim",
			metadata: { name: "stray-data" },
			spec: {
				accessModes: ["ReadWriteOnce"],
				resources: { requests: { storage: "1Gi" } },
			},
		});
	const serviceCount = Math.max(
		1,
		workloadCount + (good(0.5) ? 0 : pick([-1, 1])),
	);
	for (let index = 0; index < serviceCount; index++) {
		const target = workloads[index % workloads.length];
		resources.push({
			apiVersion: "v1",
			kind: "Service",
			metadata: {
				// 与目标工作负载同名，StatefulSet 的 serviceName 才有机会指向它；多出来的 Service 用单独的名字。
				name:
					index < workloadCount ? (target?.name ?? `s${index}`) : `s${index}`,
				...(index === 0
					? { annotations: { [MultiServiceEntryAnnotationV1]: "true" } }
					: {}),
			},
			spec: {
				type: "ClusterIP",
				selector: good(0.5)
					? (target?.labels ?? { app: "missing" })
					: pick([{ app: "missing" }, { app: "w0" }]),
				ports: portsOf(good(0.5) ? 8080 : 9090),
			},
		});
	}
	const jobCount = good(0.5) ? pick([0, 0, 1, 1]) : 2;
	for (let index = 0; index < jobCount; index++)
		resources.push({
			apiVersion: "batch/v1",
			kind: "Job",
			metadata: { name: `job${index}` },
			spec: {
				backoffLimit: 1,
				template: {
					metadata: { labels: { app: `job${index}` } },
					spec: {
						restartPolicy: "Never",
						containers: [{ name: "job", image: digest }],
					},
				},
			},
		});
	return {
		schemaVersion: 1,
		entryServiceName: workloads[0]?.name ?? "s0",
		resources,
	};
}

describe("shared multi-service topology rules match the former admission check (#2531)", () => {
	it("accepts and rejects the same generated manifests", () => {
		const next = random(2531);
		const seen = new Set<string>();
		let accepted = 0;
		let acceptedStateful = 0;
		let acceptedJob = 0;
		let rejected = 0;
		let parsed = 0;
		for (let index = 0; index < 4_000; index++) {
			const result = MultiServiceManifestDocumentV1Schema.safeParse(
				generated(next),
			);
			if (!result.success) continue;
			parsed++;
			const issues = multiServiceTopologyIssuesV1(result.data);
			const legacy = legacyValidMultiServiceTopology(result.data);
			expect(issues.length === 0, JSON.stringify(result.data)).toBe(legacy);
			if (legacy) {
				accepted++;
				if (
					result.data.resources.some(
						(resource) => resource.kind === "StatefulSet",
					)
				)
					acceptedStateful++;
				if (result.data.resources.some((resource) => resource.kind === "Job"))
					acceptedJob++;
			} else rejected++;
			for (const code of issues) seen.add(code);
		}
		// 生成器必须真的覆盖两侧和每一条规则，否则这条对照测试什么也证明不了。
		expect(parsed).toBeGreaterThan(1_000);
		expect(accepted).toBeGreaterThan(300);
		expect(acceptedStateful).toBeGreaterThan(100);
		expect(acceptedJob).toBeGreaterThan(100);
		expect(rejected).toBeGreaterThan(500);
		expect([...seen].sort()).toEqual(
			[...MultiServiceTopologyIssueCodesV1].sort(),
		);
	});
});
