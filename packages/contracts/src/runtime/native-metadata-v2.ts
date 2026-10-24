import { z } from "zod";

import { SchemaVersionV1Schema } from "../index.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const metadataName = z.string().min(1).max(256);
const metadataVersion = z.string().min(1).max(128);

export const NativeMetadataCommandEffectV2Schema = z.enum([
	"read_only",
	"state_changing",
]);
export type NativeMetadataCommandEffectV2 = z.infer<
	typeof NativeMetadataCommandEffectV2Schema
>;

export const NativeMetadataCommandParameterV2Schema = z.strictObject({
	kind: z.literal("text"),
	required: z.boolean(),
	hint: z.string().max(1024),
});
export type NativeMetadataCommandParameterV2 = z.infer<
	typeof NativeMetadataCommandParameterV2Schema
>;

export const NativeMetadataCommandCapabilityV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	id: digest,
	kind: z.literal("command"),
	name: metadataName,
	description: z.string().max(4096),
	source: z.strictObject({ name: metadataName, version: metadataVersion }),
	parameters: z.array(NativeMetadataCommandParameterV2Schema).max(1),
	effect: NativeMetadataCommandEffectV2Schema,
	availability: z.literal("available"),
});
export type NativeMetadataCommandCapabilityV2 = z.infer<
	typeof NativeMetadataCommandCapabilityV2Schema
>;

export const NativeMetadataCommandsProjectionV2Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	selector: z.literal("commands"),
	revision: digest,
	capabilities: z.array(NativeMetadataCommandCapabilityV2Schema).max(128),
});
export type NativeMetadataCommandsProjectionV2 = z.infer<
	typeof NativeMetadataCommandsProjectionV2Schema
>;
