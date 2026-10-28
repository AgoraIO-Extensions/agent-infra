import {
	createS3ObjectStorageV1,
	type S3ObjectStorageOptionsV1,
} from "./s3.js";
import { type ObjectStorageDataV1, ObjectStorageError } from "./types.js";

// Deployment modules may load the package through both ESM and CommonJS loaders.
// Keep the server-only factory registry on this process global, never on request data.
const registryKey = Symbol.for("agent-infra.evaluation-storage-v1");
const registry = globalThis as typeof globalThis & {
	[registryKey]?: WeakSet<ObjectStorageDataV1>;
};
registry[registryKey] ??= new WeakSet<ObjectStorageDataV1>();
const evaluationStores = registry[registryKey];
/** Separate object namespace, using the existing bounded, versioned S3 adapter. */
export function createEvaluationObjectStorageV1(
	options: Omit<S3ObjectStorageOptionsV1, "prefix" | "contentPolicy">,
) {
	const storage = createS3ObjectStorageV1({
		...options,
		prefix: "eval/",
		contentPolicy: "file",
	});
	evaluationStores.add(storage);
	return storage;
}
/** Deployment must use the purpose-specific factory, never an ordinary FileGrant adapter. */
export function requireEvaluationObjectStorageV1(
	storage: ObjectStorageDataV1,
): void {
	if (!evaluationStores.has(storage)) throw new ObjectStorageError("invalid");
}
