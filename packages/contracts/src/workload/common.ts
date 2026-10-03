import { z } from "zod";

import {
	OpaqueIdV1Schema,
	ProtocolErrorV1Schema,
	Rfc3339TimestampV1Schema,
	SchemaVersionV1Schema,
} from "../index.ts";

export const WorkloadSchemaVersionV1Schema = SchemaVersionV1Schema;
export const WorkloadOpaqueIdV1Schema = OpaqueIdV1Schema;
export const WorkloadRevisionV1Schema = z.number().int().nonnegative();
export const WorkloadFenceV1Schema = z.number().int().nonnegative();
export const WorkloadTimestampV1Schema = Rfc3339TimestampV1Schema;
export const WorkloadBoundaryErrorV1Schema = ProtocolErrorV1Schema;

export type WorkloadBoundaryErrorV1 = z.infer<
	typeof WorkloadBoundaryErrorV1Schema
>;
