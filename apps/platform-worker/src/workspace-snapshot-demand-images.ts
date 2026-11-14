import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import type {
	WorkspaceSnapshotMaterializationReadV1,
	WorkspaceSnapshotMaterializationRecordV1,
} from "@agent-infra/platform-store";
import type { WorkspaceSnapshotPodProjectionV1 } from "./workspace-snapshot-materializer.js";
import { workspaceSnapshotResolverImagePolicyV1 } from "./workspace-snapshot-resolver.js";

const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Result = {
	status: "PROJECTED_IMAGES" | "NOT_APPLICABLE_EMPTY_BINDINGS" | "UNKNOWN";
	images: readonly {
		name: string;
		kind: "init";
		image: string;
		digest: string;
		entrypointSource: "pod-override";
		entrypointShapeHash: string;
	}[];
	provenance: {
		configurationSourceSha: string;
		configurationHash: string;
		contextHash: string;
		casHash: string;
		bindingHash: string;
		policyHash: string;
		producerModule: string;
		policyField: string;
	} | null;
	/** Private Pod shape stays in memory; JSON contains only the image metadata above. */
	projection: (() => WorkspaceSnapshotPodProjectionV1) | null;
	missing: readonly string[];
};

/** Normal Store materialization reader + the normal resolver's unsigned .project only. */
export async function projectWorkspaceSnapshotDemandImagesV1(input: {
	readonly desired: unknown;
	readonly contextHash: string;
	readonly casHash: string;
	readonly workloadRevision: number;
	readonly fence: number;
	/** From the approved Worker configuration holder; source+content hash retain its provenance. */
	readonly authority?: {
		readonly sourceSha: string;
		readonly configurationHash: string;
		readonly contextHash: string;
		readonly resolver: unknown;
	};
	readonly snapshots: {
		read(
			value: WorkspaceSnapshotMaterializationReadV1,
		): Promise<readonly WorkspaceSnapshotMaterializationRecordV1[]>;
	};
}): Promise<Result> {
	let missing = "validated captured Desired";
	try {
		const desired = validateAgentWorkloadDesiredV1(input.desired);
		if (!desired.workspaceSnapshots?.length)
			return {
				status: "NOT_APPLICABLE_EMPTY_BINDINGS",
				images: [],
				provenance: null,
				projection: null,
				missing: [],
			};
		missing =
			"approved Worker configuration source/hash/context and current Store CAS";
		const authority = input.authority;
		if (
			!authority ||
			!/^[a-f0-9]{40}$/.test(authority.sourceSha) ||
			!/^[a-f0-9]{64}$/.test(authority.configurationHash) ||
			!/^[a-f0-9]{64}$/.test(input.contextHash) ||
			!/^[a-f0-9]{64}$/.test(input.casHash) ||
			authority.contextHash !== input.contextHash ||
			![input.workloadRevision, input.fence].every(
				(value) => Number.isSafeInteger(value) && value > 0,
			)
		)
			throw new Error();
		missing =
			"normal workspaceSnapshotResolver captured policy.imageDigest and unsigned .project";
		const policy = workspaceSnapshotResolverImagePolicyV1(authority.resolver);
		const project = Object.getOwnPropertyDescriptor(
			authority.resolver,
			"project",
		)?.value;
		if (!policy || typeof project !== "function") throw new Error();
		missing =
			"Store materialization metadata matching exact Desired bindings/revision/fence";
		const records = await input.snapshots.read({
			agentId: desired.agentId,
			configurationRevision: desired.configRevision,
			workloadRevision: input.workloadRevision,
			fence: input.fence,
			bindings: desired.workspaceSnapshots.map(({ snapshotId, name }) => ({
				snapshotId,
				name,
			})),
		});
		const metadata = records.map((value) => ({
			snapshotId: value.snapshotId,
			name: value.name,
			digest: value.digest,
			sizeBytes: value.sizeBytes,
			objectRef: value.objectRef,
			mountPath: `/opt/agent/workspaces/${value.name}`,
		}));
		const sort = <T extends { name: string }>(values: readonly T[]) =>
			[...values].sort((a, b) => a.name.localeCompare(b.name));
		if (!isDeepStrictEqual(sort(metadata), sort(desired.workspaceSnapshots)))
			throw new Error();
		const shape: WorkspaceSnapshotPodProjectionV1 = project(records, {
			agentId: desired.agentId,
			configurationRevision: desired.configRevision,
		});
		missing = "normal materializer init image matching captured policy";
		if (
			shape.initContainers.length !== 1 ||
			shape.initContainers[0]?.image !== policy.image
		)
			throw new Error();
		return {
			status: "PROJECTED_IMAGES",
			images: shape.initContainers.map((value) => ({
				name: value.name,
				kind: "init",
				image: policy.image,
				digest: policy.digest,
				entrypointSource: "pod-override",
				entrypointShapeHash: hash([value.command ?? null, value.args ?? null]),
			})),
			provenance: {
				configurationSourceSha: authority.sourceSha,
				configurationHash: authority.configurationHash,
				contextHash: input.contextHash,
				casHash: input.casHash,
				bindingHash: hash(sort(metadata)),
				policyHash: policy.policyHash,
				producerModule: policy.producerModule,
				policyField: policy.policyField,
			},
			projection: () => shape,
			missing: [],
		};
	} catch {
		return {
			status: "UNKNOWN",
			images: [],
			provenance: null,
			projection: null,
			missing: [missing],
		};
	}
}
