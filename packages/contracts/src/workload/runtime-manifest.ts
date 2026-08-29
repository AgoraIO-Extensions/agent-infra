import { z } from "zod";

import { WorkloadSchemaVersionV1Schema } from "./common.ts";

const healthPathPattern =
	/^\/(?!\/)(?!(?:.*\/)?\.{1,2}(?:\/|$))(?!.*\/\/)[A-Za-z0-9._~/-]*$/;

export const RuntimeCapabilitySetV1Schema = z.strictObject({
	modelSelection: z.boolean().optional(),
	attachments: z.boolean().optional(),
	resultFiles: z.boolean().optional(),
	connection: z.boolean().optional(),
	supplementaryInstruction: z.boolean().optional(),
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
