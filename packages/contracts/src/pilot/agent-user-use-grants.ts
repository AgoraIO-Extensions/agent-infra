import { z } from "zod";
import { OpaqueIdV1Schema, SchemaVersionV1Schema } from "../index.ts";

export const AgentUserUseRevokeRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	expectedRevision: z.number().int().nonnegative().safe(),
});

export const AgentUserUseRevokeResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	agentId: OpaqueIdV1Schema,
	userId: OpaqueIdV1Schema,
	granted: z.literal(false),
	authorizationRevision: z.string().min(1).nullable(),
	replayed: z.boolean(),
});
