import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import { validateRuntimeModelProjectionV4 } from "@agent-infra/model-catalog";
import {
	openPostgresSessionSandboxImageReaderV1,
	openPostgresWorkspaceSnapshotMaterializationReaderV1,
	type SessionSandboxImageProjectionInputV1,
} from "@agent-infra/platform-store";
import { createSessionSandboxResourceInputResolverV1 } from "./conversation-deployment.js";
import { selectSessionOAuthProvisioningV1 } from "./session-oauth-provisioning-selection.js";
import {
	type SessionSandboxAllocationV1,
	type SessionSandboxOAuthProvisioningV1,
	sessionSandboxImageProjectionV1,
} from "./session-workload-adapter.js";
import {
	type WorkloadRuntimeOptionsV1,
	workloadResourceConfigurationHashV1,
} from "./workload-runtime.js";
import { projectWorkspaceSnapshotDemandImagesV1 } from "./workspace-snapshot-demand-images.js";

type StoreRead = Awaited<
	ReturnType<ReturnType<typeof openPostgresSessionSandboxImageReaderV1>["read"]>
>;
type SnapshotReader = Pick<
	ReturnType<typeof openPostgresWorkspaceSnapshotMaterializationReaderV1>,
	"read"
>;

function knownStoredMain(source: SessionSandboxImageProjectionInputV1) {
	try {
		const desired = validateAgentWorkloadDesiredV1(source.deployment);
		const projection = validateRuntimeModelProjectionV4(source.modelProjection);
		const binding = projection.standardTemplateBinding;
		if (
			projection.agentId !== source.binding.agentId ||
			projection.configurationRevision !== desired.configRevision ||
			binding.imageDigest !== source.policy.imageDigest ||
			binding.imageDigest !== desired.imageDigest ||
			!binding.imageRepository
		)
			return null;
		return {
			image: `${binding.imageRepository}@${binding.imageDigest}`,
			digest: binding.imageDigest,
			completeness: "MAIN_ONLY_INIT_SIDECARS_UNKNOWN",
		};
	} catch {
		return null;
	}
}

/** Existing approved Worker configuration, kept in memory; never serialized into the receipt. */
export interface SessionDemandImageAuthorityV1 {
	readonly id: string;
	readonly sourceSha: string;
	readonly configurationHash: string;
	readonly contextHash: string;
	readonly workload: Pick<
		WorkloadRuntimeOptionsV1,
		"policy" | "templateModelBindings" | "workspaceSnapshotResolver"
	>;
	readonly serviceToken: string;
	readonly oauthProvisioning?: SessionSandboxOAuthProvisioningV1;
}

/** Each authority assignment binds a real Store row/input, not a caller-supplied completeness flag. */
export async function projectSessionDemandImagesV1(input: {
	readonly readback: StoreRead;
	readonly contextHash: string;
	readonly authorities: readonly SessionDemandImageAuthorityV1[];
	readonly bindings: readonly {
		readonly casHash: string;
		readonly inputHash: string;
		readonly authorityId: string;
	}[];
	readonly snapshots: SnapshotReader;
}) {
	const rows = [];
	for (const item of input.readback.items) {
		const groups = [];
		for (const source of item.workerProjectionInputs()) {
			let missing = "authority binding for exact allocation CAS/inputHash";
			try {
				const bindings = input.bindings.filter(
					(value) =>
						value.casHash === item.metadata.casHash &&
						value.inputHash === source.inputHash,
				);
				if (bindings.length !== 1) throw new Error();
				const binding = bindings[0];
				const authorities = input.authorities.filter(
					(value) => value.id === binding?.authorityId,
				);
				if (authorities.length !== 1) throw new Error();
				const authority = authorities[0];
				if (
					!authority ||
					!/^[a-f0-9]{40}$/.test(authority.sourceSha) ||
					!/^[a-f0-9]{64}$/.test(authority.configurationHash) ||
					authority.contextHash !== input.contextHash ||
					authority.workload.policy.namespace !== input.readback.namespace ||
					source.policy.namespace !== input.readback.namespace
				)
					throw new Error();
				missing = "approved Worker policy matching resourceConfigurationHash";
				if (
					workloadResourceConfigurationHashV1(authority.workload.policy) !==
					source.policy.resourceConfigurationHash
				)
					throw new Error();
				missing =
					"Store-captured Desired/modelProjection accepted by normal resource-input resolver";
				const desired = validateAgentWorkloadDesiredV1(source.deployment);
				if (desired.desiredState === "disabled") throw new Error();
				const resolve = createSessionSandboxResourceInputResolverV1(
					authority.workload,
					{ serviceToken: authority.serviceToken },
				);
				let allocation: SessionSandboxAllocationV1 = {
					...resolve(
						source.binding,
						source.policy,
						desired,
						source.modelProjection,
						desired.desiredState,
						source.binding.generation,
						source.resourceFence,
						true,
					),
					principal: source.binding.principal,
					channelId: source.binding.channelId,
				};
				const cas = item.metadata.snapshotReadCas;
				const snapshot = await projectWorkspaceSnapshotDemandImagesV1({
					desired,
					contextHash: input.contextHash,
					casHash: item.metadata.casHash,
					workloadRevision: cas?.workloadRevision ?? 0,
					fence: cas?.fence ?? 0,
					authority: {
						sourceSha: authority.sourceSha,
						configurationHash: authority.configurationHash,
						contextHash: authority.contextHash,
						resolver: authority.workload.workspaceSnapshotResolver,
					},
					snapshots: input.snapshots,
				});
				if (snapshot.status === "UNKNOWN") {
					missing = snapshot.missing.join("; ");
					throw new Error();
				}
				if (snapshot.projection)
					allocation = {
						...allocation,
						workspaceSnapshotProjection: snapshot.projection(),
					};
				const oauth = selectSessionOAuthProvisioningV1(
					source.binding,
					source.policy.namespace,
					desired.desiredState,
					authority.oauthProvisioning,
				);
				if (oauth) allocation = { ...allocation, oauthProvisioning: oauth };
				missing = "validated pure Session image layout";
				groups.push({
					source: source.source,
					inputHash: source.inputHash,
					status: "PROJECTED_IMAGES",
					workerConfigurationAuthority: {
						sourceSha: authority.sourceSha,
						configurationHash: authority.configurationHash,
					},
					snapshotStatus:
						snapshot.status === "PROJECTED_IMAGES"
							? "BOUND_METADATA_UNSIGNED_PROJECTION"
							: snapshot.status,
					snapshotAuthority: snapshot.provenance,
					images: sessionSandboxImageProjectionV1(allocation),
					missing: [],
				});
			} catch {
				groups.push({
					source: source.source,
					inputHash: source.inputHash,
					status: "UNKNOWN_MISSING_TRUSTED_FIELD",
					images: [],
					knownMain: knownStoredMain(source),
					missing: [missing],
				});
			}
		}
		rows.push({ ...item.metadata, groups });
	}
	return {
		schemaVersion: 1,
		namespace: input.readback.namespace,
		contextHash: input.contextHash,
		observedAtDatabase: input.readback.observedAtDatabase,
		storeSnapshot: input.readback.storeSnapshot,
		pageCount: input.readback.pageCount,
		enumerationComplete: input.readback.enumerationComplete,
		emptyAfterCompleteEnumeration: input.readback.emptyAfterCompleteEnumeration,
		scope: input.readback.scope,
		rows,
		projectionScopeStatus: input.readback.emptyAfterCompleteEnumeration
			? "EMPTY_AFTER_COMPLETE_ENUMERATION"
			: rows.some(
						(row) =>
							row.missing.length > 0 ||
							row.groups.some((group) => group.status !== "PROJECTED_IMAGES"),
					)
				? "ENUMERATED_WITH_UNKNOWN_ROWS"
				: "ENUMERATED_STORED_PROJECTIONS",
		futureSessionObjectsCreated: 0,
		livePodImagesVerified: false,
		sideEffects: {
			claims: 0,
			applies: 0,
			signedUrls: 0,
			secretMaterializations: 0,
			databaseWrites: 0,
			fieldWrites: 0,
			modelCalls: 0,
		},
	};
}

/** Normal Store-only entry; credentials stay in the approved process, never in output or errors. */
export async function readSessionDemandImagesV1(input: {
	readonly databaseUrl: string;
	readonly namespace: string;
	readonly contextHash: string;
	readonly authorities: readonly SessionDemandImageAuthorityV1[];
	readonly bindings: readonly {
		readonly casHash: string;
		readonly inputHash: string;
		readonly authorityId: string;
	}[];
}) {
	try {
		if (
			typeof input.contextHash !== "string" ||
			!/^[a-f0-9]{64}$/.test(input.contextHash) ||
			typeof input.databaseUrl !== "string" ||
			input.databaseUrl.length === 0 ||
			input.databaseUrl.length > 8192 ||
			typeof input.namespace !== "string" ||
			!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(input.namespace) ||
			!Array.isArray(input.authorities) ||
			!Array.isArray(input.bindings)
		)
			throw new Error();
		const url = new URL(input.databaseUrl);
		if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
		url.searchParams.set(
			"options",
			`${url.searchParams.get("options") ?? ""} -c default_transaction_read_only=on -c statement_timeout=5000`,
		);
		const reader = openPostgresSessionSandboxImageReaderV1({
			databaseUrl: url.toString(),
		});
		const snapshots = openPostgresWorkspaceSnapshotMaterializationReaderV1(
			url.toString(),
		);
		try {
			return await projectSessionDemandImagesV1({
				...input,
				readback: await reader.read(input.namespace),
				snapshots,
			});
		} finally {
			await Promise.allSettled([reader.close(), snapshots.close()]);
		}
	} catch {
		throw new Error("SESSION_IMAGE_READ_FAILED");
	}
}
