import { boolean, integer, jsonb, primaryKey, text } from "drizzle-orm/pg-core";
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
