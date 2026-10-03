import { z } from "zod";
import {
	OpaqueIdV1Schema,
	RequestIdV1Schema,
	TraceIdV1Schema,
} from "../index.ts";
import { RuntimeCapabilitiesV1Schema } from "./events.ts";

export const WorkloadReadinessBindingV1Schema = z.strictObject({
	workerId: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	workloadRevision: z.number().int().positive().safe(),
	fence: z.number().int().positive().safe(),
	imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
export const WorkloadReadinessGrantV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	format: z.literal("workload-readiness-jws"),
	token: z
		.string()
		.max(16384)
		.regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
});
export const WorkloadReadinessRequestBindingV1Schema =
	WorkloadReadinessBindingV1Schema.extend({
		schemaVersion: z.literal(1),
		requestId: RequestIdV1Schema,
		traceId: TraceIdV1Schema,
	});
export const WorkloadReadinessGrantClaimsV1Schema =
	WorkloadReadinessRequestBindingV1Schema.extend({
		issuer: z.string().min(1).max(256),
		audience: z.literal("runtime_host_readiness"),
		purpose: z.literal("readiness.read"),
		grantId: OpaqueIdV1Schema,
		/** Unix epoch milliseconds; validity is checked by the signed-claim verifier. */
		issuedAt: z.number().int().positive().safe(),
		expiresAt: z.number().int().positive().safe(),
	});
export const WorkloadReadinessRequestV1Schema =
	WorkloadReadinessRequestBindingV1Schema.extend({
		grant: WorkloadReadinessGrantV1Schema,
	});
export const WorkloadReadinessResponseV1Schema =
	WorkloadReadinessRequestBindingV1Schema.extend({
		core: z.literal("passed"),
		capabilities: RuntimeCapabilitiesV1Schema,
	});
export type WorkloadReadinessBindingV1 = z.infer<
	typeof WorkloadReadinessBindingV1Schema
>;
export type WorkloadReadinessGrantV1 = z.infer<
	typeof WorkloadReadinessGrantV1Schema
>;
export type WorkloadReadinessGrantClaimsV1 = z.infer<
	typeof WorkloadReadinessGrantClaimsV1Schema
>;
export type WorkloadReadinessRequestV1 = z.infer<
	typeof WorkloadReadinessRequestV1Schema
>;
export type WorkloadReadinessResponseV1 = z.infer<
	typeof WorkloadReadinessResponseV1Schema
>;

export const WorkloadReadinessV1SchemaDefinitions = {
	WorkloadReadinessBindingV1: WorkloadReadinessBindingV1Schema,
	WorkloadReadinessGrantV1: WorkloadReadinessGrantV1Schema,
	WorkloadReadinessGrantClaimsV1: WorkloadReadinessGrantClaimsV1Schema,
	WorkloadReadinessRequestV1: WorkloadReadinessRequestV1Schema,
	WorkloadReadinessResponseV1: WorkloadReadinessResponseV1Schema,
};
