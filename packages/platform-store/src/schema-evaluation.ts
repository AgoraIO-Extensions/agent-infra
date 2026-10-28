import {
	bigint,
	index,
	jsonb,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { platformSchema as platform } from "./schema-common.js";

export const evaluationPolicies = platform.table("evaluation_policies", {
	id: text("id").primaryKey(),
	revision: bigint("revision", { mode: "number" }).notNull(),
	digest: text("digest").notNull(),
});
export const evaluationDatasets = platform.table("evaluation_datasets", {
	id: uuid("id").primaryKey(),
	scope: text("scope").notNull(),
	data: jsonb("data").notNull(),
});
export const evaluationVersions = platform.table(
	"evaluation_versions",
	{
		id: uuid("id").primaryKey(),
		datasetId: uuid("dataset_id")
			.notNull()
			.references(() => evaluationDatasets.id),
		status: text("status").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		metadataExpiresAt: timestamp("metadata_expires_at", {
			withTimezone: true,
		}).notNull(),
		data: jsonb("data").notNull(),
	},
	(table) => [
		index("evaluation_versions_expiry").on(table.expiresAt, table.id),
		index("evaluation_versions_dataset").on(table.datasetId, table.id),
	],
);
export const evaluationGrants = platform.table(
	"evaluation_grants",
	{
		id: uuid("id").primaryKey(),
		datasetId: uuid("dataset_id")
			.notNull()
			.references(() => evaluationDatasets.id),
		data: jsonb("data").notNull(),
	},
	(table) => [index("evaluation_grants_dataset").on(table.datasetId, table.id)],
);
