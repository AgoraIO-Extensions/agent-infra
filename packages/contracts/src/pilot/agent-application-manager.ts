import { z } from "zod";
import { OpaqueIdV1Schema, SchemaVersionV1Schema } from "../index.ts";

export const AgentApplicationManagerRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
});
export const AgentApplicationManagerResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	agentId: OpaqueIdV1Schema,
	applicationId: OpaqueIdV1Schema,
	granted: z.boolean(),
	authorizationRevision: z.string().min(1).nullable(),
	replayed: z.boolean(),
});
