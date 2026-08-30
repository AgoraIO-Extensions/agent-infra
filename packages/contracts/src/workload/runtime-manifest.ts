import { z } from "zod";

import { WorkloadSchemaVersionV1Schema } from "./common.ts";

const healthPathPattern =
	/^\/(?!\/)(?!(?:.*\/)?\.{1,2}(?:\/|$))(?!.*\/\/)[A-Za-z0-9._~/-]*(?![\s\S])/;

export const RuntimeCapabilitySetV1Schema = z.strictObject({
	modelSelection: z.boolean().default(false),
	attachments: z.boolean().default(false),
	resultFiles: z.boolean().default(false),
	connection: z.boolean().default(false),
	supplementaryInstruction: z.boolean().default(false),
});

export const RuntimeServiceV1Schema = z.strictObject({
	port: z.number().int().min(1).max(65_535),
});

export const RuntimeHealthV1Schema = z.strictObject({
	path: z.string().regex(healthPathPattern),
});

export const SelfManagedRuntimeManifestV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	interactionMode: z.literal("self-managed"),
	service: RuntimeServiceV1Schema,
	health: RuntimeHealthV1Schema,
	capabilities: RuntimeCapabilitySetV1Schema.optional(),
});

export const PlatformAdapterRuntimeManifestV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	interactionMode: z.literal("platform-adapter"),
	protocol: z.literal("acp"),
	service: RuntimeServiceV1Schema,
	health: RuntimeHealthV1Schema,
	capabilities: RuntimeCapabilitySetV1Schema.optional(),
});

export const RuntimeManifestV1Schema = z.discriminatedUnion("interactionMode", [
	SelfManagedRuntimeManifestV1Schema,
	PlatformAdapterRuntimeManifestV1Schema,
]);

export type RuntimeCapabilitySetV1 = z.infer<
	typeof RuntimeCapabilitySetV1Schema
>;
export type RuntimeManifestV1 = z.infer<typeof RuntimeManifestV1Schema>;

export function resolveRuntimeManifestCapabilitiesV1(
	manifestInput: unknown,
): RuntimeCapabilitySetV1 {
	const manifest = RuntimeManifestV1Schema.parse(manifestInput);
	return RuntimeCapabilitySetV1Schema.parse(
		manifest.interactionMode === "platform-adapter"
			? (manifest.capabilities ?? {})
			: {},
	);
}
