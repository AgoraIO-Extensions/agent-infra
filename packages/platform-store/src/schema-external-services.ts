import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	primaryKey,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import { agents } from "./schema-agents";
import { platformSchema } from "./schema-common";
export const externalServices = platformSchema.table("external_services", {
	id: text("id").primaryKey(),
	modelEndpointId: text("model_endpoint_id").unique(),
	enabledOnce: boolean("enabled_once").notNull().default(false),
	revision: integer("revision").notNull().default(0),
	active: integer("active"),
	verified: integer("verified"),
});
export const externalServiceVersions = platformSchema.table(
	"external_service_versions",
	{
		id: text("id")
			.notNull()
			.references(() => externalServices.id),
		revision: integer("revision").notNull(),
		url: text("url").notNull(),
		credential: jsonb("credential").notNull(),
		runtimeDiscovery: boolean("runtime_discovery").notNull().default(false),
	},
	(t) => [primaryKey({ columns: [t.id, t.revision] })],
);

export const agentPersonalRuntimeBindings = platformSchema.table(
	"agent_personal_runtime_bindings",
	{
		agentId: text("agent_id")
			.primaryKey()
			.references(() => agents.id),
		revision: integer("revision").notNull(),
		ownerId: text("owner_id"),
		serviceId: text("service_id"),
		target: jsonb("target"),
	},
	(t) => [
		foreignKey({
			name: "personal_runtime_service_fk",
			columns: [t.serviceId],
			foreignColumns: [externalServices.id],
		}),
		check("personal_runtime_binding_version", sql`${t.revision} > 0`),
		check(
			"personal_runtime_binding_target",
			sql`num_nonnulls(${t.ownerId}, ${t.serviceId}, ${t.target}) in (0,3)`,
		),
	],
);

// Short-lived, read-only provider queries. A claimed row pins the accepted version.
export const externalServiceQueries = platformSchema.table(
	"external_service_queries",
	{
		operationId: text("operation_id").primaryKey(),
		actorId: text("actor_id").notNull(),
		instanceId: text("instance_id").notNull(),
		revision: integer("revision").notNull(),
		action: text("action").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		receipt: jsonb("receipt"),
	},
	(t) => [index("external_service_queries_expiry").on(t.expiresAt)],
);
