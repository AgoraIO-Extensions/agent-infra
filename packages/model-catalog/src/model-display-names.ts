import { z } from "zod";
import {
	ModelCatalogSnapshotV1Schema,
	ModelConfigurationErrorV1,
	modelIdentifier,
	modelOperationV1,
} from "./catalog.js";

const modelDisplayMetadata = z.strictObject({
	schemaVersion: z.literal(1),
	models: z
		.array(
			z.strictObject({
				endpointId: modelIdentifier,
				modelId: modelIdentifier,
				displayName: z
					.string()
					.min(1)
					.max(128)
					.refine((value) => value.trim() === value && !/\p{Cc}/u.test(value)),
			}),
		)
		.max(32768),
});

export type ModelDisplayNameLookupV1 = (model: {
	readonly endpointId: string;
	readonly modelId: string;
}) => string;

const pair = (endpointId: string, modelId: string) =>
	JSON.stringify([endpointId, modelId]);

/** Display metadata never changes the policy catalog or the authorized candidate set. */
export function createDeploymentModelDisplayNamesV1(input: {
	readonly metadata?: unknown;
	readonly modelCatalog: {
		readonly revision: string;
		readonly load: (signal: AbortSignal) => Promise<unknown>;
	};
}): (signal: AbortSignal) => Promise<ModelDisplayNameLookupV1> {
	let metadata: z.infer<typeof modelDisplayMetadata>;
	let names: Map<string, string>;
	try {
		metadata = modelDisplayMetadata.parse(
			input.metadata === undefined
				? { schemaVersion: 1, models: [] }
				: input.metadata,
		);
		names = new Map(
			metadata.models.map(({ endpointId, modelId, displayName }) => [
				pair(endpointId, modelId),
				displayName,
			]),
		);
		if (names.size !== metadata.models.length) throw new Error();
	} catch {
		throw new ModelConfigurationErrorV1();
	}
	return async (signal) => {
		try {
			signal.throwIfAborted();
			if (names.size === 0) return ({ modelId }) => modelId;
			const snapshot = ModelCatalogSnapshotV1Schema.parse(
				await modelOperationV1(signal, () => input.modelCatalog.load(signal)),
			);
			signal.throwIfAborted();
			if (
				snapshot.revision !== input.modelCatalog.revision ||
				snapshot.validUntil <= Date.now()
			)
				throw new Error();
			const endpoints = new Map(
				snapshot.endpoints.map((endpoint) => [endpoint.endpointId, endpoint]),
			);
			for (const { endpointId, modelId } of metadata.models) {
				const endpoint = endpoints.get(endpointId);
				if (
					!endpoint ||
					(endpoint.allowedModels !== null &&
						!endpoint.allowedModels.includes(modelId))
				)
					throw new Error();
			}
			return ({ endpointId, modelId }) =>
				names.get(pair(endpointId, modelId)) ?? modelId;
		} catch (error) {
			throw new ModelConfigurationErrorV1(
				error instanceof ModelConfigurationErrorV1 && error.retryable,
			);
		}
	};
}
