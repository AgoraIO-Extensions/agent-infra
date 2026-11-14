import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseAllDocuments } from "yaml";
import { hasSessionSandboxIdentityV1 } from "./session-workload-adapter.js";
import { projectWorkspaceSnapshotPodShapeV1 } from "./workspace-snapshot-materializer.js";

type RecordValue = Record<string, unknown>;
type DemandKind = "parent-workload" | "session" | "snapshot" | "declared";

export interface RuntimeDemandImageReaderV1 {
	list(afterId?: string): Promise<{
		items: readonly { agentId: string }[];
		nextAfterId: string | null;
	}>;
	/** Normal management/configuration/Workload Store reads; no messages or Secrets. */
	read(agentId: string): Promise<{
		management: unknown;
		configuration: unknown;
		state: unknown;
	}>;
}

export interface RuntimeDemandImageContextV1 {
	readonly platformSource: string;
	readonly runtimeAuthority: string;
	readonly planHash: string;
	readonly clusterUid: string;
	readonly namespace: string;
	readonly namespaceUid: string;
	readonly release: string;
	readonly helmRevision: number;
	readonly installationId: string;
	readonly directoryBindingHash: string;
	readonly directorySnapshotHash: string;
}

/** A normal producer's final template, not an allocation request or an async resolver. */
export interface RuntimeDemandImageProjectionV1 {
	readonly agentId: string;
	readonly kind: DemandKind;
	readonly state: "current" | "retained" | "history-only" | "future";
	readonly contextHash: string;
	readonly casHash: string;
	readonly evidenceHash: string;
	readonly resources: readonly unknown[];
	readonly imageSources: readonly {
		readonly image: string;
		readonly role: string;
		readonly sourceSha: string;
		readonly evidenceHash: string;
	}[];
	readonly child?: {
		readonly sessionId: string;
		readonly sandboxId: string;
		readonly generation: number;
		readonly resourceFence: number;
	};
}

const hashPattern = /^[a-f0-9]{64}$/;
const sourcePattern = /^[a-f0-9]{40}$/;
const imagePattern =
	/^([a-z0-9.-]+(?::[0-9]+)?\/)[a-z0-9._/-]+@(sha256:[a-f0-9]{64})$/;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const kinds: readonly DemandKind[] = [
	"parent-workload",
	"session",
	"snapshot",
	"declared",
];

function requireValue(value: unknown): asserts value {
	if (!value) throw new Error("RUNTIME_DEMAND_IMAGE_INPUT_INVALID");
}
function record(value: unknown): RecordValue {
	requireValue(value && typeof value === "object" && !Array.isArray(value));
	return value as RecordValue;
}
function id(value: unknown): string {
	requireValue(typeof value === "string" && idPattern.test(value));
	return value;
}
function revision(value: unknown): number {
	requireValue(
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
	);
	return value;
}
function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function runtimeDemandImageContextV1(
	input: RuntimeDemandImageContextV1,
) {
	const context = {
		platformSource: input.platformSource,
		runtimeAuthority: input.runtimeAuthority,
		planHash: input.planHash,
		clusterUid: id(input.clusterUid),
		namespace: id(input.namespace),
		namespaceUid: id(input.namespaceUid),
		release: id(input.release),
		helmRevision: revision(input.helmRevision),
		installationId: id(input.installationId),
		directoryBindingHash: input.directoryBindingHash,
		directorySnapshotHash: input.directorySnapshotHash,
	};
	requireValue(
		typeof context.platformSource === "string" &&
			sourcePattern.test(context.platformSource) &&
			typeof context.runtimeAuthority === "string" &&
			sourcePattern.test(context.runtimeAuthority),
	);
	for (const value of [
		context.planHash,
		context.directoryBindingHash,
		context.directorySnapshotHash,
	])
		requireValue(typeof value === "string" && hashPattern.test(value));
	return { ...context, contextHash: hash(context) };
}

function safeCas(
	agentId: string,
	value: Awaited<ReturnType<RuntimeDemandImageReaderV1["read"]>>,
) {
	const management = record(value.management);
	const configuration = record(value.configuration);
	const state = value.state === null ? null : record(value.state);
	requireValue(
		configuration.agentId === agentId && (!state || state.agentId === agentId),
	);
	const source = record(configuration.source);
	requireValue(source.kind === "standard" || source.kind === "custom");
	requireValue(
		Array.isArray(configuration.ownerIds) && configuration.ownerIds.length > 0,
	);
	const identity = state?.identity ? record(state.identity) : null;
	const cas = {
		agentId,
		ownerIds: configuration.ownerIds.map(id).sort(),
		sourceKind: source.kind,
		templateId: source.kind === "standard" ? id(source.templateId) : null,
		interactionMode:
			source.kind === "custom" ? id(source.interactionMode) : null,
		configurationHash: hash(value.configuration),
		workloadStateHash: hash(value.state),
		managementRevision: revision(management.revision),
		configurationRevision: revision(configuration.revision),
		managementWorkloadRevision: revision(management.workloadRevision),
		desiredState:
			management.desiredState === "running"
				? "running"
				: management.desiredState === "stopped"
					? "stopped"
					: null,
		workloadRevision: state ? revision(state.revision) : null,
		fence: state ? revision(state.fence) : null,
		verifiedRevision:
			state?.verifiedRevision === null || !state
				? null
				: revision(state.verifiedRevision),
		workloadIdentity: identity
			? {
					uid: id(identity.uid),
					generation: revision(identity.generation),
					resourceVersion: null,
				}
			: null,
	};
	requireValue(cas.desiredState !== null);
	return { ...cas, casHash: hash(cas) };
}

function knownMainImages(
	value: Awaited<ReturnType<RuntimeDemandImageReaderV1["read"]>>,
) {
	const state = value.state ? record(value.state) : null;
	return (["candidate", "verified"] as const).flatMap((version) => {
		if (!state?.[version]) return [];
		const item = record(state[version]);
		const configuration = record(item.configuration);
		const source = record(configuration.source);
		const desired = record(item.deployment);
		const projection = item.modelProjection
			? record(item.modelProjection)
			: null;
		const binding = projection?.standardTemplateBinding
			? record(projection.standardTemplateBinding)
			: null;
		// A digest without its approved repository is not a canonical image URI.
		if (
			!binding ||
			source.kind !== "standard" ||
			binding.imageDigest !== desired.imageDigest ||
			source.imageDigest !== desired.imageDigest ||
			binding.templateId !== source.templateId ||
			typeof binding.imageRepository !== "string"
		)
			return [];
		const image = `${binding.imageRepository}@${desired.imageDigest}`;
		requireValue(imagePattern.test(image));
		return [
			{
				version,
				image,
				digest: desired.imageDigest,
				role: "parent-main",
				completeness: "MAIN_ONLY_INIT_SIDECARS_UNKNOWN",
			},
		];
	});
}

function declaredImages(configuration: RecordValue) {
	const source = record(configuration.source);
	if (source.kind !== "custom" || source.manifest === undefined) return [];
	requireValue(
		typeof source.manifest === "string" &&
			source.manifest.length <= 1024 * 1024,
	);
	return parseAllDocuments(source.manifest).flatMap((document) => {
		requireValue(document.errors.length === 0);
		const resource = document.toJSON();
		if (
			!resource ||
			!["Deployment", "StatefulSet", "Job"].includes(resource.kind)
		)
			return [];
		const pod = record(record(record(resource.spec).template).spec);
		requireValue(
			Array.isArray(pod.containers) &&
				pod.containers.length > 0 &&
				(pod.initContainers === undefined || Array.isArray(pod.initContainers)),
		);
		return [pod.containers, pod.initContainers ?? []].flatMap((entries, list) =>
			(entries as unknown[]).map((raw, index) => {
				const container = record(raw);
				requireValue(
					typeof container.image === "string" &&
						imagePattern.test(container.image),
				);
				return {
					resourceKind: id(resource.kind),
					resourceName: id(record(resource.metadata).name),
					containerName: id(container.name),
					containerKind: list === 1 ? "init" : index === 0 ? "main" : "sidecar",
					image: container.image,
					digest: container.image.slice(container.image.lastIndexOf("@") + 1),
					sourceRole: "custom-configuration-declaration",
					sourceSha: null,
					configurationRevision: revision(configuration.revision),
					configurationHash: hash(configuration),
				};
			}),
		);
	});
}

/** Select only deployment metadata; env, Secret data, signed URLs and user text never leave here. */
function images(projection: RuntimeDemandImageProjectionV1, namespace: string) {
	const result = [];
	for (const raw of projection.resources) {
		const resource = record(raw);
		if (
			!["Pod", "Deployment", "StatefulSet", "DaemonSet", "Job"].includes(
				String(resource.kind),
			)
		)
			continue;
		const metadata = record(resource.metadata);
		requireValue(metadata.namespace === namespace);
		const spec = record(resource.spec);
		const pod =
			resource.kind === "Pod" ? spec : record(record(spec.template).spec);
		requireValue(Array.isArray(pod.containers) && pod.containers.length > 0);
		requireValue(
			pod.initContainers === undefined || Array.isArray(pod.initContainers),
		);
		const names = new Set<string>();
		for (const [field, containers] of [
			["containers", pod.containers],
			["initContainers", pod.initContainers ?? []],
		] as const) {
			for (const [index, rawContainer] of (containers as unknown[]).entries()) {
				const container = record(rawContainer);
				const name = id(container.name);
				requireValue(!names.has(name));
				names.add(name);
				const image = container.image;
				requireValue(typeof image === "string" && imagePattern.test(image));
				const sources = projection.imageSources.filter(
					(source) => source.image === image,
				);
				requireValue(sources.length > 0);
				for (const source of sources) {
					requireValue(
						typeof source.sourceSha === "string" &&
							sourcePattern.test(source.sourceSha) &&
							typeof source.evidenceHash === "string" &&
							hashPattern.test(source.evidenceHash),
					);
					result.push({
						resourceKind: resource.kind,
						resourceName: id(metadata.name),
						resourceIdentity:
							metadata.uid && metadata.resourceVersion
								? {
										uid: id(metadata.uid),
										resourceVersion: id(metadata.resourceVersion),
										generation:
											metadata.generation === undefined
												? null
												: revision(metadata.generation),
									}
								: null,
						containerName: name,
						containerKind:
							field === "initContainers"
								? "init"
								: index === 0
									? "main"
									: "sidecar",
						image,
						digest: image.slice(image.lastIndexOf("@") + 1),
						role: id(source.role),
						sourceSha: source.sourceSha,
						evidenceHash: source.evidenceHash,
						entrypointShapeHash: hash([
							container.command ?? null,
							container.args ?? null,
						]),
					});
				}
			}
		}
	}
	requireValue(result.length > 0);
	return result;
}

/** Reuse the unsigned materializer shape; an empty binding list creates no demand. */
export function runtimeSnapshotImageProjectionV1(
	snapshots: Parameters<typeof projectWorkspaceSnapshotPodShapeV1>[0],
	policy: Parameters<typeof projectWorkspaceSnapshotPodShapeV1>[1],
) {
	if (snapshots.length === 0) return [];
	const shape = projectWorkspaceSnapshotPodShapeV1(snapshots, policy);
	return shape.initContainers.map((container) => ({
		name: container.name,
		image: container.image,
	}));
}

/** Bounded Store enumeration plus image-only projections. It never claims or applies resources. */
export async function collectRuntimeDemandImagesV1(
	reader: RuntimeDemandImageReaderV1,
	input: {
		readonly context: RuntimeDemandImageContextV1;
		readonly projections: readonly RuntimeDemandImageProjectionV1[];
	},
) {
	const context = runtimeDemandImageContextV1(input.context);
	const observedFrom = new Date().toISOString();
	const rows = [];
	const seen = new Set<string>();
	const cursors = new Set<string>();
	let cursor: string | undefined;
	let pageCount = 0;
	do {
		requireValue(++pageCount <= 1000);
		const page = await reader.list(cursor);
		requireValue(Array.isArray(page.items) && page.items.length <= 100);
		for (const listed of page.items) {
			const agentId = id(listed.agentId);
			requireValue(!seen.has(agentId));
			seen.add(agentId);
			const before = await reader.read(agentId);
			const cas = safeCas(agentId, before);
			const projections = input.projections.filter(
				(row) => row.agentId === agentId,
			);
			const groups = projections.map((projection) => {
				requireValue(
					kinds.includes(projection.kind) &&
						["current", "retained", "history-only", "future"].includes(
							projection.state,
						),
				);
				requireValue(
					projection.state !== "future" || projection.kind === "declared",
				);
				requireValue(
					projection.contextHash === context.contextHash &&
						projection.casHash === cas.casHash &&
						typeof projection.evidenceHash === "string" &&
						hashPattern.test(projection.evidenceHash),
				);
				if (projection.kind === "session") {
					requireValue(projection.child && projection.state !== "future");
					id(projection.child.sessionId);
					id(projection.child.sandboxId);
					requireValue(
						revision(projection.child.generation) > 0 &&
							revision(projection.child.resourceFence) > 0,
					);
					for (const raw of projection.resources) {
						const resource = record(raw);
						if (resource.kind !== "Pod") {
							requireValue(
								!["Deployment", "StatefulSet", "DaemonSet", "Job"].includes(
									String(resource.kind),
								),
							);
							continue;
						}
						const metadata = record(resource.metadata);
						requireValue(
							hasSessionSandboxIdentityV1(resource, {
								agentId,
								...projection.child,
							}) &&
								record(metadata.annotations)["agent-infra.agora.io/fence"] ===
									String(projection.child.resourceFence),
						);
					}
				}
				if (projection.kind === "parent-workload")
					for (const raw of projection.resources) {
						const resource = record(raw);
						if (resource.kind === "Pod")
							requireValue(
								record(record(resource.metadata).labels)[
									"agent-infra.agora.io/managed"
								] !== "session-sandbox-v1",
							);
					}
				return {
					kind: projection.kind,
					state: projection.state,
					evidenceHash: projection.evidenceHash,
					child: projection.child
						? {
								sessionId: id(projection.child.sessionId),
								sandboxId: id(projection.child.sandboxId),
								generation: revision(projection.child.generation),
								resourceFence: revision(projection.child.resourceFence),
							}
						: null,
					images: images(projection, context.namespace),
				};
			});
			const after = await reader.read(agentId);
			const contextStable = isDeepStrictEqual(before, after);
			rows.push({
				...cas,
				contextStable,
				knownMainImages: knownMainImages(before),
				declaredImages: declaredImages(record(before.configuration)),
				groups,
				scope: kinds.map((kind) => ({
					kind,
					status:
						contextStable && groups.some((group) => group.kind === kind)
							? "provided-projections-only"
							: "UNKNOWN",
				})),
				status: contextStable ? "PARTIAL" : "UNKNOWN_CONTEXT_DRIFT",
			});
		}
		requireValue(
			page.nextAfterId === null ||
				(page.items.length > 0 &&
					typeof page.nextAfterId === "string" &&
					!cursors.has(page.nextAfterId)),
		);
		if (page.nextAfterId !== null) {
			cursors.add(page.nextAfterId);
			cursor = id(page.nextAfterId);
		} else cursor = undefined;
	} while (cursor !== undefined);
	requireValue(input.projections.every((row) => seen.has(row.agentId)));
	return {
		schemaVersion: 1,
		context,
		observedFrom,
		observedAt: new Date().toISOString(),
		pageCount,
		paginationComplete: true,
		inventorySnapshotConsistent: false,
		contextStable: rows.every((row) => row.contextStable),
		bindingVerification: {
			targetAndDirectory: "supplied-approved-context",
			agentCas: "per-agent-double-read",
			podTemplates: "supplied-normal-producer",
		},
		rows,
		coverage: {
			agentManagement: "paged-store-scope",
			imageGroups: "provided-projections-only",
			custom: "PARTIAL",
			session: "UNKNOWN_INVENTORY",
			snapshot: "PARTIAL",
			declared: "PARTIAL",
		},
		globalAbsenceProven: false,
		livePodImageIdsVerified: false,
		sideEffects: {
			claims: 0,
			allocations: 0,
			applies: 0,
			modelCalls: 0,
			productWrites: 0,
			databaseWrites: 0,
			pvcWrites: 0,
			secretWrites: 0,
			fieldWrites: 0,
		},
	};
}
