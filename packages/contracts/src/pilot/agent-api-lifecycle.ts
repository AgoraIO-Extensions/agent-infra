import { z } from "zod";
import { OpaqueIdV1Schema, SchemaVersionV1Schema } from "../index.ts";

export const AgentApiLifecycleRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	command: z.enum(["start", "stop", "restart"]),
});

export const AgentApiLifecycleResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	agentId: OpaqueIdV1Schema,
	status: z.enum(["available", "stopped"]),
	revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
	replayed: z.boolean(),
});

export const AgentApiStateResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	agentId: OpaqueIdV1Schema,
	status: z.enum([
		"pending_approval",
		"withdrawn",
		"rejected",
		"creating",
		"available",
		"stopped",
		"creation_failed",
		"disabled",
	]),
	serviceAvailability: z
		.enum(["ready", "starting", "updating", "unavailable"])
		.nullable(),
	revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
