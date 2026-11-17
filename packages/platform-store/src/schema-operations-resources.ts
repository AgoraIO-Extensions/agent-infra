import { index, jsonb, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { platformSchema } from "./schema-common";

export const operationsResourceSnapshots = platformSchema.table(
	"operations_resource_snapshots",
	{
		clusterId: text("cluster_id").notNull(),
		namespace: text("namespace").notNull(),
		observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
		snapshot: jsonb("snapshot").notNull(),
	},
	(table) => [primaryKey({ columns: [table.clusterId, table.namespace] })],
);

export const operationsResourceIdentities = platformSchema.table(
	"operations_resource_identities",
	{
		clusterId: text("cluster_id").notNull(),
		namespace: text("namespace").notNull(),
		uid: text("uid").notNull(),
		kind: text("kind").notNull(),
		name: text("name").notNull(),
		agentId: text("agent_id"),
		sessionId: text("session_id"),
		firstSeen: timestamp("first_seen", { withTimezone: true }).notNull(),
		lastSeen: timestamp("last_seen", { withTimezone: true }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.clusterId, table.namespace, table.uid] }),
		index("operations_identity_agent_idx").on(
			table.clusterId,
			table.namespace,
			table.agentId,
			table.lastSeen,
		),
	],
);
