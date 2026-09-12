import { z } from "zod";

export const modelIdentifier = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const reasoningLevel = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const levels = z
	.array(reasoningLevel)
	.min(1)
	.max(32)
	.refine((values) => new Set(values).size === values.length);

export const ModelEndpointV1Schema = z
	.strictObject({
		endpointId: modelIdentifier,
		baseUrl: z.string().min(1).max(2048),
		origin: z.string().min(1).max(2048),
		protocol: z.literal("openai-responses-v1"),
		security: z.strictObject({
			tls: z.enum(["verify-peer", "loopback-http"]),
			redirects: z.literal("reject"),
		}),
		capabilities: z.strictObject({
			streaming: z.literal(true),
			tools: z.literal(true),
			reasoningLevels: levels,
		}),
		allowedModels: z.array(modelIdentifier).min(1).max(1024).nullable(),
		available: z.boolean(),
	})
	.refine((value) => {
		try {
			const url = new URL(value.baseUrl);
			return (
				!/[\s\\?#]/.test(value.baseUrl) &&
				!url.username &&
				!url.password &&
				url.origin === value.origin &&
				(value.security.tls === "verify-peer"
					? url.protocol === "https:"
					: /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/|$)/.test(
							value.baseUrl,
						))
			);
		} catch {
			return false;
		}
	});
export type ModelEndpointV1 = z.infer<typeof ModelEndpointV1Schema>;
const snapshotSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		revision: modelIdentifier,
		validUntil: z.number().int().positive(),
		endpoints: z.array(ModelEndpointV1Schema).max(1024),
	})
	.refine(
		({ endpoints }) =>
			new Set(endpoints.map((entry) => entry.endpointId)).size ===
			endpoints.length,
	);

export interface ModelCatalogAdapterV1 {
	resolve(
		input: { readonly endpointId: string; readonly catalogRevision: string },
		options: { readonly signal: AbortSignal },
	): Promise<ModelEndpointV1>;
}

export class ModelConfigurationErrorV1 extends Error {
	constructor(readonly retryable = false) {
		super("MODEL_CONFIGURATION_UNAVAILABLE");
	}
}

export async function modelOperationV1<T>(
	signal: AbortSignal,
	operation: () => Promise<T>,
): Promise<T> {
	let abort = () => {};
	try {
		signal.throwIfAborted();
		return await Promise.race([
			new Promise<never>((_resolve, reject) => {
				abort = () => reject(new ModelConfigurationErrorV1(true));
				signal.addEventListener("abort", abort, { once: true });
			}),
			operation(),
		]);
	} catch (error) {
		throw new ModelConfigurationErrorV1(
			error instanceof ModelConfigurationErrorV1 ? error.retryable : true,
		);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

/** Deployment owns snapshot loading and refresh. No caller-supplied URL is resolved. */
export function createDeploymentModelCatalogAdapterV1(options: {
	readonly load: (signal: AbortSignal) => Promise<unknown>;
}): ModelCatalogAdapterV1 {
	return {
		async resolve(input, { signal }) {
			try {
				signal.throwIfAborted();
				const snapshot = snapshotSchema.parse(
					await modelOperationV1(signal, () => options.load(signal)),
				);
				signal.throwIfAborted();
				const endpoint = snapshot.endpoints.find(
					(entry) => entry.endpointId === input.endpointId,
				);
				if (
					snapshot.revision !== input.catalogRevision ||
					snapshot.validUntil <= Date.now() ||
					!endpoint?.available
				)
					throw new ModelConfigurationErrorV1();
				return endpoint;
			} catch (error) {
				throw new ModelConfigurationErrorV1(
					error instanceof ModelConfigurationErrorV1 && error.retryable,
				);
			}
		},
	};
}

export function createFakeModelCatalogAdapterV1(
	snapshot: unknown,
): ModelCatalogAdapterV1 {
	const value = structuredClone(snapshot);
	return createDeploymentModelCatalogAdapterV1({
		load: async () => structuredClone(value),
	});
}
