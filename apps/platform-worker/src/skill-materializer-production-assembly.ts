import { isDeepStrictEqual } from "node:util";
import type { SkillHubAppliedReceiptV1 } from "@agent-infra/contracts";
import type {
	ObjectStorageDataV1,
	SkillPackageMaterializationInputV1,
} from "@agent-infra/object-storage";
import {
	createSkillPackageConsumerV1,
	type SkillPackageConsumerOptionsV1,
	SkillPackageMaterializerV1,
} from "@agent-infra/object-storage";
import type { SkillPackagePublicationObjectV1 } from "@agent-infra/platform-core";
import type {
	WorkloadSkillMaterializationBindingV1,
	WorkloadSkillMaterializationInputV1,
} from "./skill-materialization.js";
import { createObjectStorageWorkloadSkillMaterializerV1 } from "./skill-materialization.js";
import type { DeploymentSkillMaterializerFactoryV1 } from "./skill-materializer-assembly.js";
import {
	createSkillHubStoreMaterializationAdapterV1,
	type SkillHubStoreMaterializationAdapterOptionsV1,
} from "./skill-materializer-store-adapter.js";

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

/**
 * Complete production input for the Store-backed Worker materializer. Store,
 * actor and package-object facts stay deployment-owned; workload callers only
 * provide the bounded revision and fence consumed by the adapter.
 */
export type DeploymentSkillMaterializationConfigurationV1 = Omit<
	DeploymentSkillMaterializerAssemblyV1,
	"resolveBindings" | "recordAppliedReceipt" | "verifyAdmission"
> &
	Omit<
		SkillHubStoreMaterializationAdapterOptionsV1,
		"agentVersion" | "resolvePackageObject" | "store"
	> & {
		readonly agentVersion: string;
		readonly store: SkillHubStoreMaterializationAdapterOptionsV1["store"] & {
			readonly readPublication: SkillPackageConsumerOptionsV1["readPublication"];
		};
		readonly resolveAdmissionPolicy: SkillPackageConsumerOptionsV1["resolveAdmissionPolicy"];
		readonly sourceVerifier: SkillPackageConsumerOptionsV1["sourceVerifier"];
	};

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
		expectedMetadata: {
			sizeBytes: object.sizeBytes,
			mediaType: object.mediaType,
		},
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

/**
 * Compose the Store adapter with the existing physical object-storage path.
 * Invalid or incomplete optional deployment input leaves Skill materialization
 * unavailable so ordinary Workload startup can continue.
 */
export function createDeploymentSkillHubMaterializerFactoryV1(
	configuration: DeploymentSkillMaterializationConfigurationV1 | undefined,
): DeploymentSkillMaterializerFactoryV1 | undefined {
	if (
		!configuration ||
		typeof configuration.agentVersion !== "string" ||
		typeof configuration.store?.readPublication !== "function" ||
		typeof configuration.resolveAdmissionPolicy !== "function" ||
		typeof configuration.sourceVerifier?.verify !== "function"
	)
		return undefined;
	try {
		const consumer = createSkillPackageConsumerV1({
			storage: configuration.storage,
			readPublication: (input) => configuration.store.readPublication(input),
			resolveAdmissionPolicy: configuration.resolveAdmissionPolicy,
			sourceVerifier: configuration.sourceVerifier,
		});
		const adapter = createSkillHubStoreMaterializationAdapterV1({
			store: configuration.store,
			agentVersion: configuration.agentVersion,
			actor: configuration.actor,
			resolvePackageObject: async (input) =>
				(await consumer.verify(input)).packageObject,
		});
		// Validate deployment inputs now. Each invocation below has its own exact binding snapshot.
		createDeploymentSkillMaterializerFactoryV1({
			...configuration,
			resolveBindings: adapter.resolveBindings,
			recordAppliedReceipt: adapter.recordAppliedReceipt,
			verifyAdmission: async () => {
				throw new Error("Unbound Skill admission");
			},
		});
		return async (context) => ({
			async materialize(input) {
				const signal = input.signal
					? AbortSignal.any([input.signal, context.signal])
					: context.signal;
				const scopedInput = { ...input, signal };
				let original:
					| readonly WorkloadSkillMaterializationBindingV1[]
					| undefined;
				const current = async () => {
					signal.throwIfAborted();
					const bindings = await adapter.resolveBindings(scopedInput);
					signal.throwIfAborted();
					if (original && !isDeepStrictEqual(original, bindings))
						throw new Error("Skill binding changed");
					return bindings;
				};
				const verifyAdmission = async (
					item: SkillPackageMaterializationInputV1,
				) => {
					const bindings = await current();
					const binding = bindings.find(
						(b) =>
							b.name === item.name &&
							b.skillVersion.version === item.version &&
							isDeepStrictEqual(b.packageObject, item.packageObject),
					);
					if (!original || !binding)
						throw new Error("Skill publication binding unavailable");
					const publication = await consumer.verify({
						skillVersionId: binding.skillVersion.skillVersionId,
						packageObjectVersion: binding.skillVersion.packageObjectVersion,
						signal,
					});
					for (const key of [
						"skillId",
						"skillVersionId",
						"provider",
						"version",
						"packageObjectVersion",
						"packageDigest",
						"manifestDigest",
						"signatureDigest",
					] as const)
						if (publication.version[key] !== binding.skillVersion[key])
							throw new Error("Skill publication mismatch");
					if (
						publication.version.name !== item.name ||
						publication.version.packageDigest !== item.packageDigest ||
						publication.version.manifestDigest !== item.manifestDigest
					)
						throw new Error("Skill publication mismatch");
					await current();
				};
				const factory = createDeploymentSkillMaterializerFactoryV1({
					...configuration,
					resolveBindings: async () => {
						original = await current();
						return original;
					},
					verifyAdmission,
					recordAppliedReceipt: async (receipt) => {
						await current();
						await adapter.recordAppliedReceipt(receipt);
					},
				});
				const materializer = await factory({ ...context, signal });
				return materializer.materialize(scopedInput);
			},
		});
	} catch {
		return undefined;
	}
}
