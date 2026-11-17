import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
	type AgentWorkloadDesiredV1,
	OciImageReferenceV1Schema,
	validateAgentWorkloadDesiredV1,
	validateImageRegistryAdmissionResultV1,
} from "@agent-infra/contracts/workload";
import type { ImageRegistryAdapterV1 } from "@agent-infra/image-registry";
import type { WorkloadReconciliationStateV1 } from "@agent-infra/platform-core";
import {
	openPostgresWorkloadStateReaderV1,
	openPostgresWorkspaceSnapshotMaterializationReaderV1,
	PostgresAgentConfigurationQueryV1,
	PostgresAgentManagementQueryV1,
	type WorkspaceSnapshotMaterializationReadV1,
	type WorkspaceSnapshotMaterializationRecordV1,
} from "@agent-infra/platform-store";
import { composeSingleImageAgentWorkloadDesiredV1 } from "./agent-workload-desired.js";
import { parentWorkloadPodImageSpecV1 } from "./parent-workload-image-projection.js";
import {
	type RuntimeDemandImageContextV1,
	runtimeDemandImageAgentCasV1,
	runtimeDemandImageContextV1,
} from "./runtime-demand-images.js";
import { readOnlySessionImageDatabaseUrlV1 } from "./session-demand-images.js";
import { workloadPodImagesV1 } from "./workload-image-projection.js";
import { publicBasePathEnvironmentV1 } from "./workload-public-route.js";
import {
	type WorkloadRuntimeOptionsV1,
	workloadResourceConfigurationHashV1,
} from "./workload-runtime.js";
import { projectWorkspaceSnapshotDemandImagesV1 } from "./workspace-snapshot-demand-images.js";
import { workspaceSnapshotResolverImagePolicyV1 } from "./workspace-snapshot-resolver.js";

/**
 * The inputs this Worker process's Agent Workload reconciler uses: its own
 * policy, snapshot resolver, Registry adapter and admission references.
 * Callers never supply any of them.
 */
export interface WorkerAgentWorkloadDemandImageDeploymentV1 {
	/** `PLATFORM_WORKER_NAMESPACE` of this process. */
	readonly namespace: string | undefined;
	/** Deployment signing identity; the policy's runtime auth must name it. */
	readonly workerId: unknown;
	readonly workload: {
		readonly policy: WorkloadRuntimeOptionsV1["policy"];
		readonly workspaceSnapshotResolver?: WorkloadRuntimeOptionsV1["workspaceSnapshotResolver"];
		readonly admissionPolicyRef: unknown;
		readonly registrySubjectRef: unknown;
	};
	/** The same Registry adapter configuration the Workload Worker admits with. */
	readonly registry: () => ImageRegistryAdapterV1;
	/** The deployment configuration module this process evaluated. */
	readonly configurationModule: URL;
	/** Source declared by the mounted deployment configuration; never the caller's. */
	readonly configurationSourceSha: unknown;
	/** Raw declaration digest captured by the same loader as the effective policy. */
	readonly hostnameRouteConfigurationHash?: unknown;
}

const kind = "worker-agent-workload-demand-images";
const requestKeys = "context,schemaVersion,target";
const contextKeys = [
	"clusterUid",
	"directoryBindingHash",
	"directorySnapshotHash",
	"helmRevision",
	"installationId",
	"namespace",
	"namespaceUid",
	"planHash",
	"platformSource",
	"release",
	"runtimeAuthority",
].join(",");
const targetKeys = [
	"agentId",
	"casHash",
	"declaredImageSource",
	"proposal",
	"imagePolicyHash",
];
const proposalKeys = "command,imageReference,schemaVersion";
const imageSourceKeys = "runId,sourceSha,workflowSourceSha";
const namespacePattern = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const agentPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const sourcePattern = /^[a-f0-9]{40}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const opaquePattern = /^[\x20-\x7e]{1,256}$/;
const digestReferencePattern = /@(sha256:[a-f0-9]{64})$/;
/** Server-side reader identity; a caller actor is never the authority. */
const readerActorId = "platform-worker-agent-workload-image-preview";

const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

type Target = {
	readonly agentId: string;
	readonly proposal: {
		readonly schemaVersion: 1;
		readonly command: "upgrade_custom_image";
		readonly imageReference: string;
	};
	readonly casHash?: string;
	readonly imagePolicyHash?: string;
	readonly declaredImageSource?: {
		readonly sourceSha: string;
		readonly workflowSourceSha: string;
		readonly runId: string;
	};
};

export interface AgentWorkloadImageObservationV1 {
	readonly management: unknown;
	readonly configuration: unknown;
	readonly state: unknown;
}

export interface AgentWorkloadImageAuthorityV1 {
	readonly sourceSha: string;
	readonly configurationHash: string;
	readonly hostnameRouteConfigurationHash?: string;
	readonly resourceConfigurationHash: string;
	/** Every Worker policy input that decides an Agent Workload image, pull or placement. */
	readonly imagePolicyHash: string;
	readonly contextHash: string;
	readonly policy: WorkloadRuntimeOptionsV1["policy"];
	readonly workspaceSnapshotResolver?: WorkloadRuntimeOptionsV1["workspaceSnapshotResolver"];
	readonly admissionPolicyRef: string;
	readonly registrySubjectRef: string;
}

function plainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string) {
	return Object.keys(value).sort().join(",") === keys;
}

function parseTarget(value: unknown): Target {
	if (
		!plainObject(value) ||
		Object.keys(value).some((key) => !targetKeys.includes(key)) ||
		typeof value.agentId !== "string" ||
		!agentPattern.test(value.agentId) ||
		!plainObject(value.proposal) ||
		!exactKeys(value.proposal, proposalKeys) ||
		value.proposal.schemaVersion !== 1 ||
		value.proposal.command !== "upgrade_custom_image" ||
		typeof value.proposal.imageReference !== "string" ||
		!OciImageReferenceV1Schema.safeParse(value.proposal.imageReference)
			.success ||
		!digestReferencePattern.test(value.proposal.imageReference)
	)
		throw new Error();
	for (const key of ["casHash", "imagePolicyHash"] as const)
		if (
			value[key] !== undefined &&
			(typeof value[key] !== "string" || !hashPattern.test(value[key]))
		)
			throw new Error();
	const source = value.declaredImageSource;
	if (
		source !== undefined &&
		(!plainObject(source) ||
			!exactKeys(source, imageSourceKeys) ||
			typeof source.sourceSha !== "string" ||
			!sourcePattern.test(source.sourceSha) ||
			typeof source.workflowSourceSha !== "string" ||
			!sourcePattern.test(source.workflowSourceSha) ||
			typeof source.runId !== "string" ||
			!/^[1-9][0-9]{0,19}$/.test(source.runId))
	)
		throw new Error();
	return {
		agentId: value.agentId,
		proposal: {
			schemaVersion: 1,
			command: "upgrade_custom_image",
			imageReference: value.proposal.imageReference,
		},
		...(typeof value.casHash === "string" ? { casHash: value.casHash } : {}),
		...(typeof value.imagePolicyHash === "string"
			? { imagePolicyHash: value.imagePolicyHash }
			: {}),
		...(plainObject(source)
			? {
					declaredImageSource: {
						sourceSha: source.sourceSha as string,
						workflowSourceSha: source.workflowSourceSha as string,
						runId: source.runId as string,
					},
				}
			: {}),
	};
}

function parseRequest(value: unknown) {
	try {
		if (
			!plainObject(value) ||
			!exactKeys(value, requestKeys) ||
			value.schemaVersion !== 1 ||
			!plainObject(value.context) ||
			!exactKeys(value.context, contextKeys)
		)
			throw new Error();
		const context = runtimeDemandImageContextV1(
			value.context as unknown as RuntimeDemandImageContextV1,
		);
		return { context, target: parseTarget(value.target) };
	} catch {
		throw new Error("WORKER_AGENT_WORKLOAD_IMAGE_REQUEST_INVALID");
	}
}

async function deploymentAuthority(
	deployment: WorkerAgentWorkloadDemandImageDeploymentV1,
	context: ReturnType<typeof runtimeDemandImageContextV1>,
) {
	try {
		const { policy, admissionPolicyRef, registrySubjectRef } =
			deployment.workload;
		const sourceSha = deployment.configurationSourceSha;
		const hostnameRouteConfigurationHash =
			deployment.hostnameRouteConfigurationHash;
		if (
			typeof deployment.namespace !== "string" ||
			!namespacePattern.test(deployment.namespace) ||
			policy?.namespace !== deployment.namespace ||
			context.namespace !== deployment.namespace ||
			typeof deployment.workerId !== "string" ||
			policy.runtimeAuth?.workerId !== deployment.workerId ||
			typeof sourceSha !== "string" ||
			!sourcePattern.test(sourceSha) ||
			sourceSha !== context.runtimeAuthority ||
			typeof admissionPolicyRef !== "string" ||
			!opaquePattern.test(admissionPolicyRef) ||
			typeof registrySubjectRef !== "string" ||
			!opaquePattern.test(registrySubjectRef) ||
			typeof deployment.registry !== "function" ||
			(hostnameRouteConfigurationHash !== undefined &&
				(typeof hostnameRouteConfigurationHash !== "string" ||
					!hashPattern.test(hostnameRouteConfigurationHash)))
		)
			throw new Error();
		const configurationHash = createHash("sha256")
			.update(await readFile(deployment.configurationModule))
			.digest("hex");
		const resolver = deployment.workload.workspaceSnapshotResolver;
		const authority: AgentWorkloadImageAuthorityV1 = {
			sourceSha,
			configurationHash,
			...(hostnameRouteConfigurationHash !== undefined
				? {
						hostnameRouteConfigurationHash:
							hostnameRouteConfigurationHash as string,
					}
				: {}),
			resourceConfigurationHash: workloadResourceConfigurationHashV1(policy),
			imagePolicyHash: agentWorkloadImagePolicyHashV1({
				policy,
				workspaceSnapshotResolver: resolver,
				admissionPolicyRef,
				registrySubjectRef,
				...(hostnameRouteConfigurationHash !== undefined
					? {
							hostnameRouteConfigurationHash:
								hostnameRouteConfigurationHash as string,
						}
					: {}),
			}),
			contextHash: context.contextHash,
			policy,
			...(deployment.workload.workspaceSnapshotResolver
				? {
						workspaceSnapshotResolver:
							deployment.workload.workspaceSnapshotResolver,
					}
				: {}),
			admissionPolicyRef,
			registrySubjectRef,
		};
		return {
			authority,
			summary: {
				entry: "deployment readPlatformAgentWorkloadDemandImagesV1",
				sourceSha,
				sourceShaBinding:
					"mounted session-reserves.json sourceSha; equals context.runtimeAuthority",
				configurationHash,
				...(hostnameRouteConfigurationHash !== undefined
					? { hostnameRouteConfigurationHash }
					: {}),
				...(policy.hostnameRoutes !== undefined
					? { hostnameRoutes: policy.hostnameRoutes }
					: {}),
				configurationHashScope:
					"sha256 of the deployment configuration.mjs bytes this process loaded",
				namespace: deployment.namespace,
				resourceConfigurationHash: authority.resourceConfigurationHash,
				imagePolicyHash: authority.imagePolicyHash,
				imagePolicyHashScope:
					"namespace, image repository, pull Secret name, Skill delivery image, path/identity/hostname route policy, captured hostname declaration bytes, snapshot materializer policy and admission references",
				imageRepository: policy.imageRepository,
				workspaceSnapshotResolver:
					deployment.workload.workspaceSnapshotResolver !== undefined,
			},
		};
	} catch {
		throw new Error("WORKER_AGENT_WORKLOAD_IMAGE_AUTHORITY_UNAVAILABLE");
	}
}

/** Binds the Worker policy inputs that decide images, pulls and placement. */
export function agentWorkloadImagePolicyHashV1(input: {
	readonly policy: WorkloadRuntimeOptionsV1["policy"];
	readonly workspaceSnapshotResolver?: unknown;
	readonly admissionPolicyRef: string;
	readonly registrySubjectRef: string;
	readonly hostnameRouteConfigurationHash?: string;
}) {
	const { policy } = input;
	return hash({
		namespace: policy.namespace,
		imageRepository: policy.imageRepository,
		imagePullSecretName: policy.imagePullSecretName ?? null,
		skillDeliveryImage: policy.skillDeliveryImage ?? null,
		resourceConfigurationHash: workloadResourceConfigurationHashV1(policy),
		routeHostSuffix: policy.routeHostSuffix,
		pathRoutes: policy.pathRoutes ?? null,
		...(policy.hostnameRoutes !== undefined ||
		input.hostnameRouteConfigurationHash !== undefined
			? {
					hostnameRoutes: policy.hostnameRoutes ?? null,
					hostnameRouteConfigurationHash:
						input.hostnameRouteConfigurationHash ?? null,
				}
			: {}),
		// Complete entries: the platform-auth Ingress consumes every value.
		platformAuthAnnotations: Object.keys(policy.platformAuthAnnotations)
			.sort()
			.map((key) => [key, policy.platformAuthAnnotations[key]]),
		workspaceSnapshotEgress: policy.workspaceSnapshotEgress ?? null,
		workspaceSnapshotPolicyHash:
			workspaceSnapshotResolverImagePolicyV1(input.workspaceSnapshotResolver)
				?.policyHash ?? null,
		admissionPolicyRef: input.admissionPolicyRef,
		registrySubjectRef: input.registrySubjectRef,
	});
}

/** The same repository split the API image admission applies to a custom reference. */
function repositoryOf(imageReference: string) {
	const name = imageReference.split("@")[0] ?? "";
	const separator = name.lastIndexOf(":");
	return separator > name.lastIndexOf("/") ? name.slice(0, separator) : name;
}

class Unknown extends Error {
	constructor(readonly reason: string) {
		super(reason);
	}
}

function ensure(condition: unknown, reason: string): asserts condition {
	if (!condition) throw new Unknown(reason);
}

function snapshotKeys(
	values: readonly { readonly snapshotId: string; readonly name: string }[],
) {
	return values
		.map(({ snapshotId, name }) => ({ snapshotId, name }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

function unknown(
	target: Target,
	reason: string,
	cas: ReturnType<typeof publicCas> | null,
	missing: readonly string[] = [],
) {
	return {
		agentId: target.agentId,
		proposalHash: hash(target.proposal),
		status: reason === "CAS_CHANGED" ? "CAS_CHANGED" : "UNKNOWN",
		reason,
		cas,
		images: [],
		missing,
	} as const;
}

function publicCas(value: ReturnType<typeof runtimeDemandImageAgentCasV1>) {
	return {
		casHash: value.casHash,
		ownerCount: value.ownerIds.length,
		sourceKind: value.sourceKind,
		interactionMode: value.interactionMode,
		managementRevision: value.managementRevision,
		configurationRevision: value.configurationRevision,
		managementWorkloadRevision: value.managementWorkloadRevision,
		desiredState: value.desiredState,
		workloadRevision: value.workloadRevision,
		fence: value.fence,
		verifiedRevision: value.verifiedRevision,
		workloadIdentity: value.workloadIdentity,
	};
}

/**
 * Complete predicted Agent Workload image set for one pending normal
 * `upgrade_custom_image` proposal, composed by the same Desired composition,
 * Registry admission, snapshot metadata and parent Pod image helpers that
 * reconciliation consumes. Read-only: it never claims, applies, signs URLs or
 * writes the Store; every incomplete input yields a stable UNKNOWN reason.
 */
export async function projectAgentWorkloadUpgradeImagesV1(input: {
	readonly authority: AgentWorkloadImageAuthorityV1;
	readonly target: Target;
	readonly observed: AgentWorkloadImageObservationV1;
	readonly registry: () => ImageRegistryAdapterV1;
	readonly snapshots: {
		read(
			value: WorkspaceSnapshotMaterializationReadV1,
		): Promise<readonly WorkspaceSnapshotMaterializationRecordV1[]>;
	};
}) {
	const { authority, target, observed } = input;
	const policy = authority.policy;
	let cas: ReturnType<typeof publicCas> | null = null;
	let missing = "Store management/configuration/Workload state for the Agent";
	try {
		const fullCas = (() => {
			try {
				return runtimeDemandImageAgentCasV1(target.agentId, observed);
			} catch {
				throw new Unknown("STORE_STATE_INCOMPLETE");
			}
		})();
		cas = publicCas(fullCas);
		if (target.casHash !== undefined && target.casHash !== fullCas.casHash)
			return unknown(target, "CAS_CHANGED", cas);
		missing = "Worker image policy matching the bound imagePolicyHash";
		if (
			target.imagePolicyHash !== undefined &&
			target.imagePolicyHash !== authority.imagePolicyHash
		)
			throw new Unknown("POLICY_CHANGED");
		missing = "single-image custom Agent (upgrade_custom_image family)";
		const configuration = observed.configuration as {
			readonly revision: number;
			readonly source: Record<string, unknown>;
			readonly environment: unknown;
			readonly secrets: readonly { readonly name: string }[];
		};
		const source = configuration.source;
		ensure(
			source.kind === "custom" && !("manifest" in source),
			"WRONG_RESOURCE_FAMILY",
		);
		ensure(
			source.interactionMode === "platform-adapter" ||
				(source.interactionMode === "self-managed" &&
					(source.identityResponsibility === "self-managed" ||
						source.identityResponsibility === "platform-managed")),
			"WRONG_RESOURCE_FAMILY",
		);
		missing = "proposal on this deployment's approved custom image repository";
		const digest = digestReferencePattern.exec(
			target.proposal.imageReference,
		)?.[1];
		ensure(
			digest !== undefined &&
				repositoryOf(target.proposal.imageReference) === policy.imageRepository,
			"PROPOSAL_REPOSITORY_NOT_DEPLOYMENT_REPOSITORY",
		);
		missing =
			"current reconciled Desired correlated with the current configuration";
		const state = observed.state as WorkloadReconciliationStateV1 | null;
		ensure(state !== null, "CURRENT_DESIRED_UNAVAILABLE");
		const candidate = state.candidate.configuration;
		let current: AgentWorkloadDesiredV1;
		try {
			current = validateAgentWorkloadDesiredV1(state.candidate.deployment);
		} catch {
			throw new Unknown("CURRENT_DESIRED_UNAVAILABLE");
		}
		ensure(
			candidate.source.kind === "custom" &&
				!("manifest" in candidate.source) &&
				candidate.revision === configuration.revision &&
				candidate.source.interactionMode === source.interactionMode &&
				(candidate.source.interactionMode === "platform-adapter" ||
					candidate.source.identityResponsibility ===
						source.identityResponsibility) &&
				isDeepStrictEqual(candidate.environment, configuration.environment) &&
				isDeepStrictEqual(
					candidate.secrets.map(({ name }) => name).sort(),
					configuration.secrets.map(({ name }) => name).sort(),
				) &&
				current.agentId === target.agentId &&
				current.configRevision === candidate.revision &&
				current.imageDigest === candidate.source.imageDigest &&
				!current.multiService,
			"CURRENT_DESIRED_UNAVAILABLE",
		);
		const bindings =
			candidate.source.kind === "custom"
				? (candidate.source.workspaceSnapshots ?? [])
				: [];
		missing = "snapshot bindings retained by configuration and current Desired";
		ensure(
			isDeepStrictEqual(
				snapshotKeys(bindings),
				snapshotKeys(
					Array.isArray(source.workspaceSnapshots)
						? source.workspaceSnapshots
						: [],
				),
			) &&
				isDeepStrictEqual(
					snapshotKeys(bindings),
					snapshotKeys(current.workspaceSnapshots ?? []),
				),
			"SNAPSHOT_BINDINGS_NOT_RETAINED",
		);
		// The upgrade keeps Skill bindings, but this reader cannot re-run the
		// deployment's Skill materializer for the successor revision.
		missing = "Skill materialization for the successor revision";
		ensure(!current.skills?.length, "SKILL_MATERIALIZATION_UNEVALUATED");
		// The same deterministic policy rejections preflight raises before admission.
		missing = "path-route environment and platform identity entry policy";
		ensure(
			!(
				policy.pathRoutes?.agentIds.includes(target.agentId) &&
				[...candidate.environment, ...candidate.secrets].some(
					({ name }) => name === publicBasePathEnvironmentV1,
				)
			),
			"POLICY_REJECTS_PROPOSAL",
		);
		ensure(
			!(
				candidate.source.interactionMode === "self-managed" &&
				candidate.source.identityResponsibility === "platform-managed" &&
				Object.keys(policy.platformAuthAnnotations).length === 0
			),
			"POLICY_REJECTS_PROPOSAL",
		);
		missing = "normal Worker Registry admission of the proposed digest";
		const proposalHash = hash(target.proposal);
		const request = {
			schemaVersion: 1 as const,
			requestId: `agent-image-preview-${proposalHash.slice(0, 32)}`,
			traceId: `agent-image-preview-${fullCas.casHash.slice(0, 32)}`,
			subjectRef: authority.registrySubjectRef,
			agentId: target.agentId,
			imageReference: `${policy.imageRepository}@${digest}`,
			usage: "custom-agent" as const,
			admissionPolicyRef: authority.admissionPolicyRef,
		};
		let admission: ReturnType<typeof validateImageRegistryAdmissionResultV1>;
		try {
			const result = await input
				.registry()
				.admit(request, { signal: AbortSignal.timeout(30_000) });
			admission = validateImageRegistryAdmissionResultV1(request, result);
		} catch {
			throw new Unknown("REGISTRY_ADMISSION_UNAVAILABLE");
		}
		ensure(
			admission.status === "admitted",
			admission.status === "rejected" && admission.error.retryable
				? "REGISTRY_ADMISSION_UNAVAILABLE"
				: "REGISTRY_ADMISSION_REJECTED",
		);
		ensure(
			admission.immutableDigest === digest &&
				admission.runtimeManifest.interactionMode ===
					candidate.source.interactionMode,
			"REGISTRY_ADMISSION_REJECTED",
		);
		missing = "pure single-image Desired composition accepted by policy";
		// Only the image changes; every other configuration field is retained.
		const upgraded = {
			...candidate,
			source: { ...candidate.source, imageDigest: digest },
		} as typeof candidate;
		let predicted: AgentWorkloadDesiredV1;
		try {
			predicted = composeSingleImageAgentWorkloadDesiredV1({
				requestId: request.requestId,
				traceId: request.traceId,
				agentId: target.agentId,
				workloadRevision: state.revision,
				fence: state.fence,
				identity: state.identity,
				configuration: upgraded,
				policy,
				admission,
				secretRefs: current.secretRefs,
				...(current.workspaceSnapshots
					? { workspaceSnapshots: current.workspaceSnapshots }
					: {}),
			});
		} catch {
			throw new Unknown("DESIRED_COMPOSITION_REJECTED");
		}
		const snapshot = await projectWorkspaceSnapshotDemandImagesV1({
			desired: predicted,
			contextHash: authority.contextHash,
			casHash: fullCas.casHash,
			workloadRevision: state.revision,
			fence: state.fence,
			authority: {
				sourceSha: authority.sourceSha,
				configurationHash: authority.configurationHash,
				contextHash: authority.contextHash,
				resolver: authority.workspaceSnapshotResolver,
			},
			snapshots: input.snapshots,
		});
		if (snapshot.status === "UNKNOWN") {
			missing = snapshot.missing.join("; ");
			throw new Unknown("WORKSPACE_SNAPSHOT_METADATA_UNAVAILABLE");
		}
		missing = "validated parent Pod image layout";
		let pod: ReturnType<typeof parentWorkloadPodImageSpecV1>;
		try {
			pod = parentWorkloadPodImageSpecV1({
				desired: predicted,
				sourceKind: "custom",
				policy,
				...(snapshot.projection
					? { workspaceSnapshotProjection: snapshot.projection() }
					: {}),
			});
		} catch {
			throw new Unknown("IMAGE_PROJECTION_REJECTED");
		}
		const images = workloadPodImagesV1(pod.spec);
		const containers = [
			...pod.spec.containers,
			...(pod.spec.initContainers ?? []),
		];
		const mainImage = `${policy.imageRepository}@${digest}`;
		ensure(images[0]?.image === mainImage, "IMAGE_PROJECTION_REJECTED");
		const currentMain = `${policy.imageRepository}@${current.imageDigest}`;
		return {
			agentId: target.agentId,
			proposalHash,
			status: "PROJECTED_IMAGES",
			reason: null,
			cas,
			resourceKind: pod.resourceKind,
			resourceName: pod.resourceName,
			mainImage,
			currentMainImage: currentMain,
			images: images.map((image) => ({
				...image,
				imagePullPolicy:
					containers.find((value) => value.name === image.name)
						?.imagePullPolicy ?? null,
			})),
			auxiliaryImages: [
				...new Set(
					images
						.filter((image) => image.kind !== "main")
						.map((image) => image.image),
				),
			],
			podIdentity: {
				namespace: policy.namespace,
				serviceAccountName: predicted.serviceAccount.name,
				imagePullSecrets: (pod.spec.imagePullSecrets ?? []).map(
					(secret) => secret.name,
				),
				nodeSelector: { ...(pod.spec.nodeSelector ?? {}) },
				tolerations: structuredClone(pod.spec.tolerations ?? []),
				affinity: pod.spec.affinity ?? null,
				runtimeClassName: pod.spec.runtimeClassName ?? null,
			},
			retained: {
				configurationRevisionBasis: candidate.revision,
				workloadRevisionBasis: state.revision,
				fenceBasis: state.fence,
				interactionMode: predicted.runtimeManifest.interactionMode,
				routeExposure: predicted.route.exposure,
				routeExposureUnchanged:
					predicted.route.exposure === current.route.exposure,
				environmentHash: hash(predicted.env),
				environmentUnchanged: isDeepStrictEqual(predicted.env, current.env),
				environmentKeyCount: Object.keys(predicted.env).length,
				secretReferenceCount: predicted.secretRefs.length,
				workspaceSnapshotCount: predicted.workspaceSnapshots?.length ?? 0,
				workspaceSnapshotsUnchanged: isDeepStrictEqual(
					predicted.workspaceSnapshots ?? [],
					current.workspaceSnapshots ?? [],
				),
				mainEntrypointSource: images[0]?.entrypointSource,
				mainEntrypointShapeHash: images[0]?.entrypointShapeHash,
			},
			admission: {
				immutableDigest: admission.immutableDigest,
				policyRef: admission.policyEvidence.policyRef,
				decisionRef: admission.policyEvidence.decisionRef,
				subjectRef: admission.policyEvidence.subjectRef,
				evaluatedAt: admission.policyEvidence.evaluatedAt,
				runtimeManifestHash: hash(admission.runtimeManifest),
				servicePort: admission.runtimeManifest.service.port,
				healthPath: admission.runtimeManifest.health.path,
			},
			snapshotStatus:
				snapshot.status === "PROJECTED_IMAGES"
					? "BOUND_METADATA_UNSIGNED_PROJECTION"
					: snapshot.status,
			snapshotAuthority: snapshot.provenance,
			missing: [],
		} as const;
	} catch (error) {
		return unknown(
			target,
			error instanceof Unknown ? error.reason : "PROJECTION_FAILED",
			cas,
			[missing],
		);
	}
}

/**
 * Read-only predicted Agent Workload image receipt for one pending
 * `upgrade_custom_image` proposal, using this Worker's own Workload authority.
 * Store reads run in database-enforced read-only, statement-bounded sessions;
 * the Agent is read twice and any drift between the reads is UNKNOWN.
 */
export async function readWorkerAgentWorkloadDemandImagesV1(
	deployment: WorkerAgentWorkloadDemandImageDeploymentV1,
	request: unknown,
	databaseUrl: string | undefined,
) {
	const { context, target } = parseRequest(request);
	const { authority, summary } = await deploymentAuthority(deployment, context);
	let management: PostgresAgentManagementQueryV1 | undefined;
	let configuration: PostgresAgentConfigurationQueryV1 | undefined;
	let workloads:
		| ReturnType<typeof openPostgresWorkloadStateReaderV1>
		| undefined;
	let snapshots:
		| ReturnType<typeof openPostgresWorkspaceSnapshotMaterializationReaderV1>
		| undefined;
	try {
		const readOnlyUrl = readOnlySessionImageDatabaseUrlV1(databaseUrl);
		const options = { databaseUrl: readOnlyUrl };
		management = new PostgresAgentManagementQueryV1(options);
		configuration = new PostgresAgentConfigurationQueryV1(options);
		workloads = openPostgresWorkloadStateReaderV1(options);
		const read = async (): Promise<AgentWorkloadImageObservationV1> => {
			const agent = await management?.getAgent(
				{ kind: "administrator" },
				target.agentId,
			);
			const result = await configuration?.read({
				agentId: target.agentId,
				actorId: readerActorId,
				isAdministrator: true,
				organizationIds: [],
				intent: "manage",
			});
			return {
				management: agent?.management ?? null,
				configuration:
					result?.outcome === "found" ? result.configuration : null,
				state: (await workloads?.readCurrentState(target.agentId)) ?? null,
			};
		};
		const before = await read();
		const projected = await projectAgentWorkloadUpgradeImagesV1({
			authority,
			target,
			observed: before,
			registry: deployment.registry,
			snapshots: {
				read: (value) => {
					snapshots ??=
						openPostgresWorkspaceSnapshotMaterializationReaderV1(readOnlyUrl);
					return snapshots.read(value);
				},
			},
		});
		const stable = isDeepStrictEqual(before, await read());
		const result = stable
			? projected
			: unknown(target, "STORE_CONTEXT_DRIFT", projected.cas, [
					"identical Agent management/configuration/Workload reads",
				]);
		return {
			schemaVersion: 1,
			kind,
			authority: summary,
			context,
			sourceRoles: {
				platformCode: {
					sourceSha: context.platformSource,
					trust: "CALLER_PLAN_CONTEXT",
				},
				runtimeConfiguration: {
					sourceSha: summary.sourceSha,
					trust: "MOUNTED_DEPLOYMENT_CONFIGURATION",
				},
				customImage: target.declaredImageSource
					? {
							...target.declaredImageSource,
							trust: "CALLER_DECLARED_NOT_VERIFIED",
							verifiedByProducer:
								"digest admitted by this Worker's normal Registry adapter",
						}
					: null,
			},
			proposal: target.proposal,
			target: result,
			storeReads: { contextStable: stable, readCount: 2 },
			futureWorkloadObjectsCreated: 0,
			livePodImagesVerified: false,
			fieldAcceptance: false,
			sideEffects: {
				claims: 0,
				applies: 0,
				signedUrls: 0,
				secretMaterializations: 0,
				skillMaterializations: 0,
				databaseWrites: 0,
				fieldWrites: 0,
				registryWrites: 0,
				modelCalls: 0,
			},
		};
	} catch {
		throw new Error("WORKER_AGENT_WORKLOAD_IMAGE_READ_FAILED");
	} finally {
		await Promise.allSettled([
			management?.close(),
			configuration?.close(),
			workloads?.close(),
			snapshots?.close(),
		]);
	}
}
