import {
	type OperationsQuantitiesV2,
	type OperationsResourcesV2,
	OperationsResourcesV2Schema,
	type OperationsResourceV2,
} from "@agent-infra/contracts/pilot";
import {
	emptyOperationsResourcesV2,
	type OperationsBindingV2,
	quantityRatioV1,
} from "@agent-infra/platform-core";
import { serviceResourceName } from "./multi-service-runtime.js";
import { sessionSandboxLabelsV1 } from "./session-workload-adapter.js";

export const operationsReadKindsV2 = [
	"pods",
	"volumes",
	"deployments",
	"statefulsets",
	"replicasets",
	"events",
	"quotas",
	"podMetrics",
	"nodes",
	"nodeMetrics",
	"imageCaches",
] as const;
export type OperationsReadKindV2 = (typeof operationsReadKindsV2)[number];
type ObjectRecord = Record<string, unknown>;
const objectKinds: Record<OperationsReadKindV2, string> = {
	pods: "Pod",
	volumes: "PersistentVolumeClaim",
	deployments: "Deployment",
	statefulsets: "StatefulSet",
	replicasets: "ReplicaSet",
	events: "Event",
	quotas: "ResourceQuota",
	podMetrics: "PodMetrics",
	nodes: "Node",
	nodeMetrics: "NodeMetrics",
	imageCaches: "ImageCache",
};
const object = (value: unknown): ObjectRecord =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as ObjectRecord)
		: {};
const list = (value: unknown): ObjectRecord[] =>
	Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown, max = 256): string | null =>
	typeof value === "string" && value.length > 0 && value.length <= max
		? value
		: null;
const integer = (value: unknown): number | null =>
	Number.isSafeInteger(Number(value)) &&
	value !== undefined &&
	value !== null &&
	Number(value) >= 0
		? Number(value)
		: null;
const allowedReasons = new Set([
	"Unknown",
	"Ready",
	"Pending",
	"Bound",
	"Running",
	"Succeeded",
	"Failed",
	"Terminating",
	"Available",
	"InProgress",
	"Error",
	"Completed",
	"ContainerCreating",
	"PodInitializing",
	"CrashLoopBackOff",
	"ImagePullBackOff",
	"ErrImagePull",
	"InvalidImageName",
	"CreateContainerConfigError",
	"CreateContainerError",
	"RunContainerError",
	"OOMKilled",
	"Unschedulable",
	"Evicted",
	"DeadlineExceeded",
	"Scheduled",
	"FailedScheduling",
	"Pulling",
	"Pulled",
	"Created",
	"Started",
	"BackOff",
	"FailedMount",
	"FailedAttachVolume",
	"FailedCreate",
	"FailedCreatePodSandBox",
	"Unhealthy",
	"Killing",
	"OOMKilling",
	"SuccessfulHitImageCache",
	"ImageCacheNotFullMatch",
	"ImageCacheAutoCreated",
	"ImageCacheAutoEliminated",
]);
const reason = (value: unknown) =>
	typeof value === "string" && allowedReasons.has(value) ? value : null;
const date = (value: unknown) => {
	const valueText = value instanceof Date ? value.toISOString() : text(value);
	return valueText && Number.isFinite(Date.parse(valueText))
		? new Date(valueText).toISOString()
		: null;
};
const metadata = (value: ObjectRecord) => object(value.metadata);
const empty = (): OperationsQuantitiesV2 => ({
	cpuCores: null,
	memoryBytes: null,
	storageBytes: null,
	ephemeralStorageBytes: null,
});
function quantity(value: unknown, bytes = false): number | null {
	if (typeof value !== "string" && typeof value !== "number") return null;
	const ratio = quantityRatioV1(String(value));
	if (!ratio || ratio[0] < 0n) return null;
	const result = Number(ratio[0]) / Number(ratio[1]);
	return Number.isFinite(result) &&
		result <= Number.MAX_SAFE_INTEGER &&
		(!bytes || Number.isSafeInteger(result))
		? result
		: null;
}
function quantities(value: unknown): OperationsQuantitiesV2 {
	const values = object(value);
	return {
		cpuCores: quantity(values.cpu),
		memoryBytes: quantity(values.memory, true),
		storageBytes: quantity(values.storage, true),
		ephemeralStorageBytes: quantity(values["ephemeral-storage"], true),
	};
}
function sum(
	values: readonly OperationsQuantitiesV2[],
): OperationsQuantitiesV2 {
	const result = empty();
	for (const key of Object.keys(result) as (keyof OperationsQuantitiesV2)[])
		if (values.length && values.every((value) => value[key] !== null)) {
			const total = values.reduce(
				(value, current) => value + (current[key] ?? 0),
				0,
			);
			result[key] =
				key === "cpuCores"
					? Math.round(total * 1e9) / 1e9
					: Number.isSafeInteger(total)
						? total
						: null;
		}
	return result;
}
function declaredResources(
	spec: ObjectRecord,
	kind: "requests" | "limits",
): OperationsQuantitiesV2 {
	const app = sum(
		list(spec.containers).map((container) =>
			quantities(object(container.resources)[kind]),
		),
	);
	const init = list(spec.initContainers).map((container) =>
		quantities(object(container.resources)[kind]),
	);
	const overhead = quantities(spec.overhead);
	for (const key of [
		"cpuCores",
		"memoryBytes",
		"ephemeralStorageBytes",
	] as const) {
		if (app[key] === null || init.some((entry) => entry[key] === null)) {
			app[key] = null;
			continue;
		}
		app[key] =
			Math.max(app[key], ...init.map((entry) => entry[key] ?? 0)) +
			(overhead[key] ?? 0);
	}
	return app;
}
function controllingOwner(value: ObjectRecord): ObjectRecord | null {
	const owners = list(metadata(value).ownerReferences).filter(
		(owner) => owner.controller === true,
	);
	return owners.length === 1 ? (owners[0] ?? null) : null;
}

/** Reads only deployed control-plane facts; free-form messages and environment values never leave this projection. */
export async function collectOperationsSnapshotV2(input: {
	scope: OperationsResourcesV2["scope"];
	readCluster: boolean;
	intervalSeconds?: number;
	cacheOwner: string;
	cacheInventoryLimit: number;
	bindings: readonly OperationsBindingV2[];
	read: (
		kind: OperationsReadKindV2,
		signal: AbortSignal,
	) => Promise<{ items: unknown[]; truncated: boolean }>;
	signal?: AbortSignal;
	now?: () => string;
}): Promise<OperationsResourcesV2> {
	const signal = AbortSignal.any([
		input.signal ?? new AbortController().signal,
		AbortSignal.timeout(15_000),
	]);
	const startedAt = (input.now ?? (() => new Date().toISOString()))();
	const snapshot = emptyOperationsResourcesV2(input.scope, startedAt);
	snapshot.refreshSeconds = input.intervalSeconds ?? 30;
	const loaded = new Map<OperationsReadKindV2, ObjectRecord[]>();
	const failed = new Set<OperationsReadKindV2>();
	const readKind = async (kind: OperationsReadKindV2) => {
		if (
			!input.readCluster &&
			["nodes", "nodeMetrics", "imageCaches"].includes(kind)
		)
			return;
		try {
			const result = await input.read(kind, signal);
			if (!Array.isArray(result.items) || result.items.length > 2000)
				throw new Error();
			const entries = result.items.map(object);
			if (
				entries.some(
					(entry) =>
						entry.kind !== undefined && entry.kind !== objectKinds[kind],
				)
			)
				throw new Error();
			loaded.set(
				kind,
				entries.map((entry) => ({ ...entry, kind: objectKinds[kind] })),
			);
			failed.delete(kind);
			snapshot.truncated ||= result.truncated;
		} catch {
			loaded.delete(kind);
			failed.add(kind);
		}
	};
	const identityKinds: OperationsReadKindV2[] = [
		"pods",
		"volumes",
		...(input.readCluster ? ["nodes" as const] : []),
	];
	await Promise.all(identityKinds.map(readKind));
	const initial = new Map(
		identityKinds.map((kind) => [kind, loaded.get(kind) ?? []]),
	);
	await Promise.all(
		operationsReadKindsV2
			.filter((kind) => !identityKinds.includes(kind))
			.map(readKind),
	);
	await Promise.all(identityKinds.map(readKind));
	const identityObservedAt = (input.now ?? (() => new Date().toISOString()))();
	const now = identityObservedAt;
	snapshot.generatedAt = now;
	const stableIdentity = (kind: OperationsReadKindV2, value: ObjectRecord) =>
		(initial.get(kind) ?? []).some(
			(earlier) =>
				metadata(earlier).uid === metadata(value).uid &&
				metadata(earlier).name === metadata(value).name &&
				metadata(earlier).namespace === metadata(value).namespace,
		);

	const source = (
		kind: OperationsResourcesV2["sources"][number]["kind"],
		reads: OperationsReadKindV2[],
	) => {
		const index = snapshot.sources.findIndex((value) => value.kind === kind);
		const available = reads.every((read) => loaded.has(read));
		if (reads.every((read) => !loaded.has(read) && !failed.has(read))) return;
		snapshot.sources[index] = {
			kind,
			state: available ? "available" : "unavailable",
			observedAt: available ? now : null,
			windowSeconds: null,
			reason: available
				? snapshot.truncated
					? "TRUNCATED"
					: null
				: "QUERY_FAILED",
		};
	};
	source("kubernetes", [
		"pods",
		"volumes",
		"events",
		"quotas",
		"deployments",
		"statefulsets",
		"replicasets",
	]);
	source("pod-metrics", ["podMetrics"]);
	source("node-metrics", ["nodes", "nodeMetrics"]);
	source("image-cache", ["imageCaches"]);
	const scoped = (kind: OperationsReadKindV2) =>
		(loaded.get(kind) ?? []).filter(
			(entry) => metadata(entry).namespace === input.scope.namespace,
		);
	for (const [kind, metricKind] of [
		["pod-metrics", "podMetrics"],
		["node-metrics", "nodeMetrics"],
	] as const) {
		if (!loaded.has(metricKind)) continue;
		const samples =
			metricKind === "podMetrics"
				? scoped(metricKind)
				: (loaded.get(metricKind) ?? []);
		const dates = samples
			.flatMap((sample) =>
				date(sample.timestamp) ? [date(sample.timestamp) as string] : [],
			)
			.sort();
		const index = snapshot.sources.findIndex((entry) => entry.kind === kind);
		if (!dates.length)
			snapshot.sources[index] = {
				kind,
				state: "missing",
				observedAt: null,
				windowSeconds: null,
				reason: "NO_SAMPLES",
			};
		else {
			const observedAt = dates[0] ?? now;
			const stale =
				Date.parse(now) - Date.parse(observedAt) >
				Math.max(90_000, snapshot.refreshSeconds * 3000);
			const invalid = dates.some(
				(value) => Date.parse(value) > Date.parse(now) + 5000,
			);
			const duration = /^([0-9]+(?:\.[0-9]+)?)s$/.exec(
				String(samples[0]?.window),
			)?.[1];
			snapshot.sources[index] = {
				kind,
				state: invalid ? "unavailable" : stale ? "stale" : "available",
				observedAt,
				windowSeconds:
					duration && Number(duration) > 0 ? Number(duration) : null,
				reason: invalid ? "INVALID_DATA" : stale ? "STALE" : null,
			};
		}
	}
	const controllers = [...scoped("deployments"), ...scoped("statefulsets")];
	const replicasets = scoped("replicasets");
	const controllerFor = (pod: ObjectRecord) => {
		let owner = controllingOwner(pod);
		if (owner?.kind === "ReplicaSet") {
			const rs = replicasets.find(
				(entry) =>
					metadata(entry).uid === owner?.uid &&
					metadata(entry).name === owner?.name,
			);
			owner = rs ? controllingOwner(rs) : null;
		}
		return owner && ["Deployment", "StatefulSet"].includes(String(owner.kind))
			? controllers.find(
					(entry) =>
						metadata(entry).uid === owner?.uid &&
						metadata(entry).name === owner?.name,
				)
			: undefined;
	};
	const shared: Record<string, OperationsResourceV2["role"]> = {
		"agent-infra-api": "api",
		"agent-infra-worker": "worker",
		"agent-infra-web": "web",
		"agent-infra-postgres": "database",
		"agent-infra-directory": "directory",
	};
	const isVirtualNode = (node: ObjectRecord) => {
		const meta = metadata(node);
		const labels = object(meta.labels);
		const name = text(meta.name);
		return (
			labels.type === "virtual-kubelet" ||
			labels["alibabacloud.com/eci"] === "true" ||
			name?.startsWith("virtual-kubelet") === true
		);
	};
	const nodePlacements = new Map(
		(loaded.get("nodes") ?? []).flatMap((node) => {
			const name = text(metadata(node).name);
			return name
				? ([
						[name, isVirtualNode(node) ? ("eci" as const) : ("ecs" as const)],
					] as const)
				: [];
		}),
	);
	const metrics = scoped("podMetrics");
	const rawPods = scoped("pods");
	for (const pod of rawPods) {
		const meta = metadata(pod);
		const spec = object(pod.spec);
		const status = object(pod.status);
		const uid = text(meta.uid);
		const name = text(meta.name);
		const version = text(meta.resourceVersion);
		if (!uid || !name || !version) continue;
		const labels = object(meta.labels);
		const annotations = object(meta.annotations);
		const controller = controllerFor(pod);
		let controlMeta = controller ? metadata(controller) : {};
		let controlAnnotations = object(controlMeta.annotations);
		let controlLabels = object(controlMeta.labels);
		let verifiedMulti: OperationsBindingV2 | undefined;
		for (const binding of input.bindings) {
			if (
				!binding.controllerUid ||
				!binding.manifestHash ||
				!binding.members ||
				!controller
			)
				continue;
			const root = controllers.find(
				(entry) =>
					metadata(entry).uid === binding.controllerUid &&
					integer(metadata(entry).generation) === binding.generation,
			);
			if (!root) continue;
			const rootMeta = metadata(root);
			const rootAnnotations = object(rootMeta.annotations);
			if (
				rootAnnotations["agent-infra.agora.io/spec-hash"] !==
					binding.manifestHash ||
				rootAnnotations["agent-infra.agora.io/agent-id"] !== binding.agentId ||
				integer(rootAnnotations["agent-infra.agora.io/fence"]) !==
					binding.resourceFence ||
				integer(object(rootMeta.labels)["agent-infra.agora.io/revision"]) !==
					binding.workloadRevision
			)
				continue;
			const member = binding.members.find(
				(entry) =>
					serviceResourceName(binding.agentId, entry.name) ===
						controlMeta.name && entry.kind === controller.kind,
			);
			if (
				!member ||
				controlAnnotations["agent-infra.agora.io/spec-hash"] !==
					binding.manifestHash ||
				controlAnnotations["agent-infra.agora.io/agent-id"] !==
					binding.agentId ||
				integer(controlAnnotations["agent-infra.agora.io/fence"]) !==
					binding.resourceFence ||
				integer(controlLabels["agent-infra.agora.io/revision"]) !==
					binding.workloadRevision
			)
				continue;
			if (controlMeta.uid !== rootMeta.uid) {
				try {
					const raw = text(
						rootAnnotations["agent-infra.agora.io/multi-service-members"],
						65536,
					);
					const identity = object(
						object(JSON.parse(raw ?? "null"))[member.name],
					);
					if (
						identity.uid !== controlMeta.uid ||
						integer(identity.generation) !== integer(controlMeta.generation)
					)
						continue;
				} catch {
					continue;
				}
			}
			verifiedMulti = binding;
			controlMeta = rootMeta;
			controlAnnotations = rootAnnotations;
			controlLabels = object(rootMeta.labels);
			break;
		}
		const isSandbox =
			labels["agent-infra.agora.io/managed"] === "session-sandbox-v1" &&
			annotations["agent-infra.agora.io/managed"] === "session-sandbox-v1";
		let agentId = text(
			isSandbox
				? annotations["agent-infra.agora.io/agent-id"]
				: controlAnnotations["agent-infra.agora.io/agent-id"],
		);
		let sessionId = isSandbox
			? text(annotations["agent-infra.agora.io/session-id"])
			: null;
		let sandboxId = isSandbox
			? text(labels["agent-infra.agora.io/sandbox-id"])
			: null;
		if (isSandbox) {
			const generation = integer(labels["agent-infra.agora.io/generation"]);
			let expected: Readonly<Record<string, string>> = {};
			try {
				expected =
					agentId && sessionId && sandboxId && generation !== null
						? sessionSandboxLabelsV1({
								agentId,
								sessionId,
								sandboxId,
								generation,
							})
						: {};
			} catch {
				expected = {};
			}
			if (
				!agentId ||
				!sessionId ||
				!sandboxId ||
				!Object.keys(expected).length ||
				Object.entries(expected).some(([key, value]) => labels[key] !== value)
			) {
				agentId = null;
				sessionId = null;
				sandboxId = null;
			}
		}
		const metric = metrics.find((entry) => {
			const at = date(entry.timestamp);
			const created = date(meta.creationTimestamp);
			const window = /^([0-9]+(?:\.[0-9]+)?)s$/.exec(String(entry.window))?.[1];
			return (
				stableIdentity("pods", pod) &&
				metadata(entry).name === name &&
				(metadata(entry).uid === undefined || metadata(entry).uid === uid) &&
				at &&
				created &&
				window &&
				Date.parse(at) - Number(window) * 1000 >= Date.parse(created) + 1000
			);
		});
		const metricContainers = list(metric?.containers);
		const statuses = [
			...list(status.containerStatuses),
			...list(status.initContainerStatuses),
		];
		const containers = [
			...list(spec.containers),
			...list(spec.initContainers),
		].map((container) => {
			const current =
				statuses.find((entry) => entry.name === container.name) ?? {};
			const state = object(current.state);
			const ended = object(state.terminated);
			const waiting = object(state.waiting);
			const measured = metricContainers.find(
				(entry) => entry.name === container.name,
			);
			return {
				name: text(container.name) ?? "unknown",
				image: text(container.image, 512) ?? "unknown",
				imageId: text(current.imageID, 512),
				ready: current.ready === true,
				restarts: integer(current.restartCount) ?? 0,
				role:
					container.name === "codex-session-executor"
						? ("executor" as const)
						: list(spec.initContainers).some(
									(entry) => entry.name === container.name,
								)
							? ("init" as const)
							: ["runtime", "agent"].includes(String(container.name))
								? ("runtime" as const)
								: ("sidecar" as const),
				state: state.running
					? ("running" as const)
					: state.waiting
						? ("waiting" as const)
						: state.terminated
							? ("terminated" as const)
							: ("unknown" as const),
				reason: reason(waiting.reason ?? ended.reason),
				usage: quantities(measured?.usage),
				requests: quantities(object(container.resources).requests),
				limits: quantities(object(container.resources).limits),
			};
		});
		const sharedRole = shared[String(controlMeta.name)];
		const observationTime = date(metric?.timestamp) ?? now;
		snapshot.resources.push({
			kind: "Pod",
			uid,
			name,
			namespace: input.scope.namespace,
			resourceVersion: version,
			ownerUid: text(controlMeta.uid),
			ownerGeneration: integer(controlMeta.generation),
			agentId,
			agentName: null,
			sessionId,
			sandboxId,
			generation: isSandbox
				? integer(labels["agent-infra.agora.io/generation"])
				: null,
			revision: isSandbox
				? null
				: (verifiedMulti?.revision ??
					integer(controlAnnotations["agent-infra.agora.io/config-revision"])),
			workloadRevision: isSandbox
				? null
				: integer(controlLabels["agent-infra.agora.io/revision"]),
			resourceFence: integer(
				(isSandbox ? annotations : controlAnnotations)[
					"agent-infra.agora.io/fence"
				],
			),
			ownership: sharedRole ? "shared" : agentId ? "agent" : "unknown",
			role:
				sharedRole ??
				(isSandbox ? "sandbox" : agentId ? "workload" : "unknown"),
			nodeName: text(spec.nodeName),
			phase: reason(status.phase) ?? "Unknown",
			ready:
				list(status.conditions).find((condition) => condition.type === "Ready")
					?.status === "True",
			restarts: containers.reduce(
				(total, container) => total + container.restarts,
				0,
			),
			reason:
				containers.find((container) => container.reason)?.reason ??
				reason(
					list(status.conditions).find(
						(condition) =>
							condition.type === "PodScheduled" && condition.status === "False",
					)?.reason,
				),
			observedAt: observationTime,
			...(stableIdentity("pods", pod) ? { identityObservedAt } : {}),
			usage: metric
				? sum(metricContainers.map((container) => quantities(container.usage)))
				: empty(),
			requests: declaredResources(spec, "requests"),
			limits: declaredResources(spec, "limits"),
			containers,
			images: [...new Set(containers.map((container) => container.image))],
			retainedStorage: false,
			placement: nodePlacements.get(text(spec.nodeName) ?? "") ?? "unknown",
			ownershipReason: agentId || sharedRole ? null : "BINDING_UNAVAILABLE",
		});
	}
	for (const volume of scoped("volumes")) {
		const meta = metadata(volume);
		const annotations = object(meta.annotations);
		const labels = object(meta.labels);
		const uid = text(meta.uid);
		const name = text(meta.name);
		const version = text(meta.resourceVersion);
		if (!uid || !name || !version) continue;
		const mounted = rawPods
			.filter((pod) =>
				list(object(pod.spec).volumes).some(
					(entry) => object(entry.persistentVolumeClaim).claimName === name,
				),
			)
			.flatMap((pod) =>
				snapshot.resources.filter(
					(resource) =>
						resource.uid === metadata(pod).uid && resource.kind === "Pod",
				),
			);
		const owner = mounted[0];
		const uniqueOwner =
			owner &&
			mounted.every(
				(entry) =>
					entry.agentId === owner.agentId && entry.ownerUid === owner.ownerUid,
			) &&
			(owner.ownership === "shared" ||
				(owner.role === "workload" &&
					annotations["agent-infra.agora.io/agent-id"] === owner.agentId));
		snapshot.resources.push({
			kind: "PersistentVolumeClaim",
			uid,
			name,
			namespace: input.scope.namespace,
			resourceVersion: version,
			ownerUid: null,
			ownerGeneration: null,
			agentId: text(annotations["agent-infra.agora.io/agent-id"]),
			agentName: null,
			sessionId: text(annotations["agent-infra.agora.io/session-id"]),
			sandboxId: text(labels["agent-infra.agora.io/sandbox-id"]),
			generation: integer(labels["agent-infra.agora.io/generation"]),
			revision: null,
			workloadRevision: null,
			resourceFence: integer(annotations["agent-infra.agora.io/fence"]),
			ownership: "unknown",
			role: "sandbox",
			nodeName: null,
			phase: reason(object(volume.status).phase) ?? "Unknown",
			ready: null,
			restarts: 0,
			reason: null,
			observedAt: now,
			...(stableIdentity("volumes", volume) ? { identityObservedAt } : {}),
			usage: empty(),
			requests: quantities(object(object(volume.spec).resources).requests),
			limits: empty(),
			containers: [],
			images: [],
			retainedStorage: false,
			placement: "unknown",
			ownershipReason: "PVC_BINDING_UNAVAILABLE",
			...(uniqueOwner
				? {
						ownerUid: owner.ownerUid,
						ownerGeneration: owner.ownerGeneration,
						agentId: owner.agentId,
						sessionId: null,
						sandboxId: null,
						generation: null,
						revision: owner.revision,
						workloadRevision: owner.workloadRevision,
						resourceFence: owner.resourceFence,
						ownership: owner.ownership,
						role: owner.role,
					}
				: {}),
		});
	}
	const nodeMetrics = loaded.get("nodeMetrics") ?? [];
	for (const node of loaded.get("nodes") ?? []) {
		const meta = metadata(node);
		const status = object(node.status);
		const uid = text(meta.uid);
		const name = text(meta.name);
		if (!uid || !name) continue;
		const virtual = isVirtualNode(node);
		const metric = nodeMetrics.find((entry) => {
			const at = date(entry.timestamp);
			const created = date(meta.creationTimestamp);
			const window = /^([0-9]+(?:\.[0-9]+)?)s$/.exec(String(entry.window))?.[1];
			return (
				stableIdentity("nodes", node) &&
				metadata(entry).name === name &&
				(metadata(entry).uid === undefined || metadata(entry).uid === uid) &&
				at &&
				created &&
				window &&
				Date.parse(at) - Number(window) * 1000 >= Date.parse(created) + 1000
			);
		});
		const conditions = list(status.conditions);
		snapshot.nodes.push({
			uid,
			name,
			virtual,
			ready:
				conditions.find((condition) => condition.type === "Ready")?.status ===
				"True",
			pressures: conditions.flatMap((condition) =>
				condition.status === "True" &&
				[
					"MemoryPressure",
					"DiskPressure",
					"PIDPressure",
					"NetworkUnavailable",
				].includes(String(condition.type))
					? [
							condition.type as
								| "MemoryPressure"
								| "DiskPressure"
								| "PIDPressure"
								| "NetworkUnavailable",
						]
					: [],
			),
			capacity: virtual ? empty() : quantities(status.capacity),
			allocatable: virtual ? empty() : quantities(status.allocatable),
			usage: virtual ? empty() : quantities(metric?.usage),
			requests: sum(
				snapshot.resources
					.filter(
						(resource) => resource.kind === "Pod" && resource.nodeName === name,
					)
					.map((resource) => resource.requests),
			),
			observedAt: date(metric?.timestamp) ?? now,
			...(stableIdentity("nodes", node) ? { identityObservedAt } : {}),
		});
	}
	const quotaKeys = [
		"requests.cpu",
		"limits.cpu",
		"requests.memory",
		"limits.memory",
		"requests.storage",
		"requests.ephemeral-storage",
		"limits.ephemeral-storage",
		"pods",
		"persistentvolumeclaims",
		"services",
		"secrets",
	] as const;
	const quotaEntries = loaded.get("quotas");
	snapshot.quotaSource = quotaEntries
		? quotaEntries.length > 0
			? "kubernetes-resourcequota"
			: "not-configured"
		: "unavailable";
	for (const quota of scoped("quotas")) {
		const meta = metadata(quota);
		const status = object(quota.status);
		const hard = object(status.hard);
		const used = object(status.used);
		const uid = text(meta.uid);
		const name = text(meta.name);
		if (!uid || !name) continue;
		snapshot.quotas.push({
			uid,
			name,
			namespace: input.scope.namespace,
			observedAt: now,
			values: quotaKeys.flatMap((key) => {
				const limit = quantity(hard[key]);
				return limit === null
					? []
					: [
							{
								resource: key,
								unit: key.endsWith("cpu")
									? ("cores" as const)
									: key.includes("memory") || key.includes("storage")
										? ("bytes" as const)
										: ("count" as const),
								used: quantity(used[key]),
								hard: limit,
							},
						];
			}),
			source: "kubernetes-resourcequota",
		});
	}
	for (const cache of loaded.get("imageCaches") ?? []) {
		const meta = metadata(cache);
		const status = object(cache.status);
		const uid = text(meta.uid);
		const name = text(meta.name);
		if (
			!uid ||
			!name ||
			object(meta.labels)["agent-infra.agora.io/cache-owner"] !==
				input.cacheOwner
		)
			continue;
		snapshot.imageCaches.push({
			uid,
			name,
			owner: input.cacheOwner,
			cacheId: text(status.imageCacheId),
			phase: reason(status.phase) ?? "Unknown",
			images: Array.isArray(object(cache.spec).images)
				? (object(cache.spec).images as unknown[]).flatMap((entry) =>
						text(entry, 512) ? [String(entry)] : [],
					)
				: [],
			expiresAt: date(status.expireDateTime),
			deleting: Boolean(meta.deletionTimestamp),
			observedAt: now,
			inventoryLimit: input.cacheInventoryLimit,
		});
	}
	const rawEvents = scoped("events");
	const knownUids = new Set(snapshot.resources.map((resource) => resource.uid));
	for (const event of rawEvents) {
		const target = object(event.involvedObject);
		const code = reason(event.reason);
		const uid = text(metadata(event).uid);
		if (!uid || !code || !knownUids.has(String(target.uid))) continue;
		snapshot.events.push({
			uid,
			source: "kubernetes-event",
			objectUid: String(target.uid),
			objectName: text(target.name) ?? "unknown",
			reason: code,
			category: /Quota|Capacity|OOM/.test(code)
				? "capacity"
				: /Schedul/.test(code)
					? "scheduling"
					: /Image|Pull/.test(code)
						? "image"
						: "runtime",
			severity: event.type === "Warning" ? "warning" : "info",
			count: integer(event.count) ?? 1,
			firstAt: date(event.firstTimestamp ?? event.eventTime),
			lastAt: date(
				event.lastTimestamp ??
					object(event.series).lastObservedTime ??
					event.eventTime ??
					event.firstTimestamp,
			),
		});
	}
	for (const pod of rawPods) {
		const meta = metadata(pod);
		const status = object(pod.status);
		const uid = text(meta.uid);
		const name = text(meta.name);
		if (!uid || !name) continue;
		for (const container of [
			...list(status.containerStatuses),
			...list(status.initContainerStatuses),
		]) {
			const terminated = object(object(container.lastState).terminated);
			const code = reason(terminated.reason);
			const at = date(terminated.finishedAt);
			const containerName = text(container.name, 63);
			if (!code || code === "Completed" || !at || !containerName) continue;
			// This is a source-qualified status fact; objectUid remains the actual Pod UID.
			snapshot.events.push({
				uid: `container-status:${uid}:${containerName}:${at}`,
				source: "container-status",
				objectUid: uid,
				objectName: name,
				reason: code,
				category: code === "OOMKilled" ? "capacity" : "runtime",
				severity: "warning",
				count: 1,
				firstAt: at,
				lastAt: at,
			});
		}
	}
	for (const pod of rawPods) {
		const meta = metadata(pod);
		const spec = object(pod.spec);
		const status = object(pod.status);
		const projected = snapshot.resources.find(
			(resource) => resource.kind === "Pod" && resource.uid === meta.uid,
		);
		if (!projected) continue;
		const cacheId = text(object(meta.annotations)["k8s.aliyun.com/eci-imc-id"]);
		const cache = snapshot.imageCaches.find(
			(entry) =>
				entry.cacheId === cacheId &&
				entry.phase === "Ready" &&
				!entry.deleting &&
				(!entry.expiresAt || Date.parse(entry.expiresAt) > Date.parse(now)),
		);
		const covered = cache
			? projected.images.filter((image) => cache.images.includes(image)).length
			: 0;
		const created = date(meta.creationTimestamp);
		const readyAt = date(
			list(status.conditions).find(
				(condition) =>
					condition.type === "Ready" && condition.status === "True",
			)?.lastTransitionTime,
		);
		const events = rawEvents.filter((event) => {
			const first = date(event.firstTimestamp ?? event.eventTime);
			const last = date(
				event.lastTimestamp ??
					object(event.series).lastObservedTime ??
					event.eventTime ??
					event.firstTimestamp,
			);
			return (
				object(event.involvedObject).uid === meta.uid &&
				object(event.involvedObject).kind === "Pod" &&
				(event.type === "Normal" || event.type === "Warning") &&
				created &&
				readyAt &&
				first &&
				last &&
				Date.parse(first) >= Date.parse(created) &&
				Date.parse(last) >= Date.parse(first) &&
				Date.parse(last) <= Date.parse(readyAt)
			);
		});
		const hit = events.some(
			(event) => event.reason === "SuccessfulHitImageCache",
		);
		const present =
			projected.images.length > 0 &&
			projected.images.every((image) =>
				events.some(
					(event) =>
						event.reason === "Pulled" &&
						event.message ===
							`Container image "${image}" already present on machine`,
				),
			);
		const actualImages = [
			...list(status.containerStatuses),
			...list(status.initContainerStatuses),
		];
		const exactImages = [
			...list(spec.containers),
			...list(spec.initContainers),
		].every((container) => {
			const digest = text(container.image, 512)?.split("@")[1];
			return (
				digest &&
				actualImages.some(
					(entry) =>
						entry.name === container.name &&
						text(entry.imageID, 512)?.endsWith(digest),
				)
			);
		});
		const eci =
			projected.nodeName?.startsWith("virtual-kubelet") ||
			snapshot.nodes.some(
				(node) => node.name === projected.nodeName && node.virtual,
			);
		snapshot.cacheEvidence.push({
			podUid: projected.uid,
			podName: projected.name,
			images: projected.images,
			cacheId,
			coverage: cache
				? projected.images.length > 0 &&
					covered === projected.images.length &&
					cache.images.length === projected.images.length
					? "covered"
					: covered
						? "partial"
						: "missing"
				: loaded.has("imageCaches") && cacheId
					? "missing"
					: "unknown",
			hit:
				eci &&
				hit &&
				present &&
				exactImages &&
				!events.some((event) => event.reason === "ImageCacheNotFullMatch")
					? "confirmed"
					: events.some((event) => event.reason === "Pulling")
						? "pull-observed"
						: eci
							? "unknown"
							: "not-applicable",
			observedAt: now,
		});
	}
	const limits = {
		nodes: 200,
		resources: 2000,
		quotas: 100,
		imageCaches: 128,
		cacheEvidence: 2000,
		events: 1000,
	} as const;
	for (const [key, limit] of Object.entries(limits) as [
		keyof typeof limits,
		number,
	][]) {
		if (snapshot[key].length > limit) {
			snapshot[key].splice(limit);
			snapshot.truncated = true;
		}
	}
	for (const resource of snapshot.resources) {
		if (resource.containers.length > 64 || resource.images.length > 64) {
			resource.containers.splice(64);
			resource.images.splice(64);
			snapshot.truncated = true;
		}
	}
	if (snapshot.truncated) {
		snapshot.sources = snapshot.sources.map((source) =>
			source.state === "available"
				? { ...source, reason: "TRUNCATED" }
				: source,
		);
		snapshot.cacheEvidence = snapshot.cacheEvidence.map((entry) => ({
			...entry,
			images: entry.images.slice(0, 64),
			coverage: "unknown",
			hit: entry.hit === "not-applicable" ? "not-applicable" : "unknown",
		}));
	}
	return OperationsResourcesV2Schema.parse(snapshot);
}
