import type { SkillHubAppliedReceiptV1 } from "@agent-infra/contracts";
import type {
	ObjectStorageDataV1,
	SkillPackageMaterializationInputV1,
} from "@agent-infra/object-storage";
import { SkillPackageMaterializerV1 } from "@agent-infra/object-storage";
import type { SkillPackagePublicationObjectV1 } from "@agent-infra/platform-core";
import type {
	WorkloadSkillMaterializationBindingV1,
	WorkloadSkillMaterializationInputV1,
} from "./skill-materialization.js";
import { createObjectStorageWorkloadSkillMaterializerV1 } from "./skill-materialization.js";
import type { DeploymentSkillMaterializerFactoryV1 } from "./skill-materializer-assembly.js";

type Materializer = Pick<
	SkillPackageMaterializerV1,
	"materialize" | "readCurrentDetails"
>;

export interface DeploymentSkillMaterializerAssemblyV1 {
	readonly storage: ObjectStorageDataV1;
	readonly assemblyRoot: string;
	readonly runtimeUid: number;
	readonly resolveBindings: (
		input: WorkloadSkillMaterializationInputV1,
	) => Promise<readonly WorkloadSkillMaterializationBindingV1[]>;
	readonly recordAppliedReceipt: (
		receipt: SkillHubAppliedReceiptV1,
	) => Promise<void>;
	readonly verifyAdmission: (
		input: SkillPackageMaterializationInputV1,
	) => Promise<void>;
}

async function readObject(
	storage: ObjectStorageDataV1,
	object: SkillPackagePublicationObjectV1,
	signal: AbortSignal,
): Promise<SkillPackagePublicationObjectV1 & { readonly bytes: Uint8Array }> {
	signal.throwIfAborted();
	const stream = await storage.download({
		objectRef: object.objectRef,
		version: object.version,
		etag: object.etag,
		expiresAt: new Date(Date.now() + 300_000).toISOString(),
	});
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	const onAbort = () => {
		void reader.cancel(signal.reason).catch(() => undefined);
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		signal.throwIfAborted();
		for (;;) {
			signal.throwIfAborted();
			const next = await reader.read();
			signal.throwIfAborted();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > object.sizeBytes)
				throw new Error("Skill package is oversized");
			chunks.push(next.value);
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	if (size !== object.sizeBytes) throw new Error("Skill package size mismatch");
	return { ...object, bytes: Buffer.concat(chunks) };
}

/**
 * Compose the existing physical materializer and Worker bridge from deployment
 * ports. The deployment owns credentials and the assembly root; no caller data
 * enters this factory.
 */
export function createDeploymentSkillMaterializerFactoryV1(
	assembly: DeploymentSkillMaterializerAssemblyV1,
): DeploymentSkillMaterializerFactoryV1 {
	if (
		!assembly ||
		typeof assembly !== "object" ||
		typeof assembly.storage?.download !== "function" ||
		typeof assembly.assemblyRoot !== "string" ||
		!assembly.assemblyRoot.startsWith("/") ||
		!Number.isSafeInteger(assembly.runtimeUid) ||
		assembly.runtimeUid <= 0 ||
		typeof assembly.resolveBindings !== "function" ||
		typeof assembly.recordAppliedReceipt !== "function" ||
		typeof assembly.verifyAdmission !== "function"
	)
		throw new Error("SKILL_MATERIALIZER_CONFIGURATION_INVALID");
	return async ({ signal }) => {
		signal.throwIfAborted();
		return createObjectStorageWorkloadSkillMaterializerV1({
			materializerFor: () => {
				const materializer: Materializer = new SkillPackageMaterializerV1({
					assemblyRoot: assembly.assemblyRoot,
					runtimeUid: assembly.runtimeUid,
					readPackage: (object) => readObject(assembly.storage, object, signal),
					verifyAdmission: assembly.verifyAdmission,
				});
				return materializer;
			},
			resolveBindings: assembly.resolveBindings,
			writeAppliedReceipt: assembly.recordAppliedReceipt,
		});
	};
}
