import { z } from "zod";
import {
	NativeMetadataObjectScopeV1Schema,
	NativeMetadataProjectionV1Schema,
	NativeMetadataRequestIdentityV1Schema,
	NativeMetadataSelectorV1Schema,
} from "../native-metadata-v1.ts";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const required = z.string().min(1).max(8192).refine((value) => !value.includes("\0"));

const identity = NativeMetadataRequestIdentityV1Schema.shape;

export const RuntimeNativeMetadataBindingRequestV1Schema = z.strictObject(identity);
export type RuntimeNativeMetadataBindingRequestV1 = z.infer<
	typeof RuntimeNativeMetadataBindingRequestV1Schema
>;

export const RuntimeNativeMetadataBindingResponseV1Schema = z.strictObject({
	...identity,
	originalHostScopeRef: sha256,
});
export type RuntimeNativeMetadataBindingResponseV1 = z.infer<
	typeof RuntimeNativeMetadataBindingResponseV1Schema
>;

export const RuntimeNativeMetadataProofClaimsV1Schema = z.strictObject({
	...identity,
	purpose: z.literal("native_metadata_read"),
	issuedAt: z.number().int().nonnegative().safe(),
	issuer: required,
	audience: z.literal("runtime_host.native_metadata_read"),
	workerId: required,
	keyVersion: required,
	originalHostScopeRef: sha256,
	requestDigest: sha256,
});
export type RuntimeNativeMetadataProofClaimsV1 = z.infer<
	typeof RuntimeNativeMetadataProofClaimsV1Schema
>;

export const RuntimeNativeMetadataProofV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	format: z.literal("native-metadata-jws"),
	token: required,
});
export type RuntimeNativeMetadataProofV1 = z.infer<
	typeof RuntimeNativeMetadataProofV1Schema
>;

export const RuntimeNativeMetadataReadRequestV1Schema = z.strictObject({
	...identity,
	originalHostScopeRef: sha256,
	proof: RuntimeNativeMetadataProofV1Schema,
});
export type RuntimeNativeMetadataReadRequestV1 = z.infer<
	typeof RuntimeNativeMetadataReadRequestV1Schema
>;

export const RuntimeNativeMetadataReadResponseV1Schema = z.strictObject({
	...identity,
	originalHostScopeRef: sha256,
	projection: NativeMetadataProjectionV1Schema,
});
export type RuntimeNativeMetadataReadResponseV1 = z.infer<
	typeof RuntimeNativeMetadataReadResponseV1Schema
>;

export type RuntimeNativeMetadataSelectorV1 = z.infer<
	typeof NativeMetadataSelectorV1Schema
>;
export type RuntimeNativeMetadataScopeV1 = z.infer<
	typeof NativeMetadataObjectScopeV1Schema
>;
