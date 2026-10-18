import { z } from "zod";
import { OpaqueIdV1Schema, SchemaVersionV1Schema } from "../index.ts";

/** Owner 给用户授予 / 撤销某个 Agent 的 API 管理权（#2759）；与用户 API 使用授权对称。 */
export const AgentUserManageGrantRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	expectedRevision: z.number().int().nonnegative().safe(),
});
export const AgentUserManageGrantResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	agentId: OpaqueIdV1Schema,
	userId: OpaqueIdV1Schema,
	granted: z.literal(true),
	authorizationRevision: z.string().min(1),
	replayed: z.boolean(),
});

export const AgentUserManageRevokeRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	expectedRevision: z.number().int().nonnegative().safe(),
});
export const AgentUserManageRevokeResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	agentId: OpaqueIdV1Schema,
	userId: OpaqueIdV1Schema,
	granted: z.literal(false),
	authorizationRevision: z.string().min(1).nullable(),
	replayed: z.boolean(),
});
