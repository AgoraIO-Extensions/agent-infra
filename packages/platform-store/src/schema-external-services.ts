import {
	boolean,
	index,
	integer,
	jsonb,
	primaryKey,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
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
	},
	(t) => [primaryKey({ columns: [t.id, t.revision] })],
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
